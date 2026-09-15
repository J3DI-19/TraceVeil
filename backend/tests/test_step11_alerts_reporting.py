"""Step 11 - Alerts, Email, Reports and Automation.

Phase 3 already delivered SMTP configuration, report generation and
export, approval-gated delivery, automatic batch/live analysis, incident
grouping, and audit history. This module covers the three items that were
not implemented, plus regression cover for the notification gates:

* "Generate alert email drafts" and "Support drafts for live detected
  incidents": notification drafts can now be raised directly against a
  deterministic alert or incident, with no report required. They are
  pinned to the artifact's content hash, so re-analysis that changes the
  artifact invalidates an approval.

* "Create deterministic incident summaries before AI narration": every
  incident carries a backend-computed `summary` assembled only from the
  deterministic engine's own counts and bounds, and the report renders
  those summaries above the AI narrative.
"""
from __future__ import annotations

import base64
import json
import re
import zlib
from time import sleep

from app.services.phase3 import Phase3Service


TOKEN = "traceveil-demo-token"
SOURCE = "live-lab-01"
RECIPIENT = "security@example.test"
# Rejection reasons are a closed vocabulary so audit details stay bounded
# and can never carry a raw exception string.
SERVICE_REJECTION_REASONS = Phase3Service.REJECTION_REASONS | {"rejected"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _case(client, name="Step 11") -> int:
    return client.post("/api/v1/cases", json={"name": name}).json()["id"]


def _wait_receipt(client, receipt_id: str) -> dict:
    for _ in range(400):
        body = client.get(f"/api/v1/live/receipts/{receipt_id}").json()
        if body["status"] in {"completed", "failed", "rejected"}:
            return body
        sleep(0.01)
    raise AssertionError("receipt never completed")


def _case_with_alert(client) -> tuple[int, dict]:
    """Drives the deterministic AUTH-001 rule with live telemetry so the
    case has a real alert and incident to notify about."""
    cid = _case(client, "Step 11 alerting")
    client.post(f"/api/v1/cases/{cid}/live-sessions", json={"source_ids": [SOURCE]})
    for sequence in range(10):
        payload = {
            "schema_version": "1.0", "case_id": cid, "source_id": SOURCE,
            "device_id": "door-controller", "event_type": "authentication",
            "observed_at": f"2026-09-14T10:00:{sequence:02d}Z", "sequence": sequence,
            "metrics": {"action": "authenticate", "outcome": "failed"},
        }
        accepted = client.post("/api/v1/live/telemetry", json=payload,
                               headers={"X-Traceveil-Source-Token": TOKEN})
        assert accepted.status_code == 202, accepted.text
        assert _wait_receipt(client, accepted.json()["receipt_id"])["status"] == "completed"

    for _ in range(400):
        alerts = client.get(f"/api/v1/cases/{cid}/alerts").json()["items"]
        if any(item["rule_id"] == "AUTH-001" for item in alerts):
            return cid, next(item for item in alerts if item["rule_id"] == "AUTH-001")
        sleep(0.01)
    raise AssertionError("AUTH-001 alert never appeared")


def _incidents(client, case_id: int) -> list[dict]:
    return client.get(f"/api/v1/cases/{case_id}/incidents").json()["items"]


def _pdf_text(body: bytes) -> str:
    """Return the drawn text of a report PDF, in page order.

    The report canvas is built with ``pageCompression=1``, so the drawn
    strings live inside ASCII85-armoured, Flate-compressed content
    streams and are not present in the raw bytes. Decoding every stream
    and keeping the literal strings gives a faithful, order-preserving
    view without pulling in a PDF parser just for one assertion.
    """
    chunks: list[str] = []
    for match in re.finditer(rb"stream\r?\n(.*?)endstream", body, re.DOTALL):
        content = match.group(1).strip()
        for decode in (lambda raw: zlib.decompress(base64.a85decode(raw, adobe=True)),
                       zlib.decompress,
                       lambda raw: raw):
            try:
                content = decode(content)
                break
            except Exception:  # noqa: BLE001 - try the next stream encoding
                continue
        for literal in re.findall(rb"\((?:\\.|[^\\()])*\)", content):
            chunks.append(literal[1:-1].decode("latin-1"))
    return "\n".join(chunks)


def _configure_smtp(client, sent: list, monkeypatch) -> None:
    service = client.app.state.phase3_service
    service.settings.smtp_host = "smtp.test"
    service.settings.smtp_from_address = "traceveil@example.test"
    service.settings.smtp_starttls = False
    service.settings.smtp_allowed_recipient_domains = ["example.test"]

    class FakeSMTP:
        def __init__(self, *args, **kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *args): return None
        def send_message(self, message): sent.append(message)

    monkeypatch.setattr("app.services.phase3.smtplib.SMTP", FakeSMTP)


# ---------------------------------------------------------------------------
# Deterministic incident summaries before AI narration
# ---------------------------------------------------------------------------
def test_incidents_carry_a_deterministic_summary(client):
    cid, _ = _case_with_alert(client)
    incidents = _incidents(client, cid)
    assert incidents, "expected at least one grouped incident"
    for incident in incidents:
        summary = incident["summary"]
        assert summary, "incident has no deterministic summary"
        assert "Highest severity" in summary
        assert "maximum risk" in summary
        # The summary is built from counts the engine already computed, so
        # its numbers must agree with the incident's own fields.
        assert f"{incident['maximum_risk']}/100" in summary


def test_incident_summary_is_reproducible(client):
    """Recomputing the analysis must reproduce identical summaries - they
    are deterministic text, not generated prose."""
    cid, _ = _case_with_alert(client)
    before = {i["incident_id"]: i["summary"] for i in _incidents(client, cid)}

    response = client.post(f"/api/v1/cases/{cid}/analyses")
    assert response.status_code in (200, 201, 202), response.text
    after = {i["incident_id"]: i["summary"] for i in _incidents(client, cid)}

    assert after == before, "incident summaries are not deterministic"


def test_incident_summary_contains_no_model_output(client):
    """The summary must be assembled locally, never narrated. Ollama is
    unreachable in tests, so a summary that depended on it would be empty
    or error text."""
    cid, _ = _case_with_alert(client)
    for incident in _incidents(client, cid):
        summary = incident["summary"].lower()
        assert summary.strip()
        for banned in ("ollama", "qwen", "unavailable", "error", "sorry", "as an ai"):
            assert banned not in summary, f"summary looks model-generated: {summary}"


def test_report_places_deterministic_summaries_before_ai_narrative(client):
    """A reader must meet the authoritative account first; the narrative
    can only annotate it."""
    cid, _ = _case_with_alert(client)
    report = client.post(f"/api/v1/cases/{cid}/reports",
                         json={"title": "Ordering", "narrative": "Model supplied narrative."}).json()
    assert client.post(f"/api/v1/reports/{report['report_id']}/generate").status_code == 200

    exported = client.get(f"/api/v1/reports/{report['report_id']}/export")
    assert exported.status_code == 200
    assert exported.content.startswith(b"%PDF")
    body = _pdf_text(exported.content)

    deterministic = body.find("DETERMINISTIC INCIDENT SUMMARIES")
    narrative = body.find("AI NARRATIVE")
    assert deterministic != -1, "report omits the deterministic incident summaries"
    assert narrative != -1, "report omits the AI narrative heading"
    assert deterministic < narrative, "AI narrative precedes the deterministic summaries"


# ---------------------------------------------------------------------------
# Alert and live-incident notification drafts
# ---------------------------------------------------------------------------
def test_alert_email_draft_needs_no_report(client):
    cid, alert = _case_with_alert(client)
    response = client.post(
        f"/api/v1/cases/{cid}/alerts/{alert['alert_id']}/email-drafts",
        json={"recipient": RECIPIENT, "subject": "Alert raised", "body": "AUTH-001 triggered."})
    assert response.status_code == 201, response.text
    draft = response.json()
    assert draft["subject_type"] == "alert"
    assert draft["subject_id"] == alert["alert_id"]
    assert draft["report_id"] is None
    assert draft["status"] == "draft"
    assert draft["case_id"] == cid


def test_incident_email_draft_needs_no_report(client):
    cid, _ = _case_with_alert(client)
    incident = _incidents(client, cid)[0]
    response = client.post(
        f"/api/v1/cases/{cid}/incidents/{incident['incident_id']}/email-drafts",
        json={"recipient": RECIPIENT, "subject": "Incident raised", "body": "Grouped incident."})
    assert response.status_code == 201, response.text
    draft = response.json()
    assert draft["subject_type"] == "incident"
    assert draft["subject_id"] == incident["incident_id"]
    assert draft["report_id"] is None


def test_unknown_alert_is_rejected(client):
    cid, _ = _case_with_alert(client)
    response = client.post(
        f"/api/v1/cases/{cid}/alerts/11111111-1111-1111-1111-111111111111/email-drafts",
        json={"recipient": RECIPIENT, "subject": "No such alert", "body": "x"})
    assert response.status_code == 404, response.text


def test_alert_draft_cannot_be_sent_without_approval(client):
    cid, alert = _case_with_alert(client)
    draft = client.post(
        f"/api/v1/cases/{cid}/alerts/{alert['alert_id']}/email-drafts",
        json={"recipient": RECIPIENT, "subject": "Alert", "body": "body"}).json()

    response = client.post(f"/api/v1/email-drafts/{draft['draft_id']}/send")
    assert response.status_code == 409
    assert response.json()["code"] == "approved_email_required"


def test_editing_an_alert_draft_revokes_approval(client):
    cid, alert = _case_with_alert(client)
    draft = client.post(
        f"/api/v1/cases/{cid}/alerts/{alert['alert_id']}/email-drafts",
        json={"recipient": RECIPIENT, "subject": "Alert", "body": "body"}).json()
    approved = client.post(f"/api/v1/email-drafts/{draft['draft_id']}/approve",
                           json={"approver": "Investigator", "confirmed": True}).json()
    assert approved["status"] == "approved"

    edited = client.patch(f"/api/v1/email-drafts/{draft['draft_id']}",
                          json={"recipient": RECIPIENT, "subject": "Alert (edited)", "body": "changed"}).json()
    assert edited["status"] == "draft"
    assert edited["approved_at"] is None
    assert client.post(f"/api/v1/email-drafts/{draft['draft_id']}/send").status_code == 409


def test_alert_draft_rejects_a_disallowed_recipient_domain(client, monkeypatch):
    cid, alert = _case_with_alert(client)
    draft = client.post(
        f"/api/v1/cases/{cid}/alerts/{alert['alert_id']}/email-drafts",
        json={"recipient": "outsider@not-allowed.test", "subject": "Alert", "body": "body"}).json()
    client.post(f"/api/v1/email-drafts/{draft['draft_id']}/approve",
                json={"approver": "Investigator", "confirmed": True})
    _configure_smtp(client, [], monkeypatch)

    response = client.post(f"/api/v1/email-drafts/{draft['draft_id']}/send")
    assert response.status_code == 409
    assert response.json()["code"] == "recipient_domain_not_allowed"


def test_approved_alert_draft_sends_without_a_pdf_attachment(client, monkeypatch):
    cid, alert = _case_with_alert(client)
    draft = client.post(
        f"/api/v1/cases/{cid}/alerts/{alert['alert_id']}/email-drafts",
        json={"recipient": RECIPIENT, "subject": "AUTH-001", "body": "Alert notification."}).json()
    client.post(f"/api/v1/email-drafts/{draft['draft_id']}/approve",
                json={"approver": "Investigator", "confirmed": True})
    sent: list = []
    _configure_smtp(client, sent, monkeypatch)

    response = client.post(f"/api/v1/email-drafts/{draft['draft_id']}/send")
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "sent"
    assert len(sent) == 1
    # Alert notifications reference deterministic artifacts by identifier;
    # only report-bound drafts carry the PDF.
    assert not any(part.get_filename() for part in sent[0].walk())

    # Sending twice must not duplicate the message.
    assert client.post(f"/api/v1/email-drafts/{draft['draft_id']}/send").status_code == 200
    assert len(sent) == 1


def test_alert_notification_is_audited(client, monkeypatch):
    cid, alert = _case_with_alert(client)
    draft = client.post(
        f"/api/v1/cases/{cid}/alerts/{alert['alert_id']}/email-drafts",
        json={"recipient": RECIPIENT, "subject": "AUTH-001", "body": "body"}).json()
    client.post(f"/api/v1/email-drafts/{draft['draft_id']}/approve",
                json={"approver": "Investigator", "confirmed": True})
    _configure_smtp(client, [], monkeypatch)
    client.post(f"/api/v1/email-drafts/{draft['draft_id']}/send")

    audit = client.get(f"/api/v1/cases/{cid}/audit").json()["items"]
    actions = {item["action"] for item in audit}
    assert {"email_draft.created", "email_draft.approved", "email.sent"} <= actions
    created = next(i for i in audit if i["action"] == "email_draft.created")
    assert created["details"]["subject_type"] == "alert"
    assert created["details"]["subject_id"] == alert["alert_id"]


def test_report_drafts_still_require_an_approved_report(client):
    """The pre-existing report path must keep its stricter gate."""
    cid = _case(client, "report gate")
    report = client.post(f"/api/v1/cases/{cid}/reports", json={"title": "Gate"}).json()
    client.post(f"/api/v1/reports/{report['report_id']}/generate")

    # Not yet approved: drafting must be refused.
    response = client.post(f"/api/v1/reports/{report['report_id']}/email-drafts",
                           json={"recipient": RECIPIENT, "subject": "s", "body": "b"})
    assert response.status_code == 409
    assert response.json()["code"] == "approved_report_required"

    client.post(f"/api/v1/reports/{report['report_id']}/approve",
                json={"approver": "Investigator", "confirmed": True})
    ok = client.post(f"/api/v1/reports/{report['report_id']}/email-drafts",
                     json={"recipient": RECIPIENT, "subject": "s", "body": "b"})
    assert ok.status_code == 201, ok.text
    assert ok.json()["subject_type"] == "report"


def test_alert_draft_approval_is_pinned_to_the_artifact(client):
    """Approval must be bound to the deterministic artifact's content, so
    a draft cannot be approved against one alert and sent against another
    version of it."""
    cid, alert = _case_with_alert(client)
    draft = client.post(
        f"/api/v1/cases/{cid}/alerts/{alert['alert_id']}/email-drafts",
        json={"recipient": RECIPIENT, "subject": "Alert", "body": "body"}).json()
    service = client.app.state.phase3_service

    stored = service.get_email_draft(draft["draft_id"])
    anchor = service._draft_anchor(stored)
    assert anchor["subject_type"] == "alert"
    assert anchor["case_id"] == cid
    # The stored hash must be exactly the hash of (recipient, subject,
    # body, artifact content) - nothing else can satisfy it.
    assert stored["content_hash"] == service._draft_hash(RECIPIENT, "Alert", "body", anchor)
    assert stored["content_hash"] != service._draft_hash(RECIPIENT, "Alert", "tampered", anchor)


# ---------------------------------------------------------------------------
# Backend-composed (grounded) draft content
# ---------------------------------------------------------------------------
def test_alert_draft_with_only_a_recipient_is_grounded_in_the_alert(client):
    """An investigator who supplies nothing but an address must still get
    a draft whose text states this alert's own persisted facts."""
    cid, alert = _case_with_alert(client)
    response = client.post(f"/api/v1/cases/{cid}/alerts/{alert['alert_id']}/email-drafts",
                           json={"recipient": RECIPIENT})
    assert response.status_code == 201, response.text
    draft = response.json()

    assert draft["subject"].strip() and draft["body"].strip()
    assert alert["rule_id"] in draft["subject"]
    for expected in (alert["alert_id"], alert["rule_id"], str(alert["risk_score"]),
                     alert["severity"], alert["finding_id"]):
        assert str(expected) in draft["body"], f"draft omits persisted value {expected}"


def test_incident_draft_with_only_a_recipient_carries_the_summary(client):
    cid, _ = _case_with_alert(client)
    incident = _incidents(client, cid)[0]
    draft = client.post(f"/api/v1/cases/{cid}/incidents/{incident['incident_id']}/email-drafts",
                        json={"recipient": RECIPIENT}).json()

    # The deterministic summary is reproduced verbatim, not paraphrased.
    assert incident["summary"] in draft["body"]
    assert incident["incident_id"] in draft["body"]
    assert f"{incident['maximum_risk']}/100" in draft["body"]


def test_composed_draft_states_no_value_absent_from_the_artifact(client):
    """Guards against generated prose: every number in the composed body
    must be traceable to the alert payload or be part of the fixed
    template, never invented."""
    cid, alert = _case_with_alert(client)
    draft = client.post(f"/api/v1/cases/{cid}/alerts/{alert['alert_id']}/email-drafts",
                        json={"recipient": RECIPIENT}).json()

    evidence_ids = alert["evidence_ids"]
    case = client.get(f"/api/v1/cases/{cid}").json()
    # Anything the persisted alert or its case already states, plus the
    # fixed parts of the template: the risk denominator, the case number,
    # the count of supporting records, and the bounded list's "+N more".
    permitted = set(re.findall(r"\d+", json.dumps(alert) + json.dumps(case)))
    permitted |= {"100", str(cid), f"{cid:04d}", str(len(evidence_ids)),
                  str(max(0, len(evidence_ids) - 10))}
    for number in re.findall(r"\d+", draft["body"]):
        assert number in permitted, f"composed body states unsupported number {number}"
    for banned in ("ollama", "qwen", "as an ai", "i think", "likely", "probably"):
        assert banned not in draft["body"].lower(), "composed body reads as model output"


def test_notification_preview_matches_the_created_draft(client):
    """The preview an investigator reads before committing must be the
    text that is actually stored."""
    cid, alert = _case_with_alert(client)
    preview = client.get(
        f"/api/v1/cases/{cid}/alerts/{alert['alert_id']}/notification-preview")
    assert preview.status_code == 200, preview.text
    composed = preview.json()

    draft = client.post(f"/api/v1/cases/{cid}/alerts/{alert['alert_id']}/email-drafts",
                        json={"recipient": RECIPIENT}).json()
    assert draft["subject"] == composed["subject"]
    assert draft["body"] == composed["body"]


def test_investigator_edits_override_the_composed_text(client):
    cid, alert = _case_with_alert(client)
    draft = client.post(f"/api/v1/cases/{cid}/alerts/{alert['alert_id']}/email-drafts",
                        json={"recipient": RECIPIENT, "subject": "My own subject"}).json()
    assert draft["subject"] == "My own subject"
    # The unsupplied half is still composed rather than left blank.
    assert alert["alert_id"] in draft["body"]


def test_cross_case_alert_identifier_is_rejected(client):
    """An alert id is only meaningful inside its own case; accepting one
    from another case would anchor a draft to an artifact the recipient's
    case never produced."""
    first, alert = _case_with_alert(client)
    other = _case(client, "Step 11 unrelated")
    response = client.post(f"/api/v1/cases/{other}/alerts/{alert['alert_id']}/email-drafts",
                           json={"recipient": RECIPIENT})
    assert response.status_code == 404, response.text
    assert first != other


# ---------------------------------------------------------------------------
# Notification lifecycle: listing, audit and alert workflow synchronisation
# ---------------------------------------------------------------------------
def test_drafts_are_listable_so_they_survive_a_refresh(client):
    cid, alert = _case_with_alert(client)
    draft = client.post(f"/api/v1/cases/{cid}/alerts/{alert['alert_id']}/email-drafts",
                        json={"recipient": RECIPIENT}).json()

    listed = client.get(f"/api/v1/cases/{cid}/email-drafts")
    assert listed.status_code == 200, listed.text
    assert draft["draft_id"] in {item["draft_id"] for item in listed.json()["items"]}

    scoped = client.get(f"/api/v1/cases/{cid}/email-drafts",
                        params={"subject_type": "alert", "subject_id": alert["alert_id"]}).json()
    assert [item["draft_id"] for item in scoped["items"]] == [draft["draft_id"]]

    empty = client.get(f"/api/v1/cases/{cid}/email-drafts",
                       params={"subject_type": "incident"}).json()
    assert empty["items"] == []


def test_successful_delivery_marks_the_alert_delivered(client, monkeypatch):
    """The alert list and the audit trail must agree after delivery."""
    cid, alert = _case_with_alert(client)
    draft = client.post(f"/api/v1/cases/{cid}/alerts/{alert['alert_id']}/email-drafts",
                        json={"recipient": RECIPIENT}).json()
    client.post(f"/api/v1/email-drafts/{draft['draft_id']}/approve",
                json={"approver": "Investigator", "confirmed": True})
    _configure_smtp(client, [], monkeypatch)

    assert client.post(f"/api/v1/email-drafts/{draft['draft_id']}/send").status_code == 200
    updated = next(item for item in client.get(f"/api/v1/cases/{cid}/alerts").json()["items"]
                   if item["alert_id"] == alert["alert_id"])
    assert updated["notification_status"] == "delivered"
    assert updated["notification_error"] is None


def test_uncertain_delivery_marks_the_alert_failed_once(client, monkeypatch):
    cid, alert = _case_with_alert(client)
    draft = client.post(f"/api/v1/cases/{cid}/alerts/{alert['alert_id']}/email-drafts",
                        json={"recipient": RECIPIENT}).json()
    client.post(f"/api/v1/email-drafts/{draft['draft_id']}/approve",
                json={"approver": "Investigator", "confirmed": True})
    service = client.app.state.phase3_service
    service.settings.smtp_host = "smtp.test"
    service.settings.smtp_from_address = "traceveil@example.test"
    service.settings.smtp_starttls = False
    service.settings.smtp_allowed_recipient_domains = ["example.test"]

    class BrokenSMTP:
        def __init__(self, *args, **kwargs): raise OSError("connection refused")
    monkeypatch.setattr("app.services.phase3.smtplib.SMTP", BrokenSMTP)

    result = client.post(f"/api/v1/email-drafts/{draft['draft_id']}/send")
    assert result.status_code == 200, result.text
    assert result.json()["status"] == "delivery_unknown"

    updated = next(item for item in client.get(f"/api/v1/cases/{cid}/alerts").json()["items"]
                   if item["alert_id"] == alert["alert_id"])
    assert updated["notification_status"] == "delivery_failed"

    attempts = client.app.state.phase3_service.db.execute(
        "SELECT COUNT(*) FROM delivery_attempts WHERE draft_id=?", (draft["draft_id"],)).fetchone()[0]
    assert attempts == 1, "an uncertain delivery must record exactly one attempt"


def test_incident_notification_does_not_mark_individual_alerts(client, monkeypatch):
    """An incident groups alerts. Marking each one individually notified
    would overstate what was actually sent."""
    cid, alert = _case_with_alert(client)
    incident = _incidents(client, cid)[0]
    draft = client.post(f"/api/v1/cases/{cid}/incidents/{incident['incident_id']}/email-drafts",
                        json={"recipient": RECIPIENT}).json()
    client.post(f"/api/v1/email-drafts/{draft['draft_id']}/approve",
                json={"approver": "Investigator", "confirmed": True})
    _configure_smtp(client, [], monkeypatch)
    assert client.post(f"/api/v1/email-drafts/{draft['draft_id']}/send").status_code == 200

    updated = next(item for item in client.get(f"/api/v1/cases/{cid}/alerts").json()["items"]
                   if item["alert_id"] == alert["alert_id"])
    assert updated["notification_status"] == "not_requested"


def test_draft_edits_are_audited_without_exposing_content(client):
    cid, alert = _case_with_alert(client)
    draft = client.post(f"/api/v1/cases/{cid}/alerts/{alert['alert_id']}/email-drafts",
                        json={"recipient": RECIPIENT}).json()
    client.post(f"/api/v1/email-drafts/{draft['draft_id']}/approve",
                json={"approver": "Investigator", "confirmed": True})
    client.patch(f"/api/v1/email-drafts/{draft['draft_id']}",
                 json={"recipient": RECIPIENT, "subject": "Edited subject",
                       "body": "Secret internal wording."})

    audit = client.get(f"/api/v1/cases/{cid}/audit").json()["items"]
    updated = next(item for item in audit if item["action"] == "email_draft.updated")
    assert set(updated["details"]["changed_fields"]) == {"subject", "body"}
    assert updated["details"]["approval_revoked"] is True
    assert updated["details"]["content_hash"] != updated["details"]["previous_content_hash"]
    # The trail records that an edit happened, never what was written.
    serialized = json.dumps(audit)
    assert "Secret internal wording." not in serialized
    assert "Edited subject" not in serialized


def test_rejected_sends_are_audited_with_a_bounded_reason(client, monkeypatch):
    """A refused delivery must be reconstructible. Without a record an
    investigator cannot tell a blocked send from one never attempted."""
    cid, alert = _case_with_alert(client)

    unapproved = client.post(f"/api/v1/cases/{cid}/alerts/{alert['alert_id']}/email-drafts",
                             json={"recipient": RECIPIENT}).json()
    assert client.post(f"/api/v1/email-drafts/{unapproved['draft_id']}/send").status_code == 409

    disallowed = client.post(f"/api/v1/cases/{cid}/alerts/{alert['alert_id']}/email-drafts",
                             json={"recipient": "outsider@not-allowed.test"}).json()
    client.post(f"/api/v1/email-drafts/{disallowed['draft_id']}/approve",
                json={"approver": "Investigator", "confirmed": True})
    _configure_smtp(client, [], monkeypatch)
    assert client.post(f"/api/v1/email-drafts/{disallowed['draft_id']}/send").status_code == 409

    audit = client.get(f"/api/v1/cases/{cid}/audit").json()["items"]
    rejections = [item for item in audit if item["action"] == "email.rejected"]
    reasons = {item["details"]["reason"] for item in rejections}
    assert {"approved_email_required", "recipient_domain_not_allowed"} <= reasons
    for item in rejections:
        assert item["details"]["reason"] in SERVICE_REJECTION_REASONS
        assert "outsider@not-allowed.test" not in json.dumps(item["details"])


def test_send_after_missing_smtp_is_audited(client):
    cid, alert = _case_with_alert(client)
    draft = client.post(f"/api/v1/cases/{cid}/alerts/{alert['alert_id']}/email-drafts",
                        json={"recipient": RECIPIENT}).json()
    client.post(f"/api/v1/email-drafts/{draft['draft_id']}/approve",
                json={"approver": "Investigator", "confirmed": True})
    service = client.app.state.phase3_service
    service.settings.smtp_host = ""

    assert client.post(f"/api/v1/email-drafts/{draft['draft_id']}/send").status_code == 409
    audit = client.get(f"/api/v1/cases/{cid}/audit").json()["items"]
    assert any(item["action"] == "email.rejected"
               and item["details"]["reason"] == "smtp_not_configured" for item in audit)


def test_repeated_send_does_not_audit_a_second_delivery(client, monkeypatch):
    cid, alert = _case_with_alert(client)
    draft = client.post(f"/api/v1/cases/{cid}/alerts/{alert['alert_id']}/email-drafts",
                        json={"recipient": RECIPIENT}).json()
    client.post(f"/api/v1/email-drafts/{draft['draft_id']}/approve",
                json={"approver": "Investigator", "confirmed": True})
    sent: list = []
    _configure_smtp(client, sent, monkeypatch)
    client.post(f"/api/v1/email-drafts/{draft['draft_id']}/send")
    client.post(f"/api/v1/email-drafts/{draft['draft_id']}/send")

    audit = client.get(f"/api/v1/cases/{cid}/audit").json()["items"]
    assert len([item for item in audit if item["action"] == "email.sent"]) == 1
    assert len(sent) == 1
