from __future__ import annotations

import json
import math
from collections import defaultdict
from typing import Any

from pydantic import ValidationError

from app.visualization.schemas import VisualizationLayoutV1, parse_data_ref


_SEVERITY_ORDER = {"low": 1, "medium": 2, "high": 3, "critical": 4}


class VisualizationService:
    """Resolve validated layout references exclusively from persisted records."""

    def __init__(self, db):
        self.db = db

    def validate_layout(self, value: dict, allowed_refs: set[str] | None = None) -> VisualizationLayoutV1:
        try:
            layout = VisualizationLayoutV1.model_validate(value)
        except ValidationError as exc:
            raise ValueError("invalid_visualization_spec") from exc
        refs = {component.data_ref for component in layout.components}
        if allowed_refs is not None and not refs <= allowed_refs:
            raise ValueError("invalid_visualization_reference")
        return layout

    def resolve(self, layout: VisualizationLayoutV1) -> dict:
        datasets: dict[str, list[dict] | dict] = {}
        analysis_ids: dict[str, str] = {}
        for component in layout.components:
            case_id, selector, dataset = parse_data_ref(component.data_ref)
            analysis_id = self._analysis_id(case_id, selector)
            datasets[component.id] = self._dataset(case_id, analysis_id, dataset)
            analysis_ids[component.id] = analysis_id
        return {
            "schema_version": "1.0",
            "layout": layout.model_dump(mode="json"),
            "datasets": datasets,
            "analysis_ids": analysis_ids,
        }

    def available_refs(self, case_id: int, selector: str = "latest") -> list[str]:
        # Resolve first so nonexistent cases/snapshots are never advertised to Qwen.
        analysis_id = self._analysis_id(case_id, selector)
        return [
            f"case:{case_id}:analysis:{analysis_id}:{kind}"
            for kind in ("timeline", "risk_breakdown", "severity_distribution", "event_activity", "entity_graph", "evidence_table", "alert_list", "top_entities", "top_findings")
        ]

    def fallback(self, case_id: int, intent: str = "overview", selector: str = "latest") -> VisualizationLayoutV1:
        analysis_id = self._analysis_id(case_id, selector)
        selected = {
            "timeline": [("timeline", "Investigation timeline", 3, "tall")],
            "risk": [("risk_breakdown", "Risk breakdown", 2, "standard")],
            "risk_breakdown": [("risk_breakdown", "Risk breakdown", 2, "standard")],
            "severity_distribution": [("severity_distribution", "Finding severity distribution", 2, "standard")],
            "entities": [("top_entities", "Top entities", 2, "standard")],
            "top_entities": [("top_entities", "Top entities", 2, "standard")],
            "findings": [("top_findings", "Priority findings", 3, "tall")],
            "top_findings": [("top_findings", "Priority findings", 3, "tall")],
            "correlation": [("entity_graph", "Entity correlations", 3, "tall")],
            "entity_graph": [("entity_graph", "Entity correlations", 3, "tall")],
            "alerts": [("alert_list", "Investigation alerts", 3, "standard")],
            "alert_list": [("alert_list", "Investigation alerts", 3, "standard")],
            "evidence": [("evidence_table", "Evidence activity", 3, "standard")],
            "evidence_table": [("evidence_table", "Evidence activity", 3, "standard")],
            "live": [("event_activity", "Persisted live activity", 3, "standard")],
            "event_activity": [("event_activity", "Event activity", 3, "standard")],
        }.get(intent, [
            ("event_activity", "Event activity", 2, "standard"),
            ("severity_distribution", "Finding severity distribution", 1, "standard"),
            ("top_findings", "Priority findings", 3, "tall"),
        ])
        components = [
            {
                "id": f"fallback-{kind.replace('_', '-')}",
                "type": kind,
                "title": title,
                "data_ref": f"case:{case_id}:analysis:{analysis_id}:{kind}",
                "span": span,
                "height": height,
            }
            for kind, title, span, height in selected
        ]
        return VisualizationLayoutV1.model_validate({
            "schema_version": "1.0",
            "layout_id": f"deterministic-{intent}",
            "title": "Deterministic investigation view",
            "components": components,
        })

    def _analysis_id(self, case_id: int, selector: str) -> str:
        case = self.db.execute("SELECT id FROM cases WHERE id=?", (case_id,)).fetchone()
        if not case:
            raise KeyError("case_not_found")
        if selector == "latest":
            row = self.db.execute(
                "SELECT analysis_id FROM analysis_runs WHERE case_id=? ORDER BY created_at DESC LIMIT 1",
                (case_id,),
            ).fetchone()
        else:
            row = self.db.execute(
                "SELECT analysis_id FROM analysis_runs WHERE case_id=? AND analysis_id=?",
                (case_id, selector),
            ).fetchone()
        if not row:
            raise KeyError("analysis_not_found")
        return str(row[0])

    def _artifacts(self, analysis_id: str, kind: str, limit: int) -> list[dict]:
        rows = self.db.execute(
            "SELECT payload_json FROM analysis_artifacts WHERE analysis_id=? AND kind=? "
            "ORDER BY COALESCE(occurred_at,''),item_id LIMIT ?",
            (analysis_id, kind, limit),
        ).fetchall()
        return [json.loads(row[0]) for row in rows]

    def _dataset(self, case_id: int, analysis_id: str, kind: str) -> list[dict] | dict:
        if kind == "timeline":
            return self._timeline(analysis_id)
        if kind == "risk_breakdown":
            return self._risk(analysis_id)
        if kind == "severity_distribution":
            return self._severity_distribution(analysis_id)
        if kind == "event_activity":
            return self._activity(analysis_id)
        if kind == "entity_graph":
            return self._graph(analysis_id)
        if kind == "evidence_table":
            return self._evidence(case_id, analysis_id)
        if kind == "alert_list":
            return self._alerts(analysis_id)
        if kind == "top_entities":
            return self._top_entities(analysis_id)
        if kind == "top_findings":
            return self._top_findings(analysis_id)
        raise ValueError("unknown_visualization_component")

    def _timeline(self, analysis_id: str) -> list[dict]:
        return [
            {
                "id": item["entry_id"],
                "time": item.get("occurred_at") or item["ingested_at"],
                "title": item["title"],
                "description": f"Persisted {item['entry_type']} record",
                "type": item["entry_type"],
                "severity": str(item.get("severity") or "low").title(),
                "evidenceId": str(item.get("evidence_ids", [""])[0]) if item.get("evidence_ids") else None,
            }
            for item in self._artifacts(analysis_id, "timeline", 100)
        ]

    def _risk(self, analysis_id: str) -> list[dict]:
        findings = self._artifacts(analysis_id, "finding", 100)
        if not findings:
            return []
        finding = max(findings, key=lambda item: int(item.get("risk", {}).get("score", 0)))
        return [
            {"label": factor["name"].replace("_", " ").title(), "value": int(factor["score"])}
            for factor in finding.get("risk", {}).get("factors", [])
        ]

    def _severity_distribution(self, analysis_id: str) -> list[dict]:
        counts: dict[str, int] = defaultdict(int)
        for finding in self._artifacts(analysis_id, "finding", 1000):
            severity = str(finding.get("severity") or "low").lower()
            counts[severity if severity in _SEVERITY_ORDER else "low"] += 1
        colors = {
            "critical": "#c93b55",
            "high": "#fb5f68",
            "medium": "#f4b84a",
            "low": "#27c2e8",
        }
        return [
            {"name": severity.title(), "value": counts[severity], "color": colors[severity]}
            for severity in ("critical", "high", "medium", "low")
            if counts[severity]
        ]

    def _top_entities(self, analysis_id: str) -> list[dict]:
        nodes = sorted(
            self._artifacts(analysis_id, "graph_node", 1000),
            key=lambda item: (
                -int(item.get("maximum_risk", 0)),
                -int(item.get("event_count", 0)),
                str(item.get("label", "")).lower(),
            ),
        )
        return [
            {
                "id": str(item["node_id"]),
                "label": str(item["label"]),
                "kind": str(item["kind"]),
                "eventCount": int(item["event_count"]),
                "maximumRisk": int(item["maximum_risk"]),
            }
            for item in nodes[:8]
        ]

    def _top_findings(self, analysis_id: str) -> list[dict]:
        findings = sorted(
            self._artifacts(analysis_id, "finding", 1000),
            key=lambda item: (
                -int(item.get("risk", {}).get("score", 0)),
                -_SEVERITY_ORDER.get(str(item.get("severity", "low")).lower(), 0),
                str(item.get("title", "")).lower(),
            ),
        )
        return [
            {
                "id": str(item["finding_id"]),
                "title": str(item["title"]),
                "summary": str(item.get("summary") or "Persisted analysis finding"),
                "severity": str(item.get("severity") or "low").title(),
                "risk": int(item.get("risk", {}).get("score", 0)),
                "confidence": int(item.get("confidence", 0)),
                "entity": str(item.get("entity_id") or "Case-wide"),
                "eventCount": len(item.get("event_ids", [])),
            }
            for item in findings[:8]
        ]

    def _activity(self, analysis_id: str) -> list[dict]:
        totals: dict[str, int] = defaultdict(int)
        for point in self._artifacts(analysis_id, "aggregate", 10000):
            if point.get("series") == "activity_minute":
                totals[str(point["category"])] += int(point["value"])
        alert_totals: dict[str, int] = defaultdict(int)
        for alert in self._artifacts(analysis_id, "alert", 500):
            value = str(alert.get("triggered_at", ""))[:16]
            if value:
                alert_totals[value] += 1
        return [
            {"label": minute, "Events": value, "Alerts": alert_totals.get(minute, 0)}
            for minute, value in sorted(totals.items())[:200]
        ]

    def _graph(self, analysis_id: str) -> dict:
        source_nodes = self._artifacts(analysis_id, "graph_node", 100)
        count = max(1, len(source_nodes))
        nodes = []
        for index, item in enumerate(source_nodes):
            angle = (2 * math.pi * index / count) - math.pi / 2
            nodes.append({
                "id": item["node_id"], "label": item["label"], "kind": item["kind"],
                "x": round(46 + 35 * math.cos(angle), 3), "y": round(46 + 35 * math.sin(angle), 3),
                "eventCount": item["event_count"], "maximumRisk": item["maximum_risk"],
            })
        node_ids = {item["id"] for item in nodes}
        edges = [
            {
                "from": item["source_node_id"], "to": item["target_node_id"],
                "label": ", ".join(item["relationships"]), "eventCount": item["event_count"],
            }
            for item in self._artifacts(analysis_id, "graph_edge", 200)
            if item["source_node_id"] in node_ids and item["target_node_id"] in node_ids
        ]
        return {"nodes": nodes, "edges": edges}

    def _evidence(self, case_id: int, analysis_id: str) -> list[dict]:
        severity_by_event: dict[str, str] = {}
        for finding in self._artifacts(analysis_id, "finding", 200):
            severity = str(finding.get("severity", "low"))
            for event_id in finding.get("event_ids", []):
                current = severity_by_event.get(str(event_id), "low")
                if _SEVERITY_ORDER.get(severity, 0) > _SEVERITY_ORDER.get(current, 0):
                    severity_by_event[str(event_id)] = severity
        snapshot_event_ids: list[str] = []
        for item in self._artifacts(analysis_id, "timeline", 1000):
            for event_id in item.get("event_ids", []):
                value = str(event_id)
                if value not in snapshot_event_ids:
                    snapshot_event_ids.append(value)
                if len(snapshot_event_ids) >= 100:
                    break
            if len(snapshot_event_ids) >= 100:
                break
        if not snapshot_event_ids:
            return []
        placeholders = ",".join("?" for _ in snapshot_event_ids)
        rows = self.db.execute(
            "SELECT event_id,COALESCE(observed_at,ingested_at),entity_id,event_type,origin "
            f"FROM canonical_events WHERE case_id=? AND event_id IN ({placeholders}) "
            "ORDER BY COALESCE(observed_at,ingested_at),event_id LIMIT 100",
            (case_id, *snapshot_event_ids),
        ).fetchall()
        return [
            {
                "id": row[0], "time": row[1], "device": row[2] or "Unknown",
                "event": row[3], "origin": row[4],
                "severity": severity_by_event.get(str(row[0]), "low").title(),
            }
            for row in rows
        ]

    def _alerts(self, analysis_id: str) -> list[dict]:
        return [
            {
                "id": item["alert_id"], "time": item["triggered_at"], "title": item["title"],
                "severity": str(item["severity"]).title(), "risk": item["risk_score"],
                "status": item.get("workflow_status", "pending"),
            }
            for item in self._artifacts(analysis_id, "alert", 100)
        ]
