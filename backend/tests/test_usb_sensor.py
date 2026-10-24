import json
import time
from queue import Empty, Queue
from types import SimpleNamespace

import pytest
import serial
from fastapi import HTTPException

from app.api.usb_sensor import manager
from app.services.usb_sensor import UsbSensorSetup


class Board:
    def __init__(self):
        self.frames = Queue()
        self.is_open = True

    def write(self, command):
        if command == b"HELLO\n":
            self.frames.put({"protocol": UsbSensorSetup.PROTOCOL, "type": "hello"})

    def readline(self, limit):
        try:
            value = self.frames.get(timeout=0.1)
        except Empty:
            return b""
        if isinstance(value, Exception):
            raise value
        return json.dumps(value).encode() + b"\n"

    def close(self):
        self.is_open = False


def wait_for(predicate):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError("USB setup did not reach the expected state")


@pytest.fixture
def setup(client, monkeypatch):
    setup = client.app.state.usb_sensor
    setup.phase3.settings.live_source_tokens[setup.SOURCE] = "usb-test-token"
    monkeypatch.setattr(setup, "ports", lambda: [{"port": "COM7", "description": "CP2102"}])
    board = Board()
    monkeypatch.setattr(setup, "_open", lambda port: board)
    return setup, board


def sample(sequence=1):
    return {"protocol": UsbSensorSetup.PROTOCOL, "type": "sample", "sequence": sequence,
            "temperature_c": 29.25, "humidity_pct": 58.5, "uptime_ms": 5000}


def test_usb_setup_waits_for_real_persisted_input_and_reuses_inflight_start(client, setup):
    service, board = setup
    started = client.post("/api/v1/usb-sensor/start", json={"name": "Tomorrow test"})
    assert started.status_code == 202
    wait_for(lambda: service.status()["state"] == "waiting")
    assert service.status()["readings"] == 0
    cid = service.status()["case_id"]
    assert client.get(f"/api/v1/cases/{cid}/summary").json()["event_count"] == 0
    assert client.post("/api/v1/usb-sensor/start", json={"name": "Duplicate click"}).json()["case_id"] == cid
    assert client.get("/api/v1/cases").json()["total"] == 1
    board.frames.put(sample())
    wait_for(lambda: service.status()["state"] == "capturing")
    events = client.get(f"/api/v1/cases/{cid}/events").json()["items"]
    assert len(events) == 1
    assert events[0]["raw_record"]["metrics"] == {
        "temperature_c": 29.25, "humidity_pct": 58.5, "timestamp_source": "host_received_utc", "capture_transport": "usb"}
    stopped = client.post("/api/v1/usb-sensor/stop").json()
    assert stopped["state"] == "stopped"
    assert service.phase3.get_live_session(stopped["session_id"])["status"] == "completed"
    assert not board.is_open
    assert client.get(f"/api/v1/cases/{cid}/summary").json()["event_count"] == 1


def test_switching_case_installs_if_needed_and_disconnect_preserves_evidence(client, setup, monkeypatch):
    service, board = setup
    old = client.post("/api/v1/cases", json={"name": "Earlier case"}).json()["id"]
    target = client.post("/api/v1/cases", json={"name": "Selected case"}).json()["id"]
    previous = service.phase3.start_live_session(old, "Existing capture", [service.SOURCE], 30, None)
    replies = iter([False, True])
    monkeypatch.setattr(service, "_hello", lambda connection: next(replies))
    flashed = []
    monkeypatch.setattr(service, "_flash", lambda port: flashed.append(port))
    # Each open normally returns a new serial handle after flashing.
    monkeypatch.setattr(service, "_open", lambda port: (setattr(board, "is_open", True) or board))
    client.post("/api/v1/usb-sensor/start", json={"case_id": target})
    wait_for(lambda: service.status()["state"] == "waiting")
    assert flashed == ["COM7"]
    assert service.phase3.get_live_session(previous["session_id"])["status"] == "completed"
    assert service.status()["case_id"] == target
    board.frames.put(sample())
    wait_for(lambda: service.status()["state"] == "capturing")
    board.frames.put(serial.SerialException("unplugged"))
    wait_for(lambda: service.status()["state"] == "error")
    wait_for(lambda: not service.thread.is_alive())
    assert service.phase3.get_live_session(service.status()["session_id"])["status"] == "completed"
    assert client.get("/api/v1/cases").json()["total"] == 2
    assert client.get(f"/api/v1/cases/{target}/summary").json()["event_count"] == 1


def test_no_board_or_ambiguous_board_creates_no_case(client, setup, monkeypatch):
    service, _ = setup
    for ports in ([], [{"port": "COM7"}, {"port": "COM8"}]):
        monkeypatch.setattr(service, "ports", lambda: ports)
        assert client.post("/api/v1/usb-sensor/start", json={}).status_code == 409
    assert client.get("/api/v1/cases").json()["total"] == 0


@pytest.mark.parametrize("changes", [{"temperature_c": float("nan")}, {"humidity_pct": 101}, {"sequence": True}, {"sequence": 0}, {"temperature_c": "29"}])
def test_rejects_invalid_sensor_frames(changes):
    with pytest.raises(ValueError):
        UsbSensorSetup.telemetry({**sample(), **changes}, 1)


def test_usb_control_requires_local_dashboard(client):
    with pytest.raises(HTTPException):
        manager(SimpleNamespace(client=SimpleNamespace(host="192.0.2.5")))
    assert client.post("/api/v1/usb-sensor/start", json={}, headers={"Origin": "https://untrusted.test"}).status_code == 403
