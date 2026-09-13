from __future__ import annotations

import asyncio
import json
from datetime import datetime
from pathlib import Path
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Body, Header, Query, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field, ValidationError

from app.evidence.schemas import LiveTelemetryInput
from app.core.errors import DatabaseUnavailableError
from app.visualization.schemas import VisualizationResolveRequest, VisualizationResolvedV1


router = APIRouter(tags=["phase3"])


def service(request: Request):
    value = request.app.state.phase3_service
    if value is None:
        raise DatabaseUnavailableError()
    return value


class LiveSessionCreate(BaseModel):
    label: str = Field(default="Controlled live capture", min_length=1, max_length=200)
    source_ids: list[str] = Field(min_length=1, max_length=20)
    stale_after_seconds: int = Field(default=30, ge=5, le=300)


class AssistantSessionCreate(BaseModel):
    scope: Literal["auto", "all_cases", "specific_case", "selected_references"] = "auto"
    case_ids: list[int] = Field(default_factory=list, max_length=10)
    reference_ids: list[str] = Field(default_factory=list, max_length=50)


class AssistantMessageCreate(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    include_evidence: bool | None = None
    visualization_mode: Literal["none", "auto", "timeline", "severity_distribution", "event_activity", "entity_graph", "top_entities", "top_findings"] = "none"


class AssistantSessionPublic(BaseModel):
    session_id: UUID
    scope: Literal["auto", "all_cases", "specific_case", "selected_references"]
    case_ids: list[int]
    reference_ids: list[str]
    title: str
    message_count: int = Field(ge=0)
    created_at: datetime
    updated_at: datetime


class AssistantErrorPublic(BaseModel):
    code: str
    message: str
    retryable: bool


class AssistantJobPublic(BaseModel):
    job_id: UUID
    session_id: UUID
    status: Literal["queued", "processing", "completed", "failed"]
    error: AssistantErrorPublic | None
    created_at: datetime
    updated_at: datetime


class AssistantMessagePublic(BaseModel):
    message_id: UUID
    session_id: UUID
    role: Literal["user", "assistant"]
    kind: str
    text: str
    citations: list[str]
    caveats: list[str]
    visualization: dict | None
    model: str | None
    created_at: datetime


class AssistantSessionPage(BaseModel):
    items: list[AssistantSessionPublic]
    page: int
    page_size: int
    total: int


class AssistantMessagePage(BaseModel):
    items: list[AssistantMessagePublic]
    page: int
    page_size: int
    total: int


class ReportCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    sections: list[str] = Field(default_factory=lambda: ["executive_summary", "scope", "findings", "evidence", "timeline", "recommendations"])
    narrative: str | None = Field(default=None, max_length=10000)


class Approval(BaseModel):
    approver: str = Field(min_length=1, max_length=120)
    confirmed: Literal[True]


class EmailDraftBody(BaseModel):
    recipient: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$", max_length=320)
    subject: str = Field(min_length=1, max_length=300)
    body: str = Field(min_length=1, max_length=20000)


@router.post("/cases/{case_id}/live-sessions", status_code=201)
def start_session(case_id: int, body: LiveSessionCreate, request: Request):
    return service(request).start_live_session(case_id, body.label, body.source_ids, body.stale_after_seconds, getattr(request.state, "request_id", None))


@router.get("/cases/{case_id}/live-sessions")
def list_sessions(case_id: int, request: Request):
    rows = service(request).db.execute("SELECT session_id FROM live_sessions WHERE case_id=? ORDER BY started_at DESC", (case_id,)).fetchall()
    return {"items": [service(request).get_live_session(row[0]) for row in rows], "page": 1, "page_size": len(rows), "total": len(rows)}


@router.get("/live-sessions/{session_id}")
def get_session(session_id: UUID, request: Request):
    return service(request).get_live_session(str(session_id))


@router.post("/live-sessions/{session_id}/stop")
def stop_session(session_id: UUID, request: Request):
    return service(request).stop_live_session(str(session_id), getattr(request.state, "request_id", None))


@router.post("/live/telemetry", status_code=202)
async def receive_telemetry(request: Request, x_traceveil_source_token: str = Header(alias="X-Traceveil-Source-Token")):
    raw = await request.body()
    svc = service(request)
    if len(raw) > svc.settings.live_max_payload_bytes:
        raise OverflowError("live_payload_too_large")
    request_id = getattr(request.state, "request_id", None)
    client_ip = request.client.host if request.client else None
    try:
        payload = json.loads(raw)
        telemetry = LiveTelemetryInput.model_validate(payload)
    except (json.JSONDecodeError, ValidationError) as exc:
        payload = payload if "payload" in locals() and isinstance(payload, dict) else {}
        source_id = payload.get("source_id")
        if not isinstance(source_id, str):
            # TV5-12: audit before raising so a rogue-source request
            # produces a bounded, structured record even when the body
            # does not carry a usable source_id.
            svc.record_auth_failure(None, "missing_source_id", request_id=request_id, client_ip=client_ip)
            raise PermissionError("invalid_live_source_token") from exc
        try:
            svc.verify_source(source_id, x_traceveil_source_token)
        except PermissionError:
            svc.record_auth_failure(source_id, "invalid_token", request_id=request_id, client_ip=client_ip)
            raise
        svc.record_malformed(payload.get("case_id"), source_id, "malformed_live_telemetry", str(exc), raw.decode("utf-8", errors="replace")[:65536])
        raise ValueError("malformed_live_telemetry") from exc

    try:
        return svc.submit_live(telemetry, x_traceveil_source_token, request_id)
    except PermissionError:
        # TV5-12: well-formed body but bad token still produces one
        # rate-limited audit row before re-raising.
        svc.record_auth_failure(telemetry.source_id, "invalid_token", request_id=request_id, client_ip=client_ip)
        raise


@router.get("/live/receipts/{receipt_id}")
def receipt(receipt_id: UUID, request: Request):
    return service(request).get_live_receipt(str(receipt_id))


@router.get("/cases/{case_id}/live/devices")
def live_devices(case_id: int, request: Request, session_id: UUID | None = None):
    items = service(request).list_devices(case_id, str(session_id) if session_id else None)
    return {"items": items, "page": 1, "page_size": len(items), "total": len(items)}


@router.get("/cases/{case_id}/live/metrics")
def live_metrics(case_id: int, request: Request, session_id: UUID | None = None):
    svc = service(request); session = str(session_id) if session_id else None
    where = "case_id=?" + (" AND session_id=?" if session else ""); values: tuple[Any, ...] = (case_id, session) if session else (case_id,)
    devices = svc.db.execute(f"SELECT COUNT(*),COALESCE(SUM(event_count),0) FROM device_states WHERE {where}", values).fetchone()
    malformed = svc.db.execute("SELECT COUNT(*) FROM live_ingest_issues WHERE case_id=?" + (" AND session_id=?" if session else ""), values).fetchone()[0]
    alerts = svc.db.execute("SELECT COUNT(*) FROM live_alert_first_seen WHERE case_id=?", (case_id,)).fetchone()[0]
    return {"case_id": case_id, "session_id": session, "device_count": devices[0], "event_count": devices[1], "alert_count": alerts, "malformed_count": malformed, "updated_at": svc.db.execute("SELECT MAX(last_seen_at) FROM device_states WHERE case_id=?", (case_id,)).fetchone()[0]}


@router.get("/live/stream")
async def live_stream(request: Request, case_id: int | None = None, session_id: UUID | None = None, topics: str = "", last_event_id: int | None = Header(default=None, alias="Last-Event-ID")):
    selected = [item.strip() for item in topics.split(",") if item.strip()]
    start = last_event_id or 0
    async def generate():
        cursor, last_heartbeat = start, 0.0
        while not await request.is_disconnected():
            messages = service(request).stream_after(cursor, case_id, str(session_id) if session_id else None, selected)
            if messages:
                for message in messages:
                    cursor = message["stream_id"]
                    envelope = {"schema_version": "1.0", "id": cursor, "topic": message["topic"], "case_id": message["case_id"], "session_id": message["session_id"], "occurred_at": message["occurred_at"], "payload": message["payload"]}
                    yield f"id: {cursor}\nevent: {message['topic']}\ndata: {json.dumps(envelope, separators=(',', ':'))}\n\n"
            elif asyncio.get_running_loop().time() - last_heartbeat >= 10:
                last_heartbeat = asyncio.get_running_loop().time()
                yield f"event: heartbeat\ndata: {json.dumps({'schema_version':'1.0','topic':'heartbeat'})}\n\n"
            await asyncio.sleep(0.25)
    return StreamingResponse(generate(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"})


@router.get("/cases/{case_id}/audit")
def audit(case_id: int, request: Request, page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=200)):
    svc = service(request); total = svc.db.execute("SELECT COUNT(*) FROM audit_events WHERE case_id=?", (case_id,)).fetchone()[0]
    rows = svc.db.execute("SELECT * FROM audit_events WHERE case_id=? ORDER BY occurred_at DESC,audit_id DESC LIMIT ? OFFSET ?", (case_id, page_size, (page - 1) * page_size)).fetchall()
    items = []
    for row in rows:
        item = dict(row); item["details"] = json.loads(item.pop("details_json")); items.append(item)
    return {"items": items, "page": page, "page_size": page_size, "total": total}


@router.post("/assistant/sessions", status_code=201, response_model=AssistantSessionPublic)
def create_assistant_session(body: AssistantSessionCreate, request: Request):
    return service(request).create_assistant_session(body.scope, body.case_ids, body.reference_ids)


@router.get("/assistant/sessions", response_model=AssistantSessionPage)
def assistant_sessions(request: Request, case_id: int | None = None):
    items = service(request).list_assistant_sessions(case_id)
    return {"items": items, "page": 1, "page_size": len(items), "total": len(items)}


@router.get("/assistant/sessions/{session_id}", response_model=AssistantSessionPublic)
def assistant_session(session_id: UUID, request: Request):
    return service(request).get_assistant_session(str(session_id))


@router.get("/assistant/sessions/{session_id}/messages", response_model=AssistantMessagePage)
def assistant_messages(session_id: UUID, request: Request):
    items = service(request).assistant_messages(str(session_id))
    return {"items": items, "page": 1, "page_size": len(items), "total": len(items)}


@router.post("/assistant/sessions/{session_id}/messages", status_code=202, response_model=AssistantJobPublic)
def assistant_message(session_id: UUID, body: AssistantMessageCreate, request: Request):
    return service(request).submit_assistant_message(
        str(session_id), body.question, body.include_evidence, body.visualization_mode
    )


@router.get("/assistant/jobs/{job_id}", response_model=AssistantJobPublic)
def assistant_job(job_id: UUID, request: Request):
    return service(request).get_assistant_job(str(job_id))


@router.post("/visualizations/resolve", response_model=VisualizationResolvedV1)
def resolve_visualization(body: VisualizationResolveRequest, request: Request):
    """Resolve a validated layout exclusively from persisted investigation data."""
    return service(request).visualizations.resolve(body.layout)


@router.get("/cases/{case_id}/visualizations/fallback", response_model=VisualizationResolvedV1)
def fallback_visualization(
    case_id: int,
    request: Request,
    intent: Literal["overview", "timeline", "risk", "correlation", "alerts", "evidence", "live", "severity_distribution", "event_activity", "entity_graph", "top_entities", "top_findings"] = "overview",
    analysis_id: UUID | None = None,
):
    selector = str(analysis_id) if analysis_id else "latest"
    layout = service(request).visualizations.fallback(case_id, intent, selector)
    return service(request).visualizations.resolve(layout)


@router.post("/cases/{case_id}/reports", status_code=201)
def create_report(case_id: int, body: ReportCreate, request: Request):
    return service(request).create_report(case_id, body.title, body.sections, body.narrative)


@router.get("/cases/{case_id}/reports")
def list_reports(case_id: int, request: Request):
    rows = service(request).db.execute("SELECT report_id FROM reports WHERE case_id=? ORDER BY created_at DESC", (case_id,)).fetchall()
    items = [service(request).get_report(row[0]) for row in rows]
    return {"items": items, "page": 1, "page_size": len(items), "total": len(items)}


@router.get("/reports/{report_id}")
def get_report(report_id: UUID, request: Request):
    return service(request).get_report(str(report_id))


@router.post("/reports/{report_id}/generate")
def generate_report(report_id: UUID, request: Request):
    return service(request).generate_report(str(report_id))


@router.post("/reports/{report_id}/approve")
def approve_report(report_id: UUID, body: Approval, request: Request):
    return service(request).approve_report(str(report_id), body.approver)


@router.get("/reports/{report_id}/export")
def export_report(report_id: UUID, request: Request):
    report = service(request).get_report(str(report_id))
    if report["status"] not in {"generated", "approved"} or not report["file_path"]:
        raise ValueError("generated_report_required")
    return FileResponse(Path(report["file_path"]), media_type="application/pdf", filename=f"traceveil-{report_id}.pdf", headers={"ETag": report["content_hash"]})


@router.post("/reports/{report_id}/email-drafts", status_code=201)
def create_email_draft(report_id: UUID, body: EmailDraftBody, request: Request):
    return service(request).create_email_draft(str(report_id), str(body.recipient), body.subject, body.body)


@router.get("/email-drafts/{draft_id}")
def get_email_draft(draft_id: UUID, request: Request):
    return service(request).get_email_draft(str(draft_id))


@router.patch("/email-drafts/{draft_id}")
def patch_email_draft(draft_id: UUID, body: EmailDraftBody, request: Request):
    return service(request).update_email_draft(str(draft_id), str(body.recipient), body.subject, body.body)


@router.post("/email-drafts/{draft_id}/approve")
def approve_email_draft(draft_id: UUID, body: Approval, request: Request):
    return service(request).approve_email(str(draft_id), body.approver)


@router.post("/email-drafts/{draft_id}/send")
def send_email_draft(draft_id: UUID, request: Request):
    return service(request).send_email(str(draft_id), getattr(request.state, "request_id", None))
