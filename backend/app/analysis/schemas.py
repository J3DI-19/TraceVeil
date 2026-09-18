from __future__ import annotations

import math
from datetime import datetime, timezone
from enum import Enum
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.analysis.config import AnalysisConfig


ANALYSIS_VERSION = "1.0"
INCIDENT_CORRELATION_EDGE_REFERENCE_LIMIT = 4096
INCIDENT_FINDING_REFERENCE_LIMIT = 1024
INCIDENT_ALERT_REFERENCE_LIMIT = 1024


class Severity(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class RiskBand(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class ClassificationSource(str, Enum):
    DATASET_LABEL = "dataset_label"
    DETERMINISTIC_RULE = "deterministic_rule"
    BEHAVIORAL_ANOMALY = "behavioral_anomaly"
    INVESTIGATOR_ASSIGNED = "investigator_assigned"
    AI_SUGGESTION = "ai_suggestion"


class FindingClassification(BaseModel):
    model_config = ConfigDict(extra="forbid")

    category: str = Field(min_length=1, max_length=128)
    subcategory: str = Field(min_length=1, max_length=128)
    display_name: str = Field(min_length=1, max_length=128)
    source: ClassificationSource
    source_field: str = Field(min_length=1, max_length=128)
    source_value: str = Field(min_length=1, max_length=256)
    confidence: int = Field(ge=0, le=100)
    tags: list[str] = Field(default_factory=list, max_length=16)
    taxonomy_version: Literal["1.0", "1.1"] = "1.1"


class RiskPenalty(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: Literal["unknown_identity", "missing_observed_time", "generic_unverified_label", "limited_baseline"]
    points: int = Field(ge=1, le=100)
    explanation: str = Field(min_length=1, max_length=512)


class SortField(str, Enum):
    OBSERVED_AT = "observed_at"
    INGESTED_AT = "ingested_at"
    EVENT_TYPE = "event_type"
    EVENT_ID = "event_id"


class SortDirection(str, Enum):
    ASCENDING = "asc"
    DESCENDING = "desc"


class EventFilter(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event_types: list[str] = Field(default_factory=list, max_length=64)
    origins: list[Literal["batch", "live"]] = Field(default_factory=list, max_length=2)
    device_ids: list[str] = Field(default_factory=list, max_length=128)
    source_labels: list[str] = Field(default_factory=list, max_length=128)
    observed_from: datetime | None = None
    observed_to: datetime | None = None
    sort_field: SortField = SortField.OBSERVED_AT
    sort_direction: SortDirection = SortDirection.ASCENDING

    @field_validator("event_types", "origins", "device_ids", "source_labels")
    @classmethod
    def canonicalize_filter_values(cls, values: list[str]) -> list[str]:
        if any(not value or len(value) > 256 for value in values):
            raise ValueError("filter values must contain 1 to 256 characters")
        return sorted(set(values))

    @field_validator("observed_from", "observed_to")
    @classmethod
    def normalize_filter_time(cls, value: datetime | None) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("filter timestamps must include a timezone")
        return value.astimezone(timezone.utc)

    @model_validator(mode="after")
    def validate_time_range(self) -> EventFilter:
        if self.observed_from and self.observed_to and self.observed_from > self.observed_to:
            raise ValueError("observed_from must not be after observed_to")
        return self


class ConditionTrace(BaseModel):
    model_config = ConfigDict(extra="forbid")

    condition: str = Field(min_length=1, max_length=256)
    field: str = Field(min_length=1, max_length=128)
    operator: str = Field(min_length=1, max_length=32)
    expected: str = Field(max_length=256)
    actual: str = Field(max_length=256)
    matched: bool


class BaselineSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    baseline_id: UUID
    entity_id: str = Field(min_length=1, max_length=256)
    metric: str = Field(min_length=1, max_length=128)
    sample_event_ids: list[UUID] = Field(min_length=1, max_length=256)
    sample_count: int = Field(ge=1)
    mean: float
    population_stddev: float = Field(ge=0)
    threshold: float
    evaluated_event_id: UUID
    window_start: datetime
    window_end: datetime
    baseline_version: Literal["1.0"] = ANALYSIS_VERSION

    @field_validator("mean", "population_stddev", "threshold")
    @classmethod
    def require_finite_number(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("baseline values must be finite")
        return value

    @field_validator("window_start", "window_end")
    @classmethod
    def require_utc(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("baseline timestamps must include a timezone")
        return value.astimezone(timezone.utc)


class RiskFactor(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Literal[
        "severity",
        "confidence",
        "repetition",
        "device_criticality",
        "corroboration",
    ]
    score: int = Field(ge=0, le=100)
    weight: int = Field(ge=0, le=100)
    weighted_points: int = Field(ge=0, le=100)
    explanation: str = Field(min_length=1, max_length=512)


class RiskScore(BaseModel):
    model_config = ConfigDict(extra="forbid")

    score: int = Field(ge=0, le=100)
    base_score: int | None = Field(default=None, ge=0, le=100)
    band: RiskBand
    factors: list[RiskFactor] = Field(min_length=5, max_length=5)
    penalties: list[RiskPenalty] = Field(default_factory=list, max_length=3)
    scoring_version: Literal["1.0", "1.1"] = "1.1"

    @model_validator(mode="after")
    def validate_factor_total(self) -> RiskScore:
        if sum(factor.weight for factor in self.factors) != 100:
            raise ValueError("risk factor weights must total 100")
        factor_total = sum(factor.weighted_points for factor in self.factors)
        base = self.base_score if self.base_score is not None else self.score
        if factor_total != base:
            raise ValueError("risk factor points must total the base risk score")
        if self.score != max(0, base - sum(item.points for item in self.penalties)):
            raise ValueError("risk penalties must reconcile base and final risk scores")
        return self


class DetectionFinding(BaseModel):
    model_config = ConfigDict(extra="forbid")

    finding_id: UUID
    case_id: int = Field(ge=1)
    rule_id: str = Field(min_length=1, max_length=64)
    rule_version: str = Field(min_length=1, max_length=32)
    title: str = Field(min_length=1, max_length=256)
    summary: str = Field(min_length=1, max_length=1024)
    severity: Severity
    confidence: int = Field(ge=0, le=100)
    evidence_confidence: int = Field(default=100, ge=0, le=100)
    classification_confidence: int = Field(default=100, ge=0, le=100)
    classification: FindingClassification | None = None
    entity_id: str | None = Field(default=None, max_length=256)
    event_ids: list[UUID] = Field(min_length=1, max_length=512)
    trigger_event_ids: list[UUID] = Field(min_length=1, max_length=512)
    evidence_ids: list[UUID] = Field(min_length=1, max_length=512)
    condition_trace: list[ConditionTrace] = Field(min_length=1, max_length=64)
    risk: RiskScore
    live_detected: bool

    @model_validator(mode="after")
    def validate_trigger_events(self) -> DetectionFinding:
        if not set(self.trigger_event_ids) <= set(self.event_ids):
            raise ValueError("trigger events must be included in supporting event IDs")
        return self


class Alert(BaseModel):
    model_config = ConfigDict(extra="forbid")

    alert_id: UUID
    case_id: int = Field(ge=1)
    finding_id: UUID
    rule_id: str
    title: str
    severity: Severity
    risk_score: int = Field(ge=0, le=100)
    event_ids: list[UUID] = Field(min_length=1, max_length=512)
    evidence_ids: list[UUID] = Field(min_length=1, max_length=512)
    triggered_at: datetime
    delivery_status: Literal["pending"] = "pending"
    workflow_status: Literal["pending", "acknowledged", "resolved", "suppressed"] = "pending"
    workflow_actor: str | None = None
    status_updated_at: datetime | None = None
    notification_status: Literal["not_requested", "delivered", "delivery_failed"] = "not_requested"
    notification_error: str | None = None

    @field_validator("triggered_at")
    @classmethod
    def normalize_trigger_time(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("alert timestamps must include a timezone")
        return value.astimezone(timezone.utc)


class CorrelationReason(str, Enum):
    SHARED_DEVICE = "shared_device"
    SHARED_ACTOR = "shared_actor"
    SHARED_TARGET = "shared_target"
    SHARED_NETWORK_ADDRESS = "shared_network_address"
    SHARED_SERVICE = "shared_service"


class CorrelationEdge(BaseModel):
    model_config = ConfigDict(extra="forbid")

    edge_id: UUID
    source_event_id: UUID
    target_event_id: UUID
    reasons: list[CorrelationReason] = Field(min_length=1, max_length=5)
    difference_seconds: float = Field(ge=0)
    window_seconds: int = Field(ge=1)
    correlation_version: Literal["1.0", "1.1"] = "1.0"


class Incident(BaseModel):
    model_config = ConfigDict(extra="forbid")

    incident_id: UUID
    case_id: int = Field(ge=1)
    event_ids: list[UUID] = Field(min_length=1, max_length=4096)
    finding_ids: list[UUID] = Field(
        min_length=1, max_length=INCIDENT_FINDING_REFERENCE_LIMIT
    )
    finding_count: int = Field(default=0, ge=1)
    finding_ids_truncated: bool = False
    alert_ids: list[UUID] = Field(
        default_factory=list, max_length=INCIDENT_ALERT_REFERENCE_LIMIT
    )
    alert_count: int = Field(default=0, ge=0)
    alert_ids_truncated: bool = False
    correlation_edge_ids: list[UUID] = Field(
        default_factory=list,
        max_length=INCIDENT_CORRELATION_EDGE_REFERENCE_LIMIT,
    )
    correlation_edge_count: int = Field(default=0, ge=0)
    correlation_edges_truncated: bool = False
    started_at: datetime | None
    ended_at: datetime | None
    maximum_risk: int = Field(ge=0, le=100)
    severity: Severity | None = None
    severity_counts: dict[Severity, int] = Field(default_factory=dict)
    # Step 11: a deterministic, backend-authored one-line description of the
    # incident, assembled purely from the counts and bounds computed above.
    # It contains no model output and is produced before any AI narration, so
    # a reader always has an authoritative summary that does not depend on
    # Qwen being available - or truthful.
    summary: str = Field(default="", max_length=1024)
    evidence_count: int = Field(default=0, ge=0)
    entity_count: int = Field(default=0, ge=0)
    entity_ids: list[str] = Field(default_factory=list, max_length=1024)
    tags: list[str] = Field(default_factory=list, max_length=64)
    grouping_policy: Literal[
        "transitive_component", "finding_centered_bounded_session"
    ] = "transitive_component"
    inactivity_window_seconds: int | None = Field(default=None, ge=1)
    maximum_trigger_span_seconds: int | None = Field(default=None, ge=1)
    incident_version: Literal["1.0"] = ANALYSIS_VERSION

    @model_validator(mode="before")
    @classmethod
    def populate_bounded_reference_metadata(cls, value: object) -> object:
        if not isinstance(value, dict):
            return value
        data = dict(value)
        finding_ids = data.get("finding_ids") or []
        data.setdefault("finding_count", len(finding_ids))
        data.setdefault("finding_ids_truncated", False)
        alert_ids = data.get("alert_ids") or []
        data.setdefault("alert_count", len(alert_ids))
        data.setdefault("alert_ids_truncated", False)
        edge_ids = data.get("correlation_edge_ids") or []
        data.setdefault("correlation_edge_count", len(edge_ids))
        data.setdefault("correlation_edges_truncated", False)
        return data

    @model_validator(mode="after")
    def validate_bounded_reference_metadata(self) -> Incident:
        self._validate_reference_metadata(
            name="finding",
            total=self.finding_count,
            retained=len(self.finding_ids),
            truncated=self.finding_ids_truncated,
        )
        self._validate_reference_metadata(
            name="alert",
            total=self.alert_count,
            retained=len(self.alert_ids),
            truncated=self.alert_ids_truncated,
        )
        self._validate_reference_metadata(
            name="correlation edge",
            total=self.correlation_edge_count,
            retained=len(self.correlation_edge_ids),
            truncated=self.correlation_edges_truncated,
        )
        return self

    @staticmethod
    def _validate_reference_metadata(
        *, name: str, total: int, retained: int, truncated: bool
    ) -> None:
        if total < retained:
            raise ValueError(
                f"{name}_count cannot be smaller than the retained references"
            )
        if truncated != (total > retained):
            raise ValueError(f"{name} reference truncation metadata is inconsistent")

    @field_validator("started_at", "ended_at")
    @classmethod
    def normalize_incident_time(cls, value: datetime | None) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("incident timestamps must include a timezone")
        return value.astimezone(timezone.utc)


class TimelineEntryType(str, Enum):
    EVENT = "event"
    ALERT = "alert"
    FINDING = "finding"


class TimelineEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    entry_id: str = Field(min_length=1, max_length=256)
    entry_type: TimelineEntryType
    occurred_at: datetime | None
    ingested_at: datetime
    timestamp_basis: Literal["observed", "unavailable"]
    title: str = Field(min_length=1, max_length=256)
    event_ids: list[UUID] = Field(default_factory=list, max_length=512)
    evidence_ids: list[UUID] = Field(default_factory=list, max_length=512)
    severity: Severity | None = None
    risk_score: int | None = Field(default=None, ge=0, le=100)

    @field_validator("occurred_at", "ingested_at")
    @classmethod
    def normalize_timeline_time(cls, value: datetime | None) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("timeline timestamps must include a timezone")
        return value.astimezone(timezone.utc)


class GraphNode(BaseModel):
    model_config = ConfigDict(extra="forbid")

    node_id: str = Field(min_length=1, max_length=512)
    entity_id: str = Field(min_length=1, max_length=256)
    kind: str = Field(min_length=1, max_length=64)
    label: str = Field(min_length=1, max_length=256)
    event_count: int = Field(ge=1)
    maximum_risk: int = Field(ge=0, le=100)


class GraphEdge(BaseModel):
    model_config = ConfigDict(extra="forbid")

    edge_id: UUID
    source_node_id: str
    target_node_id: str
    relationships: list[str] = Field(min_length=1, max_length=32)
    event_ids: list[UUID] = Field(min_length=1, max_length=4096)
    event_count: int = Field(ge=1)


class GraphData(BaseModel):
    model_config = ConfigDict(extra="forbid")

    nodes: list[GraphNode] = Field(default_factory=list)
    edges: list[GraphEdge] = Field(default_factory=list)
    graph_version: Literal["1.0"] = ANALYSIS_VERSION


class ChartPoint(BaseModel):
    model_config = ConfigDict(extra="forbid")

    series: Literal[
        "event_type",
        "origin",
        "source_label",
        "attack_class",
        "finding_severity",
        "risk_band",
        "activity_minute",
    ]
    category: str = Field(min_length=1, max_length=256)
    value: int = Field(ge=0)
    subgroup: str | None = Field(default=None, max_length=128)


class ActivityClassificationCount(BaseModel):
    model_config = ConfigDict(extra="forbid")
    value: str = Field(min_length=1, max_length=128)
    count: int = Field(ge=1)
    provenance: ClassificationSource


class ActivityWindowExplanation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    window_id: str = Field(min_length=1, max_length=256)
    window_start: datetime
    event_count: int = Field(ge=1)
    baseline_count: float = Field(ge=0)
    deviation_ratio: float | None = Field(default=None, ge=0)
    is_volume_anomaly: bool
    cause_status: Literal["source_classified", "rule_context", "undetermined"]
    explanation: str = Field(min_length=1, max_length=512)
    top_event_types: dict[str, int]
    top_devices: dict[str, int]
    source_classifications: list[ActivityClassificationCount] = Field(default_factory=list)
    finding_ids: list[UUID] = Field(default_factory=list)
    incident_ids: list[UUID] = Field(default_factory=list)
    activity_explanation_version: Literal["1.0"] = "1.0"


class AnalysisResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    analysis_id: UUID
    analysis_version: Literal["1.0"] = ANALYSIS_VERSION
    configuration_version: Literal["1.0"] = ANALYSIS_VERSION
    rule_set_version: Literal["1.0", "1.1", "1.2", "1.3", "1.4"] = "1.4"
    configuration: AnalysisConfig
    case_id: int = Field(ge=1)
    input_event_count: int = Field(ge=0)
    analyzed_event_count: int = Field(ge=0)
    event_ids: list[UUID] = Field(default_factory=list)
    filter: EventFilter
    baselines: list[BaselineSummary] = Field(default_factory=list)
    findings: list[DetectionFinding] = Field(default_factory=list)
    alerts: list[Alert] = Field(default_factory=list)
    correlations: list[CorrelationEdge] = Field(default_factory=list)
    incidents: list[Incident] = Field(default_factory=list)
    timeline: list[TimelineEntry] = Field(default_factory=list)
    graph: GraphData
    chart_points: list[ChartPoint] = Field(default_factory=list)
    activity_windows: list[ActivityWindowExplanation] = Field(default_factory=list)
