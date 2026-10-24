from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from statistics import fmean, median, pstdev
from uuid import UUID

from app.analysis.config import AnalysisConfig
from app.analysis.classification import dataset_classification, rule_classification
from app.analysis.helpers import primary_entity_id, stable_uuid, unique_sorted_uuids
from app.analysis.schemas import BaselineSummary, ConditionTrace, FindingClassification, Severity
from app.normalization.schemas import CanonicalEvent, CanonicalSourceType, EventOrigin


@dataclass(frozen=True)
class DetectionCandidate:
    rule_id: str
    title: str
    summary: str
    severity: Severity
    confidence: int
    event_ids: tuple[UUID, ...]
    trigger_event_ids: tuple[UUID, ...]
    evidence_ids: tuple[UUID, ...]
    condition_trace: tuple[ConditionTrace, ...]
    entity_id: str | None
    repetition_count: int
    repetition_reference: int
    live_detected: bool
    classification: FindingClassification
    evidence_confidence: int
    risk_penalties: tuple[tuple[str, int, str], ...]


def detect(
    events: list[CanonicalEvent], config: AnalysisConfig
) -> tuple[list[DetectionCandidate], list[BaselineSummary]]:
    by_id = {event.event_id: event for event in events}
    candidates = [
        *_detect_malicious_labels(events, config),
        *_detect_request_rate(events, config),
        *_detect_authentication_failures(events, config),
        *_detect_network_behaviors(events, config),
    ]
    baseline_candidates, baselines = _detect_baseline_spikes(events, config)
    candidates.extend(baseline_candidates)
    candidates.extend(_detect_telemetry_rate_change(events, config))
    candidates.sort(
        key=lambda candidate: (
            candidate.rule_id,
            tuple(str(value) for value in candidate.event_ids),
        )
    )
    for candidate in candidates:
        if any(event_id not in by_id for event_id in candidate.event_ids):
            raise ValueError("detection candidate references an unknown event")
    return candidates, baselines


def _candidate(
    *,
    rule_id: str,
    title: str,
    summary: str,
    severity: Severity,
    confidence: int,
    events: list[CanonicalEvent],
    trigger_events: list[CanonicalEvent] | None = None,
    trace: list[ConditionTrace],
    entity_id: str | None,
    repetition_reference: int,
    repetition_count: int = 1,
    classification: FindingClassification,
    evidence_confidence: int = 100,
    risk_penalties: tuple[tuple[str, int, str], ...] = (),
) -> DetectionCandidate:
    ordered = sorted(events, key=lambda event: str(event.event_id))
    triggers = sorted(trigger_events or events, key=lambda event: str(event.event_id))
    if not {event.event_id for event in triggers} <= {event.event_id for event in ordered}:
        raise ValueError("trigger events must be included in supporting events")
    quality_penalties = list(risk_penalties)
    if entity_id is None or entity_id == "unknown-entity":
        quality_penalties.append(("unknown_identity", 5, "No trusted primary entity identity was available"))
    if any(event.observed_at is None for event in triggers):
        quality_penalties.append(("missing_observed_time", 5, "A triggering event has no observed timestamp"))
    return DetectionCandidate(
        rule_id=rule_id,
        title=title,
        summary=summary,
        severity=severity,
        confidence=confidence,
        event_ids=tuple(event.event_id for event in ordered),
        trigger_event_ids=tuple(event.event_id for event in triggers),
        evidence_ids=tuple(
            unique_sorted_uuids(event.provenance.evidence_id for event in ordered)
        ),
        condition_trace=tuple(trace),
        entity_id=entity_id,
        repetition_count=repetition_count,
        repetition_reference=repetition_reference,
        live_detected=any(event.provenance.origin == EventOrigin.LIVE for event in triggers),
        classification=classification,
        evidence_confidence=evidence_confidence,
        risk_penalties=tuple(quality_penalties),
    )


def _detect_malicious_labels(
    events: list[CanonicalEvent], config: AnalysisConfig
) -> list[DetectionCandidate]:
    labels = {label.casefold() for label in config.malicious_labels}
    benign_labels = {label.casefold() for label in config.dataset_benign_labels}
    matched_events: dict[tuple[str, str, str, str], list[tuple[CanonicalEvent, str, str]]] = {}
    for event in events:
        label = (event.source_label or "").strip().casefold()
        if event.provenance.source_type in {
            CanonicalSourceType.TON_IOT_NETWORK,
            CanonicalSourceType.TON_IOT_FRIDGE_TELEMETRY,
        }:
            matched = label == "1"
            expected = "TON_IoT binary label equals 1"
        elif event.provenance.source_type == CanonicalSourceType.CICIOT2023_NETWORK:
            matched = bool(label) and label not in benign_labels
            expected = "CICIoT2023 label is not in the configured benign-label set"
        else:
            matched = label in labels
            expected = "Source label is in the configured malicious-label set"
        if not matched:
            continue
        attack_class = _attack_class(event)
        entity_id = primary_entity_id(event) or "unknown-entity"
        evidence_id = str(event.provenance.evidence_id)
        key = (event.provenance.source_type.value, evidence_id, entity_id, attack_class)
        matched_events.setdefault(key, []).append((event, expected, label))

    findings: list[DetectionCandidate] = []
    for (_, _, entity_id, attack_class), matches in sorted(matched_events.items()):
        for session in _sessionize_label_matches(matches, config):
            grouped = [event for event, _, _ in session]
            representative = grouped[0]
            attack_class_field = _attack_class_field(representative)
            expected = session[0][1]
            actual_labels = sorted({actual for _, _, actual in session})
            classification, severity = dataset_classification(attack_class)
            classification = classification.model_copy(
                update={"source_field": attack_class_field}
            )
            findings.append(
                _candidate(
                    rule_id="LABEL-001",
                    title=f"Dataset-labelled {classification.display_name} activity",
                    summary=(
                        f"{len(grouped)} source records for {entity_id} were grouped by the "
                        f"persisted attack class {attack_class!r} inside a bounded temporal "
                        "session and matched the versioned malicious-label rule."
                    ),
                    severity=severity,
                    confidence=95,
                    events=grouped,
                    trace=[
                        ConditionTrace(
                            condition=expected,
                            field="source_label",
                            operator="in",
                            expected=(
                                ",".join(sorted(benign_labels))
                                if representative.provenance.source_type
                                == CanonicalSourceType.CICIOT2023_NETWORK
                                else "1"
                                if representative.provenance.source_type
                                in {
                                    CanonicalSourceType.TON_IOT_NETWORK,
                                    CanonicalSourceType.TON_IOT_FRIDGE_TELEMETRY,
                                }
                                else ",".join(sorted(labels))
                            ),
                            actual=",".join(actual_labels),
                            matched=True,
                        ),
                        ConditionTrace(
                            condition="Records share a normalized source attack class",
                            field=attack_class_field,
                            operator="equals",
                            expected=attack_class,
                            actual=attack_class,
                            matched=True,
                        ),
                        ConditionTrace(
                            condition="Dataset-labelled records stay inside a bounded session",
                            field="observed_at",
                            operator="sessionized",
                            expected=(
                                f"gap<={config.correlation_window_seconds}s; "
                                f"trigger span<={config.incident_max_trigger_span_seconds}s; "
                                f"records<={config.dataset_label_max_events_per_finding}"
                            ),
                            actual=str(len(grouped)),
                            matched=True,
                        ),
                    ],
                    entity_id=None if entity_id == "unknown-entity" else entity_id,
                    repetition_reference=config.label_repetition_reference,
                    classification=classification,
                    evidence_confidence=90,
                    risk_penalties=(("generic_unverified_label", 10, "The source attack class is not in the versioned taxonomy"),) if classification.category == "unknown" else (),
                    repetition_count=len(grouped),
                )
            )
    return findings


def _sessionize_label_matches(
    matches: list[tuple[CanonicalEvent, str, str]],
    config: AnalysisConfig,
) -> list[list[tuple[CanonicalEvent, str, str]]]:
    """Prevent a source label from turning an entire evidence file into one finding."""
    timed = sorted(
        (match for match in matches if match[0].observed_at is not None),
        key=lambda match: (match[0].observed_at, str(match[0].event_id)),
    )
    untimed = sorted(
        (match for match in matches if match[0].observed_at is None),
        key=lambda match: str(match[0].event_id),
    )
    sessions: list[list[tuple[CanonicalEvent, str, str]]] = []
    current: list[tuple[CanonicalEvent, str, str]] = []
    session_start: datetime | None = None
    previous_time: datetime | None = None
    for match in timed:
        observed_at = match[0].observed_at
        assert observed_at is not None
        starts_new = bool(
            current
            and (
                observed_at - previous_time
                > timedelta(seconds=config.correlation_window_seconds)
                or observed_at - session_start
                > timedelta(seconds=config.incident_max_trigger_span_seconds)
                or len(current) >= config.dataset_label_max_events_per_finding
            )
        )
        if starts_new:
            sessions.append(current)
            current = []
            session_start = None
        if not current:
            session_start = observed_at
        current.append(match)
        previous_time = observed_at
    if current:
        sessions.append(current)
    for index in range(0, len(untimed), config.dataset_label_max_events_per_finding):
        sessions.append(untimed[index : index + config.dataset_label_max_events_per_finding])
    return sessions


def _attack_class(event: CanonicalEvent) -> str:
    """Return the most specific persisted source classification available."""
    for value in (
        event.attributes.get("attack_type"),
        event.source_event_type,
        event.source_label,
    ):
        if isinstance(value, str) and value.strip():
            return value.strip().casefold().replace("_", " ")
    return "malicious"


def _attack_class_field(event: CanonicalEvent) -> str:
    if event.attributes.get("attack_type") not in (None, ""):
        return "attributes.attack_type"
    if event.source_event_type not in (None, ""):
        return "source_event_type"
    return "source_label"


def _detect_request_rate(
    events: list[CanonicalEvent], config: AnalysisConfig
) -> list[DetectionCandidate]:
    findings: list[DetectionCandidate] = []
    for event in events:
        request_count = _numeric(event.attributes.get("requests"))
        baseline = _numeric(event.attributes.get("baseline"))
        if request_count is None or baseline is None or baseline <= 0:
            continue
        threshold = baseline * config.request_rate_multiplier
        if request_count < threshold:
            continue
        findings.append(
            _candidate(
                rule_id="RATE-001",
                title="Request rate exceeds the declared baseline",
                summary=(
                    f"Observed request count {request_count:g} met the deterministic "
                    f"threshold {threshold:g}."
                ),
                severity=Severity.HIGH,
                confidence=90,
                events=[event],
                trace=[
                    ConditionTrace(
                        condition="Requests meet or exceed baseline multiplier",
                        field="attributes.requests",
                        operator=">=",
                        expected=f"{threshold:g}",
                        actual=f"{request_count:g}",
                        matched=True,
                    )
                ],
                entity_id=primary_entity_id(event),
                repetition_reference=config.request_rate_repetition_reference,
                classification=rule_classification("RATE-001", f"requests={request_count:g}; threshold={threshold:g}"),
            )
        )
    return findings


def _detect_authentication_failures(
    events: list[CanonicalEvent], config: AnalysisConfig
) -> list[DetectionCandidate]:
    groups: dict[tuple[str, str, str, str], list[CanonicalEvent]] = {}
    for event in events:
        if event.observed_at is None or not _is_authentication_failure(event):
            continue
        entity = event.device or event.target
        actor = event.actor
        if entity is None or actor is None:
            continue
        groups.setdefault(
            (entity.kind.value, entity.id, actor.kind.value, actor.id), []
        ).append(event)

    findings: list[DetectionCandidate] = []
    window = timedelta(seconds=config.authentication_window_seconds)
    for (_, entity_id, _, actor_id), group in sorted(groups.items()):
        group.sort(key=lambda event: (event.observed_at, str(event.event_id)))
        active: list[CanonicalEvent] = []
        last_trigger = None
        for event in group:
            active = [
                candidate
                for candidate in active
                if event.observed_at - candidate.observed_at <= window
            ]
            active.append(event)
            if len(active) < config.authentication_failure_threshold:
                continue
            if last_trigger is not None and event.observed_at - last_trigger <= window:
                continue
            contributing = active[-config.authentication_failure_threshold :]
            span = (contributing[-1].observed_at - contributing[0].observed_at).total_seconds()
            simulated = all(event.provenance.source_id == "traceveil-simulator"
                            and event.attributes.get("simulated") is True for event in contributing)
            findings.append(
                _candidate(
                    rule_id="AUTH-001",
                    title=(f"[SIMULATED] Authentication failure test · {entity_id}"
                           if simulated else "Repeated authentication failures"),
                    summary=(
                        f"{len(contributing)} authentication failures for {entity_id} from "
                        f"{actor_id} occurred within {span:g} seconds."
                    ),
                    severity=Severity.CRITICAL,
                    confidence=98,
                    events=contributing,
                    trigger_events=[event],
                    trace=[
                        ConditionTrace(
                            condition="Authentication failure count reaches threshold",
                            field="event_count",
                            operator=">=",
                            expected=str(config.authentication_failure_threshold),
                            actual=str(len(contributing)),
                            matched=True,
                        ),
                        ConditionTrace(
                            condition="Failures occur inside the configured time window",
                            field="observed_at",
                            operator="span<=",
                            expected=str(config.authentication_window_seconds),
                            actual=f"{span:g}",
                            matched=True,
                        ),
                        ConditionTrace(
                            condition="Actor identity is stable across contributing events",
                            field="actor.id",
                            operator="equals",
                            expected=actor_id,
                            actual=actor_id,
                            matched=True,
                        ),
                    ],
                    entity_id=entity_id,
                    repetition_count=len(contributing),
                    repetition_reference=config.authentication_failure_threshold,
                    classification=rule_classification("AUTH-001", f"{len(contributing)} failures in {span:g} seconds"),
                )
            )
            last_trigger = event.observed_at
    return findings


def _detect_baseline_spikes(
    events: list[CanonicalEvent], config: AnalysisConfig
) -> tuple[list[DetectionCandidate], list[BaselineSummary]]:
    streams: dict[tuple[str, str], list[tuple[CanonicalEvent, float]]] = {}
    for event in events:
        if event.observed_at is None or event.event_type != "telemetry":
            continue
        entity_id = primary_entity_id(event)
        if entity_id is None:
            continue
        for metric, raw_value in event.attributes.items():
            value = _numeric(raw_value)
            if value is not None and metric != "sequence":
                streams.setdefault((entity_id, metric), []).append((event, value))

    findings: list[DetectionCandidate] = []
    baselines: list[BaselineSummary] = []
    for (entity_id, metric), samples in sorted(streams.items()):
        samples.sort(key=lambda item: (item[0].observed_at, str(item[0].event_id)))
        for index in range(config.baseline_min_samples, len(samples)):
            history = samples[max(0, index - config.baseline_max_samples) : index]
            current_event, current_value = samples[index]
            values = [value for _, value in history]
            mean = fmean(values)
            deviation = pstdev(values)
            threshold = mean + max(
                config.baseline_minimum_delta,
                config.baseline_sigma * deviation,
            )
            sample_ids = [event.event_id for event, _ in history]
            baseline = BaselineSummary(
                baseline_id=stable_uuid(
                    "baseline", entity_id, metric, *(str(value) for value in sample_ids), current_event.event_id
                ),
                entity_id=entity_id,
                metric=metric,
                sample_event_ids=sample_ids,
                sample_count=len(history),
                mean=round(mean, 6),
                population_stddev=round(deviation, 6),
                threshold=round(threshold, 6),
                evaluated_event_id=current_event.event_id,
                window_start=history[0][0].observed_at,
                window_end=history[-1][0].observed_at,
            )
            baselines.append(baseline)
            if current_value <= threshold:
                continue
            supporting = [event for event, _ in history] + [current_event]
            findings.append(
                _candidate(
                    rule_id="BASELINE-001",
                    title="Telemetry metric exceeds its behavioural baseline",
                    summary=(
                        f"{metric} value {current_value:g} for {entity_id} exceeded the "
                        f"deterministic baseline threshold {threshold:g}."
                    ),
                    severity=Severity.HIGH,
                    confidence=80,
                    events=supporting,
                    trigger_events=[current_event],
                    trace=[
                        ConditionTrace(
                            condition="A minimum baseline sample is available",
                            field="baseline.sample_count",
                            operator=">=",
                            expected=str(config.baseline_min_samples),
                            actual=str(len(history)),
                            matched=True,
                        ),
                        ConditionTrace(
                            condition="Current metric exceeds mean plus configured deviation",
                            field=f"attributes.{metric}",
                            operator=">",
                            expected=f"{threshold:g}",
                            actual=f"{current_value:g}",
                            matched=True,
                        ),
                    ],
                    entity_id=entity_id,
                    repetition_count=1,
                    repetition_reference=config.baseline_repetition_reference,
                    classification=rule_classification("BASELINE-001", f"{metric}={current_value:g}; threshold={threshold:g}"),
                )
            )
    baselines.sort(key=lambda baseline: str(baseline.baseline_id))
    return findings, baselines


def _detect_telemetry_rate_change(
    events: list[CanonicalEvent], config: AnalysisConfig
) -> list[DetectionCandidate]:
    streams: dict[tuple[str, str], list[tuple[CanonicalEvent, float]]] = {}
    for event in events:
        if event.observed_at is None or event.event_type != "telemetry":
            continue
        entity_id = primary_entity_id(event)
        if entity_id is None:
            continue
        for metric, raw_value in event.attributes.items():
            value = _numeric(raw_value)
            if value is not None and metric != "sequence":
                streams.setdefault((entity_id, metric), []).append((event, value))
    findings: list[DetectionCandidate] = []
    for (entity_id, metric), samples in sorted(streams.items()):
        samples.sort(key=lambda item: (item[0].observed_at, str(item[0].event_id)))
        deltas: list[float] = []
        last_trigger_index = -2
        for index in range(1, len(samples)):
            previous_event, previous_value = samples[index - 1]
            current_event, current_value = samples[index]
            delta = abs(current_value - previous_value)
            if len(deltas) >= config.baseline_min_samples:
                history = deltas[-config.baseline_max_samples :]
                typical = median(history)
                threshold = max(config.baseline_minimum_delta, typical * config.telemetry_rate_change_multiplier)
                if delta > threshold and index > last_trigger_index + 1:
                    findings.append(_candidate(
                        rule_id="TELEMETRY-ROC-001",
                        title="Telemetry metric changed unusually quickly",
                        summary=f"{metric} for {entity_id} changed by {delta:g}, above the prior-change threshold {threshold:g}.",
                        severity=Severity.HIGH,
                        confidence=82,
                        events=[previous_event, current_event],
                        trigger_events=[current_event],
                        trace=[
                            ConditionTrace(condition="Prior metric changes establish a baseline", field="baseline.delta_sample_count", operator=">=", expected=str(config.baseline_min_samples), actual=str(len(history)), matched=True),
                            ConditionTrace(condition="Absolute change exceeds the rolling change threshold", field=f"attributes.{metric}", operator="absolute_delta>", expected=f"{threshold:g}", actual=f"{delta:g}", matched=True),
                        ],
                        entity_id=entity_id,
                        repetition_reference=config.baseline_repetition_reference,
                        classification=rule_classification("TELEMETRY-ROC-001", f"{metric} delta={delta:g}; threshold={threshold:g}"),
                        evidence_confidence=min(100, 55 + len(history) * 2),
                        risk_penalties=(("limited_baseline", 5, "Rate-of-change baseline contains fewer than ten prior changes"),) if len(history) < 10 else (),
                    ))
                    last_trigger_index = index
            deltas.append(delta)
    return findings


def _detect_network_behaviors(
    events: list[CanonicalEvent], config: AnalysisConfig
) -> list[DetectionCandidate]:
    network_events = sorted(
        (event for event in events if event.event_type == "network_flow" and event.observed_at is not None and event.network is not None),
        key=lambda event: (event.observed_at, str(event.event_id)),
    )
    groups: dict[str, list[CanonicalEvent]] = {}
    for event in network_events:
        source = str(event.network.source_ip) if event.network and event.network.source_ip else None
        if source:
            groups.setdefault(source, []).append(event)
    findings: list[DetectionCandidate] = []
    window = timedelta(seconds=config.network_window_seconds)
    failure_states = {"s0", "rej", "rsto", "rstr", "sh", "shr", "failed", "failure"}
    for source, group in sorted(groups.items()):
        active: list[CanonicalEvent] = []
        last_trigger: dict[str, datetime] = {}
        for event in group:
            active = [candidate for candidate in active if event.observed_at - candidate.observed_at <= window]
            active.append(event)
            destinations = {str(candidate.network.destination_ip) for candidate in active if candidate.network and candidate.network.destination_ip}
            ports = {(str(candidate.network.destination_ip), candidate.network.destination_port) for candidate in active if candidate.network and candidate.network.destination_ip and candidate.network.destination_port is not None}
            failures = [candidate for candidate in active if (candidate.outcome or "").casefold() in failure_states]
            checks = [
                ("NET-FANOUT-001", len(destinations), config.network_fanout_threshold, "distinct destinations", "Unusual network destination fan-out", Severity.HIGH),
                ("NET-PORTSCAN-001", len(ports), config.network_port_scan_threshold, "destination and port combinations", "Unusual destination-port fan-out", Severity.HIGH),
                ("NET-FAILURE-001", len(failures), config.network_failure_threshold, "failed or incomplete connections", "Burst of failed or incomplete connections", Severity.HIGH),
            ]
            for rule_id, actual, threshold, unit, title, severity in checks:
                previous = last_trigger.get(rule_id)
                if actual < threshold or (previous is not None and event.observed_at - previous <= window):
                    continue
                supporting = (failures if rule_id == "NET-FAILURE-001" else list(active))[-512:]
                device_id = primary_entity_id(event)
                findings.append(_candidate(
                    rule_id=rule_id,
                    title=title,
                    summary=f"Source {source} produced {actual} {unit} within {config.network_window_seconds} seconds.",
                    severity=severity,
                    confidence={"NET-FANOUT-001": 85, "NET-PORTSCAN-001": 88, "NET-FAILURE-001": 90}[rule_id],
                    events=supporting,
                    trigger_events=[event],
                    trace=[
                        ConditionTrace(condition=f"Network behavior reaches the configured {unit} threshold", field="network.window", operator=">=", expected=str(threshold), actual=str(actual), matched=True),
                        ConditionTrace(condition="Source network identity is stable", field="network.source_ip", operator="equals", expected=source, actual=source, matched=True),
                        ConditionTrace(condition="Capture owner device identity is preserved", field="device.id", operator="equals", expected=device_id or "unavailable", actual=device_id or "unavailable", matched=device_id is not None),
                    ],
                    entity_id=device_id,
                    repetition_count=actual,
                    repetition_reference=threshold,
                    classification=rule_classification(rule_id, f"{actual} {unit} in {config.network_window_seconds}s"),
                    evidence_confidence=95 if device_id else 70,
                ))
                last_trigger[rule_id] = event.observed_at
    return findings


def _is_authentication_failure(event: CanonicalEvent) -> bool:
    if event.event_type in {"authentication_failure", "login_failure"}:
        return True
    return event.action == "authenticate" and event.outcome in {
        "denied",
        "failure",
        "failed",
    }


def _numeric(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)
