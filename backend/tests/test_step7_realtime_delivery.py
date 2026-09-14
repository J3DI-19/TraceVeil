"""Step 7 - Real-Time Event Delivery.

Phase 3 shipped the SSE plumbing but nothing verified it as a delivery
surface. This module closes that gap on three fronts:

1. Timeline delivery (roadmap: "Update timelines when relevant live
   events arrive"). A `timeline.updated` message is emitted after each
   live re-analysis carrying only backend-authored identifiers and a
   count, so a browser must refetch validated values and can never
   render a client-computed chronology.

2. The real HTTP surface. Every pre-existing assertion called
   `stream_after()` directly, so `GET /api/v1/live/stream` itself was
   untested. Starlette's TestClient cannot terminate an infinite SSE
   generator (`request.is_disconnected()` never fires, so closing the
   response deadlocks), so these tests run a real uvicorn server on an
   ephemeral port and connect over real HTTP with real timeouts. That
   also makes the assertions meaningful: a genuine TCP close is what
   ends the server-side generator.

3. Forensic invariance (roadmap: "Ensure real-time delivery does not
   alter forensic calculations"). Reading, re-reading and replaying the
   stream must leave evidence, canonical events, analysis runs and every
   analysis artifact byte-identical.
"""
from __future__ import annotations

import json
import threading
import time
from time import sleep
from types import SimpleNamespace

import httpx
import pytest
import uvicorn

from app.core.config import get_settings
from app.main import create_app


VALID_TOKEN = "traceveil-demo-token"
SOURCE = "live-lab-01"
STREAM_PATH = "/api/v1/live/stream"
API = "/api/v1"


# ---------------------------------------------------------------------------
# A real server, because an SSE stream cannot be closed through TestClient
# ---------------------------------------------------------------------------
@pytest.fixture
def live_server(tmp_path, monkeypatch):
    get_settings.cache_clear()
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'sse.db'}")
    monkeypatch.setenv("EVIDENCE_STORAGE_PATH", str(tmp_path / "evidence"))
    monkeypatch.setenv("REPORT_STORAGE_PATH", str(tmp_path / "reports"))
    monkeypatch.setenv("LIVE_SOURCE_TOKENS", '{"live-lab-01":"traceveil-demo-token"}')
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://127.0.0.1:1")

    app = create_app()
    config = uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning", lifespan="on")
    server = uvicorn.Server(config)
    # Bind first so the port is known before the server thread starts.
    sock = config.bind_socket()
    port = sock.getsockname()[1]
    thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]},
                              name="step7-uvicorn", daemon=True)
    thread.start()

    deadline = time.monotonic() + 20
    while time.monotonic() < deadline and not server.started:
        sleep(0.05)
    assert server.started, "uvicorn did not start"

    http = httpx.Client(base_url=f"http://127.0.0.1:{port}",
                        timeout=httpx.Timeout(20.0, read=20.0))
    try:
        yield SimpleNamespace(http=http, app=app)
    finally:
        http.close()
        server.should_exit = True
        thread.join(timeout=15)
        try:
            sock.close()
        except OSError:
            pass
        get_settings.cache_clear()


def _env(client):
    """Adapter so the helpers work with either the TestClient fixture or
    the real-server fixture."""
    return SimpleNamespace(http=client, app=client.app)


# ---------------------------------------------------------------------------
# Helpers (env = .http for requests, .app for direct service access)
# ---------------------------------------------------------------------------
def _case(env, name="Step 7 realtime") -> int:
    response = env.http.post(f"{API}/cases", json={"name": name})
    assert response.status_code in (200, 201), response.text
    return response.json()["id"]


def _session(env, case_id: int) -> str:
    response = env.http.post(f"{API}/cases/{case_id}/live-sessions",
                             json={"label": "realtime", "source_ids": [SOURCE]})
    assert response.status_code == 201, response.text
    return response.json()["session_id"]


def _wait_receipt(env, receipt_id: str) -> dict:
    for _ in range(600):
        response = env.http.get(f"{API}/live/receipts/{receipt_id}")
        assert response.status_code == 200, f"receipt GET {response.status_code}: {response.text}"
        body = response.json()
        if body["status"] in {"completed", "failed", "rejected"}:
            return body
        sleep(0.01)
    raise AssertionError(f"receipt {receipt_id} never reached a terminal status")


def _send(env, case_id: int, sequence: int) -> dict:
    payload = {
        "schema_version": "1.0", "case_id": case_id, "source_id": SOURCE,
        "device_id": "sensor-1", "event_type": "telemetry",
        "observed_at": f"2026-09-14T10:00:{sequence % 60:02d}Z", "sequence": sequence,
        "metrics": {"temperature": 20.0 + sequence},
    }
    response = env.http.post(f"{API}/live/telemetry", json=payload,
                             headers={"X-Traceveil-Source-Token": VALID_TOKEN})
    assert response.status_code == 202, response.text
    return _wait_receipt(env, response.json()["receipt_id"])


def _service(env):
    return env.app.state.phase3_service


def _settle(env, case_id: int, quiet_s: float = 0.4, timeout_s: float = 20.0) -> None:
    """Block until the background worker stops changing this case.

    Live ingestion is asynchronous: a completed receipt is followed by
    re-analysis, which emits further stream messages. Snapshots taken
    before the pipeline goes quiet would race the worker.
    """
    svc = _service(env)

    def fingerprint():
        q = lambda sql: svc.db.execute(sql, (case_id,)).fetchone()[0]
        return (
            q("SELECT COUNT(*) FROM stream_messages WHERE case_id=?"),
            q("SELECT COUNT(*) FROM analysis_runs WHERE case_id=?"),
            q("SELECT COUNT(*) FROM canonical_events WHERE case_id=?"),
            q("SELECT COUNT(*) FROM live_receipts WHERE case_id=? AND status IN ('queued','processing')"),
        )

    deadline = time.monotonic() + timeout_s
    last, stable_since = fingerprint(), time.monotonic()
    while time.monotonic() < deadline:
        sleep(0.05)
        current = fingerprint()
        if current != last:
            last, stable_since = current, time.monotonic()
        elif time.monotonic() - stable_since >= quiet_s:
            return
    raise AssertionError(f"case {case_id} never settled; last fingerprint={last}")


def _ingest(env, case_id: int, count: int = 2) -> None:
    for sequence in range(1, count + 1):
        _send(env, case_id, sequence)
    _settle(env, case_id)


def _messages(env, case_id: int, session_id: str | None = None, after: int = 0, topics=()):
    return _service(env).stream_after(after, case_id, session_id, list(topics))


def _read_sse(env, path: str, *, headers: dict | None = None,
              max_events: int = 4, max_lines: int = 400) -> list[dict]:
    """Opens the real SSE endpoint over HTTP and collects framed events.

    Stops once `max_events` complete frames are seen, then closes the
    connection - a genuine TCP close, which is what makes the server's
    `request.is_disconnected()` true and ends its generator.
    """
    events: list[dict] = []
    with env.http.stream("GET", path, headers=headers or {}) as response:
        assert response.status_code == 200, response.status_code
        assert response.headers["content-type"].startswith("text/event-stream"), response.headers
        current: dict = {}
        seen_lines = 0
        for raw in response.iter_lines():
            seen_lines += 1
            if seen_lines > max_lines:
                break
            line = raw.rstrip("\r")
            if line == "":
                if current:
                    events.append(current)
                    current = {}
                if len(events) >= max_events:
                    break
                continue
            if line.startswith("id:"):
                current["id"] = int(line[3:].strip())
            elif line.startswith("event:"):
                current["event"] = line[6:].strip()
            elif line.startswith("data:"):
                current["data"] = json.loads(line[5:].strip())
    return events


def _forensic_snapshot(env, case_id: int) -> dict:
    """Every backend-authored value a reviewer would call 'forensic'."""
    svc = _service(env)
    run = svc.db.execute(
        "SELECT analysis_id FROM analysis_runs WHERE case_id=? ORDER BY created_at DESC LIMIT 1",
        (case_id,)).fetchone()
    analysis_id = run[0] if run else None
    artifacts = []
    if analysis_id:
        artifacts = [
            (r["kind"], r["item_id"], r["payload_json"])
            for r in svc.db.execute(
                "SELECT kind, item_id, payload_json FROM analysis_artifacts WHERE analysis_id=?"
                " ORDER BY kind, item_id", (analysis_id,)).fetchall()
        ]
    return {
        "analysis_id": analysis_id,
        "artifacts": artifacts,
        "event_rows": [
            (r["event_id"], r["canonical_json"])
            for r in svc.db.execute(
                "SELECT event_id, canonical_json FROM canonical_events WHERE case_id=? ORDER BY event_id",
                (case_id,)).fetchall()
        ],
        "receipts": svc.db.execute(
            "SELECT COUNT(*) FROM live_receipts WHERE case_id=?", (case_id,)).fetchone()[0],
        "analysis_runs": svc.db.execute(
            "SELECT COUNT(*) FROM analysis_runs WHERE case_id=?", (case_id,)).fetchone()[0],
        "evidence": svc.db.execute(
            "SELECT COUNT(*) FROM live_evidence_records WHERE case_id=?", (case_id,)).fetchone()[0],
    }


# ---------------------------------------------------------------------------
# Update timelines when relevant live events arrive
# ---------------------------------------------------------------------------
def test_live_event_emits_timeline_updated(client):
    env = _env(client)
    cid = _case(env)
    sid = _session(env, cid)
    _ingest(env, cid, 1)

    timeline = [m for m in _messages(env, cid, sid) if m["topic"] == "timeline.updated"]
    assert timeline, f"no timeline.updated; saw {[m['topic'] for m in _messages(env, cid, sid)]}"
    payload = timeline[-1]["payload"]
    assert payload["case_id"] == cid
    assert payload["analysis_id"]
    assert isinstance(payload["entry_count"], int) and payload["entry_count"] >= 0


def test_timeline_updated_carries_no_renderable_timeline_values(client):
    """The signal must not ship chronology values: the browser has to
    refetch from the investigation API so what it displays is always
    backend-authored."""
    env = _env(client)
    cid = _case(env)
    sid = _session(env, cid)
    _ingest(env, cid, 1)

    payload = [m for m in _messages(env, cid, sid) if m["topic"] == "timeline.updated"][-1]["payload"]
    assert set(payload) == {"case_id", "analysis_id", "entry_count"}
    assert all(not isinstance(value, (list, dict)) for value in payload.values())


def test_timeline_updated_matches_the_persisted_analysis(client):
    env = _env(client)
    cid = _case(env)
    sid = _session(env, cid)
    _ingest(env, cid, 2)

    payload = [m for m in _messages(env, cid, sid) if m["topic"] == "timeline.updated"][-1]["payload"]
    svc = _service(env)
    latest = svc.db.execute(
        "SELECT analysis_id FROM analysis_runs WHERE case_id=? ORDER BY created_at DESC LIMIT 1",
        (cid,)).fetchone()[0]
    persisted = svc.db.execute(
        "SELECT COUNT(*) FROM analysis_artifacts WHERE analysis_id=? AND kind='timeline'",
        (latest,)).fetchone()[0]
    assert payload["analysis_id"] == latest
    assert payload["entry_count"] == persisted


def test_timeline_api_serves_entries_after_the_signal(client):
    """The signal is only useful if the refetch it triggers returns the
    new chronology."""
    env = _env(client)
    cid = _case(env)
    _session(env, cid)
    _ingest(env, cid, 2)

    response = client.get(f"{API}/cases/{cid}/timeline?page=1&page_size=50")
    assert response.status_code == 200, response.text
    assert response.json()["total"] >= 1


def test_all_expected_topics_are_delivered_for_a_live_event(client):
    env = _env(client)
    cid = _case(env)
    sid = _session(env, cid)
    _ingest(env, cid, 1)

    seen = {m["topic"] for m in _messages(env, cid, sid)}
    assert {"event.accepted", "device.updated", "timeline.updated", "metrics.updated"} <= seen


# ---------------------------------------------------------------------------
# The real HTTP SSE surface (real uvicorn server)
# ---------------------------------------------------------------------------
def test_sse_endpoint_streams_framed_events(live_server):
    cid = _case(live_server)
    sid = _session(live_server, cid)
    _ingest(live_server, cid, 1)

    events = _read_sse(live_server, f"{STREAM_PATH}?case_id={cid}&session_id={sid}", max_events=3)
    assert events, "the SSE endpoint delivered no frames"
    for event in events:
        assert isinstance(event.get("id"), int)
        envelope = event["data"]
        assert envelope["schema_version"] == "1.0"
        assert envelope["topic"] == event["event"], "event: name must match the envelope topic"
        assert envelope["id"] == event["id"], "id: line must match the envelope id"
        assert envelope["case_id"] == cid
    ids = [event["id"] for event in events]
    assert ids == sorted(ids) and len(set(ids)) == len(ids), "ids must be unique and increasing"


def test_sse_endpoint_emits_heartbeat_when_idle(live_server):
    """A case with nothing to deliver still receives heartbeats, which is
    what keeps an idle connection (and any proxy in front of it) alive."""
    cid = _case(live_server)
    events = _read_sse(live_server, f"{STREAM_PATH}?case_id={cid}", max_events=1)
    assert events, "idle stream produced no heartbeat"
    assert events[0]["event"] == "heartbeat"
    assert events[0]["data"]["topic"] == "heartbeat"


def test_sse_endpoint_respects_the_topic_filter(live_server):
    cid = _case(live_server)
    sid = _session(live_server, cid)
    _ingest(live_server, cid, 2)

    events = _read_sse(
        live_server, f"{STREAM_PATH}?case_id={cid}&session_id={sid}&topics=timeline.updated",
        max_events=1)
    assert events, "topic-filtered stream delivered nothing"
    assert events[0]["event"] == "timeline.updated"


def test_sse_last_event_id_resumes_without_gap_or_duplicate(live_server):
    """What a browser does on reconnect: replay strictly after the last
    id it saw."""
    cid = _case(live_server)
    sid = _session(live_server, cid)
    _ingest(live_server, cid, 2)

    all_ids = [m["stream_id"] for m in _messages(live_server, cid, sid)]
    assert len(all_ids) >= 3, "need several messages to test resumption"
    midpoint = all_ids[len(all_ids) // 2]
    expected = [i for i in all_ids if i > midpoint]

    resumed = _read_sse(
        live_server, f"{STREAM_PATH}?case_id={cid}&session_id={sid}",
        headers={"Last-Event-ID": str(midpoint)}, max_events=len(expected))
    resumed_ids = [event["id"] for event in resumed if "id" in event]

    assert resumed_ids, "resume delivered nothing"
    assert all(i > midpoint for i in resumed_ids), "resume replayed already-seen ids"
    assert len(set(resumed_ids)) == len(resumed_ids), "resume duplicated ids"
    assert resumed_ids == expected[:len(resumed_ids)], "resume returned the wrong slice"


def test_sse_stream_is_scoped_to_its_case(live_server):
    """A consumer of case A must never receive case B's messages."""
    case_a = _case(live_server, "case A")
    sid_a = _session(live_server, case_a)
    _ingest(live_server, case_a, 1)
    case_b = _case(live_server, "case B")

    events = _read_sse(live_server, f"{STREAM_PATH}?case_id={case_a}&session_id={sid_a}", max_events=3)
    assert events
    assert all(event["data"]["case_id"] == case_a for event in events)

    # Case B has produced nothing, so its stream is idle (heartbeat only).
    b_events = _read_sse(live_server, f"{STREAM_PATH}?case_id={case_b}", max_events=1)
    assert b_events and b_events[0]["event"] == "heartbeat"


def test_repeated_connect_and_disconnect_is_clean(live_server):
    """Opening and dropping the stream repeatedly must not wedge the
    service - ingestion still works afterwards."""
    cid = _case(live_server)
    _session(live_server, cid)
    _ingest(live_server, cid, 1)

    for _ in range(5):
        _read_sse(live_server, f"{STREAM_PATH}?case_id={cid}", max_events=1)

    receipt = _send(live_server, cid, 2)
    assert receipt["status"] == "completed", f"ingestion broke after stream churn: {receipt}"


def test_http_streaming_does_not_change_forensic_values(live_server):
    """The invariance check driven through the real delivery surface."""
    cid = _case(live_server)
    sid = _session(live_server, cid)
    _ingest(live_server, cid, 2)

    before = _forensic_snapshot(live_server, cid)
    for _ in range(3):
        _read_sse(live_server, f"{STREAM_PATH}?case_id={cid}&session_id={sid}", max_events=2)
    _settle(live_server, cid)

    assert _forensic_snapshot(live_server, cid) == before, \
        "streaming over HTTP mutated forensic state"


# ---------------------------------------------------------------------------
# Real-time delivery must not alter forensic calculations
# ---------------------------------------------------------------------------
def test_reading_the_stream_does_not_change_any_forensic_value(client):
    env = _env(client)
    cid = _case(env)
    sid = _session(env, cid)
    _ingest(env, cid, 3)

    before = _forensic_snapshot(env, cid)

    svc = _service(env)
    cursor = 0
    for _ in range(25):
        batch = svc.stream_after(cursor, cid, sid, [])
        if batch:
            cursor = batch[-1]["stream_id"]
    for topics in ([], ["event.accepted"], ["alert.created"], ["timeline.updated"], ["metrics.updated"]):
        svc.stream_after(0, cid, sid, topics)

    assert _forensic_snapshot(env, cid) == before, "live delivery mutated forensic state"


def test_last_event_id_replay_is_idempotent_and_inert(client):
    env = _env(client)
    cid = _case(env)
    sid = _session(env, cid)
    _ingest(env, cid, 2)

    svc = _service(env)
    first = svc.stream_after(0, cid, sid, [])
    assert first
    before = _forensic_snapshot(env, cid)

    for _ in range(3):
        replay = svc.stream_after(0, cid, sid, [])
        assert [(m["stream_id"], m["topic"], m["payload"]) for m in replay] == \
               [(m["stream_id"], m["topic"], m["payload"]) for m in first]

    midpoint = first[len(first) // 2]["stream_id"]
    tail = svc.stream_after(midpoint, cid, sid, [])
    assert [m["stream_id"] for m in tail] == [m["stream_id"] for m in first if m["stream_id"] > midpoint]

    assert _forensic_snapshot(env, cid) == before


def test_stream_reads_append_nothing_to_the_log(client):
    """Reading must be a pure query; if it appended to the log it reads,
    replay could never be deterministic."""
    env = _env(client)
    cid = _case(env)
    sid = _session(env, cid)
    _ingest(env, cid, 1)

    svc = _service(env)
    count = lambda: svc.db.execute(
        "SELECT COUNT(*) FROM stream_messages WHERE case_id=?", (cid,)).fetchone()[0]
    before = count()
    for _ in range(20):
        svc.stream_after(0, cid, sid, [])
    assert count() == before


def test_consuming_the_stream_during_ingestion_preserves_determinism(client):
    """A consumer polling while telemetry arrives must not perturb
    ingestion or analysis. The analysis engine is content-addressed, so
    recomputing from the same persisted evidence must resolve to the very
    same analysis run."""
    env = _env(client)
    svc = _service(env)
    cid = _case(env, "consumer during ingestion")
    sid = _session(env, cid)

    cursor = 0
    for sequence in range(1, 5):
        receipt = _send(env, cid, sequence)
        assert receipt["status"] == "completed", f"streaming disturbed ingestion: {receipt}"
        for _ in range(5):
            batch = svc.stream_after(cursor, cid, sid, [])
            if batch:
                cursor = batch[-1]["stream_id"]
    _settle(env, cid)

    live_run = svc.db.execute(
        "SELECT analysis_id FROM analysis_runs WHERE case_id=? ORDER BY created_at DESC LIMIT 1",
        (cid,)).fetchone()[0]

    response = client.post(f"{API}/cases/{cid}/analyses")
    assert response.status_code in (200, 201, 202), response.text
    body = response.json()
    assert body["analysis_id"] == live_run, \
        "recomputation after streaming produced a different analysis"
    assert body.get("reused_existing") is True, \
        "expected the deterministic engine to resolve to the existing run"
