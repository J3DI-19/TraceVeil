from __future__ import annotations

from datetime import datetime
from uuid import UUID

import networkx as nx

from app.analysis.config import AnalysisConfig
from app.analysis.detection import DetectionCandidate
from app.analysis.helpers import stable_uuid, unique_sorted_uuids
from app.analysis.schemas import (
    Alert,
    CorrelationEdge,
    CorrelationReason,
    DetectionFinding,
    INCIDENT_ALERT_REFERENCE_LIMIT,
    INCIDENT_CORRELATION_EDGE_REFERENCE_LIMIT,
    INCIDENT_FINDING_REFERENCE_LIMIT,
    Incident,
    Severity,
)
from app.normalization.schemas import CanonicalEntity, CanonicalEvent


def correlate(
    events: list[CanonicalEvent], config: AnalysisConfig
) -> list[CorrelationEdge]:
    timed = sorted(
        (event for event in events if event.observed_at is not None),
        key=lambda event: (event.observed_at, str(event.event_id)),
    )
    edges: list[CorrelationEdge] = []
    for left_index, left in enumerate(timed):
        for right in timed[left_index + 1 :]:
            difference = (right.observed_at - left.observed_at).total_seconds()
            if difference > config.correlation_window_seconds:
                break
            reasons = _correlation_reasons(left, right)
            if not reasons:
                continue
            edges.append(
                CorrelationEdge(
                    edge_id=stable_uuid(
                        "correlation",
                        left.event_id,
                        right.event_id,
                        *(reason.value for reason in reasons),
                        config.correlation_version,
                    ),
                    source_event_id=left.event_id,
                    target_event_id=right.event_id,
                    reasons=reasons,
                    difference_seconds=round(difference, 6),
                    window_seconds=config.correlation_window_seconds,
                    correlation_version=config.correlation_version,
                )
            )
    return sorted(edges, key=lambda edge: str(edge.edge_id))


def build_incidents(
    *,
    case_id: int,
    events: list[CanonicalEvent],
    findings: list[DetectionFinding],
    alerts: list[Alert],
    correlations: list[CorrelationEdge],
    config: AnalysisConfig | None = None,
) -> list[Incident]:
    if not findings:
        return []
    policy = config or AnalysisConfig()
    event_by_id = {event.event_id: event for event in events}
    graph = nx.Graph()
    relevant_ids = {event_id for finding in findings for event_id in finding.event_ids}
    graph.add_nodes_from(relevant_ids)
    for edge in correlations:
        if edge.source_event_id in relevant_ids and edge.target_event_id in relevant_ids:
            graph.add_edge(
                edge.source_event_id,
                edge.target_event_id,
                edge_id=edge.edge_id,
            )
    for finding in findings:
        known_event_ids = [
            event_id for event_id in finding.event_ids if event_id in event_by_id
        ]
        if not known_event_ids:
            continue
        anchor = known_event_ids[0]
        for event_id in known_event_ids[1:]:
            graph.add_edge(anchor, event_id, finding_id=finding.finding_id)

    incidents: list[Incident] = []
    for component in nx.connected_components(graph):
        component_findings = [
            finding
            for finding in findings
            if any(event_id in component for event_id in finding.event_ids)
        ]
        for session_findings in _partition_findings(
            component_findings,
            event_by_id,
            policy,
        ):
            incident = _build_incident(
                case_id=case_id,
                findings=session_findings,
                alerts=alerts,
                correlations=correlations,
                event_by_id=event_by_id,
                config=policy,
            )
            if incident is not None:
                incidents.append(incident)
    return sorted(
        incidents,
        key=lambda incident: (
            incident.started_at is None,
            incident.started_at or incident.ended_at,
            str(incident.incident_id),
        ),
    )


def _partition_findings(
    findings: list[DetectionFinding],
    event_by_id: dict[UUID, CanonicalEvent],
    config: AnalysisConfig,
) -> list[list[DetectionFinding]]:
    timed: list[tuple[datetime, DetectionFinding]] = []
    untimed: list[DetectionFinding] = []
    for finding in findings:
        anchor = _finding_anchor_time(finding, event_by_id)
        if anchor is None:
            untimed.append(finding)
        else:
            timed.append((anchor, finding))
    timed.sort(key=lambda item: (item[0], str(item[1].finding_id)))
    untimed.sort(key=lambda finding: str(finding.finding_id))

    sessions: list[list[DetectionFinding]] = []
    current: list[DetectionFinding] = []
    session_start = None
    previous_time = None
    current_event_ids: set = set()
    for anchor, finding in timed:
        finding_event_ids = set(finding.event_ids)
        starts_new = bool(
            current
            and (
                (anchor - previous_time).total_seconds()
                > config.correlation_window_seconds
                or (anchor - session_start).total_seconds()
                > config.incident_max_trigger_span_seconds
                or len(current_event_ids | finding_event_ids) > 4096
            )
        )
        if starts_new:
            sessions.append(current)
            current = []
            current_event_ids = set()
            session_start = None
        if not current:
            session_start = anchor
        current.append(finding)
        current_event_ids.update(finding_event_ids)
        previous_time = anchor
    if current:
        sessions.append(current)

    current = []
    current_event_ids = set()
    for finding in untimed:
        finding_event_ids = set(finding.event_ids)
        if current and len(current_event_ids | finding_event_ids) > 4096:
            sessions.append(current)
            current = []
            current_event_ids = set()
        current.append(finding)
        current_event_ids.update(finding_event_ids)
    if current:
        sessions.append(current)
    return sessions


def _finding_anchor_time(
    finding: DetectionFinding,
    event_by_id: dict[UUID, CanonicalEvent],
) -> datetime | None:
    trigger_times = [
        event_by_id[event_id].observed_at
        for event_id in finding.trigger_event_ids
        if event_id in event_by_id and event_by_id[event_id].observed_at is not None
    ]
    if trigger_times:
        return max(trigger_times)
    support_times = [
        event_by_id[event_id].observed_at
        for event_id in finding.event_ids
        if event_id in event_by_id and event_by_id[event_id].observed_at is not None
    ]
    return max(support_times) if support_times else None


def _plural(count: int, singular: str, plural: str | None = None) -> str:
    return f"{count} {singular if count == 1 else (plural or singular + 's')}"


def _incident_summary(
    *,
    finding_count: int,
    alert_count: int,
    entity_count: int,
    evidence_count: int,
    maximum_risk: int,
    severity: Severity | None,
    started_at: datetime | None,
    ended_at: datetime | None,
) -> str:
    """Builds the deterministic incident summary (Step 11).

    Assembled only from values the deterministic engine already computed,
    so the same events always yield the same sentence. No model output is
    involved, and the sentence is produced before any AI narration.
    """
    parts = [
        _plural(finding_count, "finding"),
        _plural(alert_count, "alert"),
        _plural(entity_count, "entity", "entities"),
        _plural(evidence_count, "evidence record"),
    ]
    sentence = (
        f"Highest severity {severity.value if severity else 'unknown'}; "
        f"maximum risk {maximum_risk}/100 across " + ", ".join(parts) + "."
    )
    if started_at and ended_at:
        window = (
            f" Observed window {started_at.isoformat()} to {ended_at.isoformat()} UTC."
            if started_at != ended_at
            else f" Observed at {started_at.isoformat()} UTC."
        )
        sentence += window
    else:
        sentence += " No observed time is available for this incident."
    return sentence[:1024]


def _build_incident(
    *,
    case_id: int,
    findings: list[DetectionFinding],
    alerts: list[Alert],
    correlations: list[CorrelationEdge],
    event_by_id: dict[UUID, CanonicalEvent],
    config: AnalysisConfig,
) -> Incident | None:
    component_ids = unique_sorted_uuids(
        event_id
        for finding in findings
        for event_id in finding.event_ids
        if event_id in event_by_id
    )
    if not component_ids:
        return None
    component_id_set = set(component_ids)
    all_finding_ids = unique_sorted_uuids(
        finding.finding_id for finding in findings
    )
    finding_id_set = set(all_finding_ids)
    retained_finding_ids = all_finding_ids[:INCIDENT_FINDING_REFERENCE_LIMIT]
    component_alerts = [
        alert for alert in alerts if alert.finding_id in finding_id_set
    ]
    all_alert_ids = unique_sorted_uuids(alert.alert_id for alert in component_alerts)
    retained_alert_ids = all_alert_ids[:INCIDENT_ALERT_REFERENCE_LIMIT]
    component_edges = [
        edge
        for edge in correlations
        if edge.source_event_id in component_id_set
        and edge.target_event_id in component_id_set
    ]
    component_edge_ids = [
        edge.edge_id
        for edge in sorted(
            component_edges,
            key=lambda edge: (
                edge.difference_seconds,
                str(edge.source_event_id),
                str(edge.target_event_id),
                str(edge.edge_id),
            ),
        )
    ]
    retained_edge_ids = component_edge_ids[
        :INCIDENT_CORRELATION_EDGE_REFERENCE_LIMIT
    ]
    observed = [
        event_by_id[event_id].observed_at
        for event_id in component_ids
        if event_by_id[event_id].observed_at is not None
    ]
    severity_order = {
        Severity.LOW: 1,
        Severity.MEDIUM: 2,
        Severity.HIGH: 3,
        Severity.CRITICAL: 4,
    }
    severity_counts = {
        severity: sum(finding.severity == severity for finding in findings)
        for severity in Severity
        if any(finding.severity == severity for finding in findings)
    }
    entities = {
        (entity.kind.value, entity.id)
        for event_id in component_ids
        for entity in (
            event_by_id[event_id].device,
            event_by_id[event_id].actor,
            event_by_id[event_id].target,
        )
        if entity is not None
    }
    evidence_total = len(
        {
            evidence_id
            for finding in findings
            for evidence_id in finding.evidence_ids
        }
    )
    incident_severity = max(
        (finding.severity for finding in findings), key=severity_order.get
    )
    summary = _incident_summary(
        finding_count=len(all_finding_ids),
        alert_count=len(all_alert_ids),
        entity_count=len(entities),
        evidence_count=evidence_total,
        maximum_risk=max(finding.risk.score for finding in findings),
        severity=incident_severity,
        started_at=min(observed) if observed else None,
        ended_at=max(observed) if observed else None,
    )
    return Incident(
        summary=summary,
        incident_id=stable_uuid(
            "incident", case_id, *(str(event_id) for event_id in component_ids)
        ),
        case_id=case_id,
        event_ids=component_ids,
        finding_ids=retained_finding_ids,
        finding_count=len(all_finding_ids),
        finding_ids_truncated=len(all_finding_ids) > len(retained_finding_ids),
        alert_ids=retained_alert_ids,
        alert_count=len(all_alert_ids),
        alert_ids_truncated=len(all_alert_ids) > len(retained_alert_ids),
        correlation_edge_ids=retained_edge_ids,
        correlation_edge_count=len(component_edge_ids),
        correlation_edges_truncated=(
            len(component_edge_ids) > len(retained_edge_ids)
        ),
        started_at=min(observed) if observed else None,
        ended_at=max(observed) if observed else None,
        maximum_risk=max(finding.risk.score for finding in findings),
        severity=max(
            (finding.severity for finding in findings), key=severity_order.get
        ),
        severity_counts=severity_counts,
        evidence_count=len(
            {
                evidence_id
                for finding in findings
                for evidence_id in finding.evidence_ids
            }
        ),
        entity_count=len(entities),
        entity_ids=sorted({entity_id for _, entity_id in entities})[:1024],
        tags=sorted(
            {
                tag
                for finding in findings
                if finding.classification
                for tag in finding.classification.tags
            }
        ),
        grouping_policy="finding_centered_bounded_session",
        inactivity_window_seconds=config.correlation_window_seconds,
        maximum_trigger_span_seconds=config.incident_max_trigger_span_seconds,
    )


def corroboration_score(
    candidate: DetectionCandidate, correlations: list[CorrelationEdge]
) -> tuple[int, str]:
    event_ids = set(candidate.event_ids)
    touching = [
        edge
        for edge in correlations
        if edge.source_event_id in event_ids or edge.target_event_id in event_ids
    ]
    external = [
        edge
        for edge in touching
        if not ({edge.source_event_id, edge.target_event_id} <= event_ids)
    ]
    if external:
        return 100, f"{len(external)} correlation link(s) connect supporting and external events"
    if touching:
        return 75, f"{len(touching)} deterministic link(s) connect supporting events"
    if len(candidate.evidence_ids) > 1:
        return 50, "Supporting events span multiple evidence objects without a correlation edge"
    return 0, "No corroborating correlation link was present"


def _correlation_reasons(
    left: CanonicalEvent, right: CanonicalEvent
) -> list[CorrelationReason]:
    reasons: set[CorrelationReason] = set()
    if _same_entity(left.device, right.device):
        reasons.add(CorrelationReason.SHARED_DEVICE)
    if _same_entity(left.actor, right.actor):
        reasons.add(CorrelationReason.SHARED_ACTOR)
    if _same_entity(left.target, right.target):
        reasons.add(CorrelationReason.SHARED_TARGET)
    left_addresses = _network_addresses(left)
    right_addresses = _network_addresses(right)
    if left_addresses & right_addresses:
        reasons.add(CorrelationReason.SHARED_NETWORK_ADDRESS)
    left_service = left.attributes.get("service")
    right_service = right.attributes.get("service")
    if isinstance(left_service, str) and left_service and left_service == right_service:
        reasons.add(CorrelationReason.SHARED_SERVICE)
    return sorted(reasons, key=lambda reason: reason.value)


def _same_entity(
    left: CanonicalEntity | None, right: CanonicalEntity | None
) -> bool:
    return (
        left is not None
        and right is not None
        and left.kind == right.kind
        and left.id == right.id
    )


def _network_addresses(event: CanonicalEvent) -> set[str]:
    addresses: set[str] = set()
    for entity in (event.device, event.actor, event.target):
        if entity is not None and entity.ip is not None:
            addresses.add(str(entity.ip))
    if event.network is not None:
        if event.network.source_ip is not None:
            addresses.add(str(event.network.source_ip))
        if event.network.destination_ip is not None:
            addresses.add(str(event.network.destination_ip))
    return addresses
