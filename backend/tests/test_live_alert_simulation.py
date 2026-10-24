from time import sleep


def case_id(client):
    return client.post("/api/v1/cases", json={"name": "Alert simulation test"}).json()["id"]


def wait_receipt(client, receipt_id):
    for _ in range(200):
        receipt = client.get(f"/api/v1/live/receipts/{receipt_id}").json()
        if receipt["status"] in {"completed", "failed"}:
            return receipt
        sleep(0.02)
    raise AssertionError("Simulation receipt did not finish")


def test_simulation_uses_real_detection_without_changing_physical_sequence(client):
    cid = case_id(client)
    session = client.post(f"/api/v1/cases/{cid}/live-sessions", json={"source_ids": ["live-lab-01"]}).json()
    physical = {"schema_version": "1.0", "case_id": cid, "source_id": "live-lab-01",
                "device_id": "esp32-physical", "event_type": "telemetry",
                "observed_at": "2026-10-23T10:00:00Z", "sequence": 7, "metrics": {"temperature_c": 25}}
    accepted = client.post("/api/v1/live/telemetry", json=physical,
                           headers={"X-Traceveil-Source-Token": "traceveil-demo-token"}).json()
    assert wait_receipt(client, accepted["receipt_id"])["status"] == "completed"
    response = client.post(f"/api/v1/live-sessions/{session['session_id']}/simulate-alert")
    assert response.status_code == 202
    simulation = response.json()
    assert simulation["event_count"] == 10
    for receipt in simulation["receipt_ids"]:
        assert wait_receipt(client, receipt)["status"] == "completed"
    for _ in range(200):
        alerts = client.get(f"/api/v1/cases/{cid}/alerts").json()["items"]
        if any(item["rule_id"] == "AUTH-001" for item in alerts):
            break
        sleep(0.02)
    alert = next(item for item in alerts if item["rule_id"] == "AUTH-001")
    assert "[SIMULATED]" in alert["title"]
    assert simulation["device_id"] in alert["title"]
    assert len(alert["event_ids"]) == 10
    events = client.get(f"/api/v1/cases/{cid}/events").json()["items"]
    simulated = [item for item in events if item["device"]["id"] == simulation["device_id"]]
    assert len(simulated) == 10
    assert all(item["attributes"]["simulated"] is True for item in simulated)
    assert all(item["provenance"]["source_id"] == "traceveil-simulator" for item in simulated)
    physical["sequence"] = 8
    assert client.post("/api/v1/live/telemetry", json=physical,
                       headers={"X-Traceveil-Source-Token": "traceveil-demo-token"}).status_code == 202
    audit = client.get(f"/api/v1/cases/{cid}/audit").json()["items"]
    assert any(row["action"] == "live.alert_simulation_requested" for row in audit)
    # The internal simulation identity cannot be used as an unauthenticated device source.
    physical["source_id"] = "traceveil-simulator"
    assert client.post("/api/v1/live/telemetry", json=physical,
                       headers={"X-Traceveil-Source-Token": "anything"}).status_code == 401


def test_simulation_requires_active_session_and_limits_rapid_repeats(client):
    cid = case_id(client)
    session = client.post(f"/api/v1/cases/{cid}/live-sessions", json={"source_ids": ["live-lab-01"]}).json()
    url = f"/api/v1/live-sessions/{session['session_id']}/simulate-alert"
    assert client.post(url).status_code == 202
    assert client.post(url).status_code == 429
    client.post(f"/api/v1/live-sessions/{session['session_id']}/stop")
    assert client.post(url).status_code == 409
