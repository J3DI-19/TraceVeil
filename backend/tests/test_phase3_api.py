import json
from time import sleep

import pytest


def case_id(client):
    return client.post("/api/v1/cases", json={"name": "Live demo"}).json()["id"]


def wait_receipt(client, receipt_id):
    for _ in range(200):
        result = client.get(f"/api/v1/live/receipts/{receipt_id}").json()
        if result["status"] in {"completed", "failed", "rejected"}:
            return result
        sleep(0.01)
    raise AssertionError("live receipt did not complete")


def test_authenticated_live_telemetry_is_persisted_and_streamed(client):
    cid = case_id(client)
    session = client.post(
        f"/api/v1/cases/{cid}/live-sessions",
        json={"label": "Lab", "source_ids": ["live-lab-01"]},
    )
    assert session.status_code == 201
    sid = session.json()["session_id"]
    payload = {
        "schema_version": "1.0", "case_id": cid, "source_id": "live-lab-01",
        "device_id": "sensor-1", "event_type": "telemetry",
        "observed_at": "2026-08-15T10:00:00Z", "sequence": 1,
        "metrics": {"temperature": 24.5},
    }
    unauthorized = client.post("/api/v1/live/telemetry", json=payload, headers={"X-Traceveil-Source-Token": "wrong"})
    assert unauthorized.status_code == 401
    accepted = client.post("/api/v1/live/telemetry", json=payload, headers={"X-Traceveil-Source-Token": "traceveil-demo-token"})
    assert accepted.status_code == 202
    receipt = wait_receipt(client, accepted.json()["receipt_id"])
    assert receipt["status"] == "completed"

    duplicate = client.post("/api/v1/live/telemetry", json=payload, headers={"X-Traceveil-Source-Token": "traceveil-demo-token"})
    assert duplicate.json()["duplicate"] is True
    events = client.get(f"/api/v1/cases/{cid}/events?origin=live").json()
    assert events["total"] == 1
    devices = client.get(f"/api/v1/cases/{cid}/live/devices?session_id={sid}").json()
    assert devices["items"][0]["latest_metrics"] == {"temperature": 24.5}
    messages = []
    for _ in range(300):
        messages = client.app.state.phase3_service.stream_after(0, cid, sid, [])
        if "metrics.updated" in {item["topic"] for item in messages}:
            break
        sleep(0.01)
    assert {item["topic"] for item in messages} >= {"event.accepted", "device.updated", "metrics.updated"}
    live_view = client.get(f"/api/v1/cases/{cid}/visualizations/fallback", params={"intent": "live"})
    assert live_view.status_code == 200
    activity = next(iter(live_view.json()["datasets"].values()))
    assert sum(point["Events"] for point in activity) >= 1


def test_malformed_live_payload_is_counted_without_an_event(client):
    cid = case_id(client)
    client.post(f"/api/v1/cases/{cid}/live-sessions", json={"source_ids": ["live-lab-01"]})
    response = client.post(
        "/api/v1/live/telemetry",
        json={"schema_version": "1.0", "case_id": cid, "source_id": "live-lab-01"},
        headers={"X-Traceveil-Source-Token": "traceveil-demo-token"},
    )
    assert response.status_code == 409
    metrics = client.get(f"/api/v1/cases/{cid}/live/metrics").json()
    assert metrics["malformed_count"] == 1
    assert client.get(f"/api/v1/cases/{cid}/events?origin=live").json()["total"] == 0


def test_report_approval_and_email_content_hash_lifecycle(client):
    cid = case_id(client)
    created = client.post(f"/api/v1/cases/{cid}/reports", json={"title": "Demo report"}).json()
    generated = client.post(f"/api/v1/reports/{created['report_id']}/generate").json()
    assert generated["status"] == "generated"
    exported = client.get(f"/api/v1/reports/{created['report_id']}/export")
    assert exported.status_code == 200
    assert exported.content.startswith(b"%PDF")
    approved = client.post(f"/api/v1/reports/{created['report_id']}/approve", json={"approver": "Investigator", "confirmed": True}).json()
    assert approved["status"] == "approved"
    version = client.app.state.phase3_service.db.execute("SELECT * FROM report_versions WHERE report_id=?", (created["report_id"],)).fetchone()
    assert version["content_hash"] == approved["content_hash"]
    assert version["approved_by"] == "Investigator"
    draft = client.post(f"/api/v1/reports/{created['report_id']}/email-drafts", json={"recipient": "security@example.test", "subject": "Report", "body": "Approved report attached."}).json()
    approved_draft = client.post(f"/api/v1/email-drafts/{draft['draft_id']}/approve", json={"approver": "Investigator", "confirmed": True}).json()
    assert approved_draft["status"] == "approved"
    edited = client.patch(f"/api/v1/email-drafts/{draft['draft_id']}", json={"recipient": "security@example.test", "subject": "Updated", "body": "Changed."}).json()
    assert edited["status"] == "draft"
    assert edited["approved_at"] is None


def test_controlled_live_authentication_sequence_creates_persisted_alert(client):
    cid = case_id(client)
    client.post(f"/api/v1/cases/{cid}/live-sessions", json={"source_ids": ["live-lab-01"]})
    for sequence in range(10):
        payload = {
            "schema_version": "1.0", "case_id": cid, "source_id": "live-lab-01",
            "device_id": "door-controller", "event_type": "authentication",
            "observed_at": f"2026-08-15T10:00:{sequence:02d}Z", "sequence": sequence,
            "metrics": {"action": "authenticate", "outcome": "failed"},
        }
        accepted = client.post("/api/v1/live/telemetry", json=payload, headers={"X-Traceveil-Source-Token": "traceveil-demo-token"})
        assert accepted.status_code == 202
        assert wait_receipt(client, accepted.json()["receipt_id"])["status"] == "completed"
    alerts = []
    for _ in range(300):
        alerts = client.get(f"/api/v1/cases/{cid}/alerts").json()["items"]
        if any(item["rule_id"] == "AUTH-001" for item in alerts):
            break
        sleep(0.01)
    assert any(item["rule_id"] == "AUTH-001" for item in alerts)
    history = client.get(f"/api/v1/cases/{cid}/analyses").json()
    assert history["total"] >= 1
    analysis_id = history["items"][0]["analysis_id"]
    persisted_alerts = client.get(
        f"/api/v1/cases/{cid}/alerts", params={"analysis_id": analysis_id}
    ).json()
    assert any(item["rule_id"] == "AUTH-001" for item in persisted_alerts["items"])
    assert client.get(
        f"/api/v1/cases/{cid}/timeline", params={"analysis_id": analysis_id}
    ).json()["total"] >= 1


def test_assistant_offline_returns_grounded_fallback_and_saves_history(client):
    cid = case_id(client)
    session = client.post("/api/v1/assistant/sessions", json={"scope": "specific_case", "case_ids": [cid]}).json()
    job = client.post(f"/api/v1/assistant/sessions/{session['session_id']}/messages", json={"question": "Summarize this case"}).json()
    for _ in range(200):
        current = client.get(f"/api/v1/assistant/jobs/{job['job_id']}").json()
        if current["status"] in {"completed", "failed"}:
            break
        sleep(0.01)
    assert current["status"] == "completed"
    messages = client.get(f"/api/v1/assistant/sessions/{session['session_id']}/messages").json()["items"]
    assert [item["role"] for item in messages] == ["user", "assistant"]
    assert messages[-1]["model"] == "deterministic-fallback"
    assert messages[-1]["citations"] == [f"case:{cid}"]
    assert "generation was unavailable" in messages[-1]["caveats"][0]
    history = client.get("/api/v1/assistant/sessions", params={"case_id": cid}).json()
    assert history["total"] == 1
    assert history["items"][0]["message_count"] == 2
    assert history["items"][0]["title"] == "Summarize this case"
    assert client.get(f"/api/v1/cases/{cid}").status_code == 200


def test_assistant_greeting_uses_model_for_a_natural_conversational_reply(client, monkeypatch):
    cid = case_id(client)
    captured = {}

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"message": {"content": json.dumps({
                "answer": "Hey! What would you like to investigate?",
                "citations": [],
                "caveats": [],
                "visualization": None,
            })}}

    def fake_post(url, *, json, timeout):
        captured.update({"url": url, "payload": json, "timeout": timeout})
        return FakeResponse()

    monkeypatch.setattr("app.services.phase3.httpx.post", fake_post)
    session = client.post(
        "/api/v1/assistant/sessions",
        json={"scope": "specific_case", "case_ids": [cid]},
    ).json()
    job = client.post(
        f"/api/v1/assistant/sessions/{session['session_id']}/messages",
        json={"question": "hey"},
    ).json()
    for _ in range(200):
        current = client.get(f"/api/v1/assistant/jobs/{job['job_id']}").json()
        if current["status"] in {"completed", "failed"}:
            break
        sleep(0.01)

    answer = client.get(
        f"/api/v1/assistant/sessions/{session['session_id']}/messages"
    ).json()["items"][-1]
    assert current["status"] == "completed"
    assert answer["model"] == client.app.state.phase3_service.settings.ollama_model
    assert answer["text"] == "Hey! What would you like to investigate?"
    assert answer["citations"] == []
    assert captured["payload"]["options"]["temperature"] == 0.2
    assert "Reply naturally" in captured["payload"]["messages"][0]["content"]
    user_payload = json.loads(captured["payload"]["messages"][1]["content"])
    assert user_payload == {"conversation_history": [], "question": "hey"}


def test_assistant_explicit_chat_mode_never_retrieves_evidence(client, monkeypatch):
    cid = case_id(client)
    captured = {}

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"message": {"content": json.dumps({
                "answer": "Tuesday.",
                "citations": [],
                "caveats": [],
                "visualization": None,
            })}}

    def fake_post(url, *, json, timeout):
        captured.update({"payload": json})
        return FakeResponse()

    monkeypatch.setattr("app.services.phase3.httpx.post", fake_post)
    session = client.post(
        "/api/v1/assistant/sessions",
        json={"scope": "specific_case", "case_ids": [cid]},
    ).json()
    job = client.post(
        f"/api/v1/assistant/sessions/{session['session_id']}/messages",
        json={"question": "what day is it after monday?", "include_evidence": False},
    ).json()
    for _ in range(200):
        current = client.get(f"/api/v1/assistant/jobs/{job['job_id']}").json()
        if current["status"] in {"completed", "failed"}:
            break
        sleep(0.01)

    answer = client.get(
        f"/api/v1/assistant/sessions/{session['session_id']}/messages"
    ).json()["items"][-1]
    assert current["status"] == "completed"
    assert answer["text"] == "Tuesday."
    assert answer["citations"] == []
    assert json.loads(captured["payload"]["messages"][1]["content"]) == {
        "conversation_history": [],
        "question": "what day is it after monday?",
    }


def test_assistant_disabled_uses_grounded_fallback_without_model(client, monkeypatch):
    cid = case_id(client)
    client.app.state.phase3_service.set_ai_enabled(False)

    def unexpected_post(*args, **kwargs):
        raise AssertionError("disabled AI must not invoke Ollama")

    monkeypatch.setattr("app.services.phase3.httpx.post", unexpected_post)
    session = client.post(
        "/api/v1/assistant/sessions",
        json={"scope": "specific_case", "case_ids": [cid]},
    ).json()
    job = client.post(
        f"/api/v1/assistant/sessions/{session['session_id']}/messages",
        json={"question": "Summarize this case"},
    ).json()
    for _ in range(200):
        current = client.get(f"/api/v1/assistant/jobs/{job['job_id']}").json()
        if current["status"] in {"completed", "failed"}:
            break
        sleep(0.01)

    answer = client.get(
        f"/api/v1/assistant/sessions/{session['session_id']}/messages"
    ).json()["items"][-1]
    assert current["status"] == "completed"
    assert answer["model"] == "deterministic-fallback"
    assert "disabled in System Status" in answer["caveats"][0]


def test_assistant_accepts_json_code_fences_and_bounds_grounding_context(client):
    service = client.app.state.phase3_service
    assert service._parse_assistant_json('```json\n{"answer":"hello"}\n```') == {"answer": "hello"}
    assert service._requests_visualization("Summarize this case") is False
    assert service._requests_visualization("Show a timeline") is True
    cid = case_id(client)
    context = service._assistant_context(
        {"scope": "specific_case", "case_ids": [cid], "reference_ids": []},
        "Summarize this case",
    )
    assert len(json.dumps(context["facts"], separators=(",", ":")).encode("utf-8")) <= 8 * 1024


def test_assistant_bounds_ollama_generation_and_disables_thinking(client, monkeypatch):
    cid = case_id(client)
    captured = {}

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "message": {
                    "content": json.dumps({
                        "answer": "Review the persisted case.",
                        "citations": [f"case:{cid}"],
                        "caveats": [],
                        "visualization": None,
                    })
                }
            }

    def fake_post(url, *, json, timeout):
        captured.update({"url": url, "payload": json, "timeout": timeout})
        return FakeResponse()

    monkeypatch.setattr("app.services.phase3.httpx.post", fake_post)
    session = client.post(
        "/api/v1/assistant/sessions",
        json={"scope": "specific_case", "case_ids": [cid]},
    ).json()
    job = client.post(
        f"/api/v1/assistant/sessions/{session['session_id']}/messages",
        json={"question": "Summarize this case"},
    ).json()
    for _ in range(200):
        current = client.get(f"/api/v1/assistant/jobs/{job['job_id']}").json()
        if current["status"] in {"completed", "failed"}:
            break
        sleep(0.01)

    answer = client.get(
        f"/api/v1/assistant/sessions/{session['session_id']}/messages"
    ).json()["items"][-1]
    assert current["status"] == "completed"
    assert answer["model"] == client.app.state.phase3_service.settings.ollama_model
    assert captured["payload"]["think"] is False
    assert captured["payload"]["options"] == {"temperature": 0, "num_predict": 256, "num_ctx": 8192}
    assert captured["payload"]["keep_alive"] == "15m"
    system_prompt = captured["payload"]["messages"][0]["content"]
    assert "visualization must be null" in system_prompt
    assert "attaches verified citations and visuals separately" in system_prompt


def test_assistant_validates_selected_reference_scope_and_retrieves_event(client):
    cid = case_id(client)
    client.post(f"/api/v1/cases/{cid}/live-sessions", json={"source_ids": ["live-lab-01"]})
    payload = {
        "schema_version": "1.0", "case_id": cid, "source_id": "live-lab-01",
        "device_id": "sensor-chat", "event_type": "telemetry",
        "observed_at": "2026-08-15T11:00:00Z", "sequence": 901,
        "metrics": {"temperature": 27},
    }
    receipt = client.post("/api/v1/live/telemetry", json=payload, headers={"X-Traceveil-Source-Token": "traceveil-demo-token"}).json()
    event_id = wait_receipt(client, receipt["receipt_id"])["event_id"]
    reference = f"case:{cid}:event:{event_id}"
    created = client.post("/api/v1/assistant/sessions", json={"scope": "selected_references", "case_ids": [cid], "reference_ids": [reference]})
    assert created.status_code == 201
    context = client.app.state.phase3_service._assistant_context(created.json(), "Explain this event")
    assert reference in context["allowed_refs"]
    assert {fact["kind"] for fact in context["facts"]} == {"case", "event"}
    job = client.post(f"/api/v1/assistant/sessions/{created.json()['session_id']}/messages", json={"question": "Explain this event"}).json()
    for _ in range(200):
        current = client.get(f"/api/v1/assistant/jobs/{job['job_id']}").json()
        if current["status"] in {"completed", "failed"}:
            break
        sleep(0.01)
    answer = client.get(f"/api/v1/assistant/sessions/{created.json()['session_id']}/messages").json()["items"][-1]
    assert current["status"] == "completed"
    assert answer["citations"] == [reference]
    assert "telemetry" in answer["text"]
    other = case_id(client)
    outside = client.post("/api/v1/assistant/sessions", json={"scope": "specific_case", "case_ids": [other], "reference_ids": [reference]})
    assert outside.status_code == 409
    missing = client.post("/api/v1/assistant/sessions", json={"scope": "selected_references", "case_ids": [cid], "reference_ids": [f"case:{cid}:event:missing"]})
    assert missing.status_code == 409


def test_assistant_rejects_unretrieved_citations_numbers_and_layout_data(client):
    service = client.app.state.phase3_service
    context = {"allowed_refs": ["case:1"], "facts": [{"ref": "case:1", "data": {"event_count": 3}}]}
    with pytest.raises(ValueError, match="invalid_assistant_citation"):
        service._validate_assistant_result({"answer": "Review the case.", "citations": ["case:999"], "visualization": None}, context)
    with pytest.raises(ValueError, match="invalid_assistant_citation"):
        service._validate_assistant_result({"answer": "Review the case.", "citations": [], "visualization": None}, context)
    with pytest.raises(ValueError, match="invented_numeric_claim"):
        service._validate_assistant_result({"answer": "There were 99 events.", "citations": ["case:1"], "visualization": None}, context)
    with pytest.raises(ValueError, match="embedded_visualization_data"):
        service._validate_assistant_result({"answer": "There were 3 events.", "citations": ["case:1"], "visualization": {"schema_version": "1.0", "component": "event_activity", "data_ref": "case:1", "values": [3]}}, context)
    with pytest.raises(ValueError, match="unsafe_assistant_answer"):
        service._validate_assistant_result({"answer": "Follow https://untrusted.invalid", "citations": [], "visualization": None}, context)


@pytest.mark.parametrize(("kind", "data", "expected"), [
    ("alert", {"title": "Repeated login failures", "rule_id": "AUTH-001", "severity": "critical", "risk_score": 92}, "AUTH-001"),
    ("finding", {"title": "Credential attack", "risk": {"score": 91, "factors": [{"name": "confidence"}]}}, "risk score 91"),
    ("correlation", {"source_node_id": "device-a", "target_node_id": "peer-b", "relationships": ["shared_actor"]}, "shared_actor"),
    ("timeline", {"title": "Live alert created", "occurred_at": "2026-09-10T10:00:00Z"}, "Persisted sequence"),
])
def test_assistant_builds_deterministic_explanation_packets(client, kind, data, expected):
    packet = client.app.state.phase3_service._deterministic_explanation([{"ref": f"case:1:{kind}:record", "kind": kind, "data": data}])
    assert expected in packet["text"]
    assert packet["citations"] == [f"case:1:{kind}:record"]


def test_step9_validates_allowlisted_layouts_without_embedded_values(client):
    service = client.app.state.phase3_service
    data_ref = "case:1:analysis:latest:event_activity"
    context = {
        "allowed_refs": ["case:1"],
        "allowed_visualization_refs": [data_ref],
        "facts": [{"ref": "case:1", "data": {"event_count": 3}}],
    }
    result = {
        "answer": "There were 3 persisted events.", "citations": ["case:1"], "caveats": [],
        "visualization": {
            "schema_version": "1.0", "layout_id": "qwen-activity", "title": "Event activity",
            "components": [{"id": "activity", "type": "event_activity", "title": "Activity", "data_ref": data_ref, "span": 3, "height": "standard"}],
        },
    }
    service._validate_assistant_result(result, context)
    assert result["visualization"]["components"][0]["data_ref"] == data_ref


def test_assistant_visual_mode_is_deterministic_and_pins_the_analysis(client):
    cid = case_id(client)
    service = client.app.state.phase3_service
    service.batch.reanalyze(cid)
    service.set_ai_enabled(False)
    analysis_id = client.get(f"/api/v1/cases/{cid}/analyses").json()["items"][0]["analysis_id"]
    session = client.post(
        "/api/v1/assistant/sessions",
        json={"scope": "specific_case", "case_ids": [cid]},
    ).json()
    job = client.post(
        f"/api/v1/assistant/sessions/{session['session_id']}/messages",
        json={
            "question": "give me the timeline",
            "include_evidence": True,
            "visualization_mode": "auto",
        },
    ).json()
    for _ in range(200):
        current = client.get(f"/api/v1/assistant/jobs/{job['job_id']}").json()
        if current["status"] in {"completed", "failed"}:
            break
        sleep(0.01)

    answer = client.get(
        f"/api/v1/assistant/sessions/{session['session_id']}/messages"
    ).json()["items"][-1]
    assert current["status"] == "completed"
    assert answer["visualization"]["components"][0]["type"] == "timeline"
    assert f":analysis:{analysis_id}:timeline" in answer["visualization"]["components"][0]["data_ref"]
    assert ":analysis:latest:" not in answer["visualization"]["components"][0]["data_ref"]


def test_assistant_does_not_attach_a_visual_unless_requested(client):
    cid = case_id(client)
    service = client.app.state.phase3_service
    service.batch.reanalyze(cid)
    service.set_ai_enabled(False)
    session = client.post(
        "/api/v1/assistant/sessions",
        json={"scope": "specific_case", "case_ids": [cid]},
    ).json()
    job = client.post(
        f"/api/v1/assistant/sessions/{session['session_id']}/messages",
        json={
            "question": "Summarize this case",
            "include_evidence": True,
            "visualization_mode": "none",
        },
    ).json()
    for _ in range(200):
        current = client.get(f"/api/v1/assistant/jobs/{job['job_id']}").json()
        if current["status"] in {"completed", "failed"}:
            break
        sleep(0.01)

    answer = client.get(
        f"/api/v1/assistant/sessions/{session['session_id']}/messages"
    ).json()["items"][-1]
    assert current["status"] == "completed"
    assert answer["visualization"] is None


def test_auto_scope_resolves_an_explicit_case_name_before_retrieving_facts(client):
    zeek_id = client.post("/api/v1/cases", json={"name": "Zeek Blind"}).json()["id"]
    client.post("/api/v1/cases", json={"name": "HAI ICS Blind"})
    context = client.app.state.phase3_service._assistant_context(
        {"scope": "auto", "case_ids": [], "reference_ids": []},
        "can you show me the timeline for zeek?",
    )
    case_refs = [fact["ref"] for fact in context["facts"] if fact["kind"] == "case"]
    assert case_refs == [f"case:{zeek_id}"]
    assert all(reference.startswith(f"case:{zeek_id}") for reference in context["allowed_refs"])


def test_automatic_visual_mode_selects_the_focused_analysis_views(client):
    service = client.app.state.phase3_service
    assert service._automatic_visualization_mode("risk pie chart for fridge case?") == "severity_distribution"
    assert service._automatic_visualization_mode("show the risk distribution") == "severity_distribution"
    assert service._automatic_visualization_mode("what happened in the fridge case?") == "timeline"
    assert service._automatic_visualization_mode("show relationships between devices") == "entity_graph"
    assert service._automatic_visualization_mode("which devices are busiest?") == "top_entities"
    assert service._automatic_visualization_mode("show traffic volume") == "event_activity"
    assert service._automatic_visualization_mode("summarize the important risks") == "top_findings"
    assert service._automatic_visualization_mode("summarize this case") == "top_findings"


def test_step9_resolves_only_allowlisted_persisted_visualizations(client):
    cid = case_id(client)
    client.app.state.batch_service.reanalyze(cid)
    analysis_id = client.get(f"/api/v1/cases/{cid}/analyses").json()["items"][0]["analysis_id"]
    components = []
    kinds = ("timeline", "severity_distribution", "event_activity", "entity_graph", "top_entities", "top_findings")
    for index, kind in enumerate(kinds):
        components.append({
            "id": f"view-{index}", "type": kind, "title": kind.replace("_", " ").title(),
            "data_ref": f"case:{cid}:analysis:{analysis_id}:{kind}", "span": 1, "height": "standard",
        })
    response = client.post("/api/v1/visualizations/resolve", json={"layout": {
        "schema_version": "1.0", "layout_id": "all-components", "title": "Verified views", "components": components,
    }})
    assert response.status_code == 200
    body = response.json()
    assert set(body["datasets"]) == {f"view-{index}" for index in range(len(kinds))}
    assert set(body["analysis_ids"].values()) == {analysis_id}

    alert_response = client.post("/api/v1/visualizations/resolve", json={"layout": {
        "schema_version": "1.0", "layout_id": "alert-component", "title": "Verified alerts", "components": [{
            "id": "alerts", "type": "alert_list", "title": "Alerts",
            "data_ref": f"case:{cid}:analysis:{analysis_id}:alert_list", "span": 1, "height": "standard",
        }],
    }})
    assert alert_response.status_code == 200


def test_step9_rejects_unknown_fields_components_and_mismatched_references(client):
    cid = case_id(client)
    client.app.state.batch_service.reanalyze(cid)
    base = {"schema_version": "1.0", "layout_id": "safe", "title": "Safe", "components": [{
        "id": "activity", "type": "event_activity", "title": "Activity",
        "data_ref": f"case:{cid}:analysis:latest:event_activity", "span": 2, "height": "standard",
    }]}
    embedded = {**base, "values": [1, 2, 3]}
    assert client.post("/api/v1/visualizations/resolve", json={"layout": embedded}).status_code == 422
    unknown = {**base, "components": [{**base["components"][0], "type": "generated_react"}]}
    assert client.post("/api/v1/visualizations/resolve", json={"layout": unknown}).status_code == 422
    mismatch = {**base, "components": [{**base["components"][0], "data_ref": f"case:{cid}:analysis:latest:timeline"}]}
    assert client.post("/api/v1/visualizations/resolve", json={"layout": mismatch}).status_code == 422


def test_step9_fallback_is_deterministic_and_pins_historical_snapshot(client):
    cid = case_id(client)
    client.app.state.batch_service.reanalyze(cid)
    analysis_id = client.get(f"/api/v1/cases/{cid}/analyses").json()["items"][0]["analysis_id"]
    first = client.get(f"/api/v1/cases/{cid}/visualizations/fallback", params={"intent": "overview", "analysis_id": analysis_id})
    second = client.get(f"/api/v1/cases/{cid}/visualizations/fallback", params={"intent": "overview", "analysis_id": analysis_id})
    assert first.status_code == 200
    assert first.json() == second.json()
    assert set(first.json()["analysis_ids"].values()) == {analysis_id}
    assert all(f":analysis:{analysis_id}:" in component["data_ref"] for component in first.json()["layout"]["components"])
    for intent in ("top_entities", "top_findings"):
        focused = client.get(
            f"/api/v1/cases/{cid}/visualizations/fallback",
            params={"intent": intent, "analysis_id": analysis_id},
        )
        assert focused.status_code == 200
        assert focused.json()["layout"]["components"][0]["type"] == intent


def test_fake_smtp_delivery_is_explicit_audited_and_idempotent(client, monkeypatch):
    cid = case_id(client); service = client.app.state.phase3_service
    report = client.post(f"/api/v1/cases/{cid}/reports", json={"title": "SMTP test"}).json()
    client.post(f"/api/v1/reports/{report['report_id']}/generate")
    client.post(f"/api/v1/reports/{report['report_id']}/approve", json={"approver": "Investigator", "confirmed": True})
    draft = client.post(f"/api/v1/reports/{report['report_id']}/email-drafts", json={"recipient": "security@example.test", "subject": "Approved report", "body": "Attached."}).json()
    client.post(f"/api/v1/email-drafts/{draft['draft_id']}/approve", json={"approver": "Investigator", "confirmed": True})
    service.settings.smtp_host = "smtp.test"; service.settings.smtp_from_address = "traceveil@example.test"; service.settings.smtp_starttls = False; service.settings.smtp_allowed_recipient_domains = ["example.test"]
    sent = []
    class FakeSMTP:
        def __init__(self, *args, **kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *args): return None
        def send_message(self, message): sent.append(message)
    monkeypatch.setattr("app.services.phase3.smtplib.SMTP", FakeSMTP)
    first_response = client.post(f"/api/v1/email-drafts/{draft['draft_id']}/send")
    assert first_response.status_code == 200, first_response.text
    second_response = client.post(f"/api/v1/email-drafts/{draft['draft_id']}/send")
    assert second_response.status_code == 200, second_response.text
    first = first_response.json(); second = second_response.json()
    assert first["status"] == second["status"] == "sent"
    assert len(sent) == 1
    audit = client.get(f"/api/v1/cases/{cid}/audit").json()["items"]
    assert any(item["action"] == "email.sent" and item["request_id"] for item in audit)
