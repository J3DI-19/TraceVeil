from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic_core import PydanticCustomError


VisualizationType = Literal[
    "timeline",
    "risk_breakdown",
    "severity_distribution",
    "event_activity",
    "entity_graph",
    "evidence_table",
    "alert_list",
    "top_entities",
    "top_findings",
]

_DATA_REF = re.compile(
    r"^case:(?P<case_id>[1-9]\d*):analysis:(?P<analysis>latest|[0-9a-fA-F-]{36}):"
    r"(?P<dataset>timeline|risk_breakdown|severity_distribution|event_activity|entity_graph|evidence_table|alert_list|top_entities|top_findings)$"
)
_UNSAFE_TEXT = re.compile(r"(?:https?://|<[^>]+>|```|javascript:)", re.IGNORECASE)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class VisualizationComponentV1(StrictModel):
    id: str = Field(min_length=1, max_length=64, pattern=r"^[a-zA-Z0-9_-]+$")
    type: VisualizationType
    title: str = Field(min_length=1, max_length=120)
    data_ref: str = Field(min_length=1, max_length=180)
    span: Literal[1, 2, 3] = 1
    height: Literal["compact", "standard", "tall"] = "standard"

    @field_validator("title")
    @classmethod
    def safe_title(cls, value: str) -> str:
        if _UNSAFE_TEXT.search(value):
            raise PydanticCustomError("unsafe_visualization_title", "unsafe visualization title")
        return value.strip()

    @model_validator(mode="after")
    def matching_reference(self):
        match = _DATA_REF.fullmatch(self.data_ref)
        if match is None or match.group("dataset") != self.type:
            raise PydanticCustomError("visualization_reference_mismatch", "visualization component and data reference must match")
        return self


class VisualizationLayoutV1(StrictModel):
    schema_version: Literal["1.0"] = "1.0"
    layout_id: str = Field(min_length=1, max_length=64, pattern=r"^[a-zA-Z0-9_-]+$")
    title: str = Field(min_length=1, max_length=120)
    components: list[VisualizationComponentV1] = Field(min_length=1, max_length=6)

    @field_validator("title")
    @classmethod
    def safe_title(cls, value: str) -> str:
        if _UNSAFE_TEXT.search(value):
            raise PydanticCustomError("unsafe_visualization_title", "unsafe visualization title")
        return value.strip()

    @model_validator(mode="after")
    def unique_components(self):
        identifiers = [component.id for component in self.components]
        if len(identifiers) != len(set(identifiers)):
            raise PydanticCustomError("duplicate_visualization_component", "visualization component identifiers must be unique")
        return self


class VisualizationResolveRequest(StrictModel):
    layout: VisualizationLayoutV1


class VisualizationResolvedV1(StrictModel):
    schema_version: Literal["1.0"] = "1.0"
    layout: VisualizationLayoutV1
    datasets: dict[str, list[dict] | dict]
    analysis_ids: dict[str, str]


def parse_data_ref(value: str) -> tuple[int, str, VisualizationType]:
    match = _DATA_REF.fullmatch(value)
    if match is None:
        raise ValueError("invalid_visualization_data_ref")
    return int(match.group("case_id")), match.group("analysis"), match.group("dataset")  # type: ignore[return-value]
