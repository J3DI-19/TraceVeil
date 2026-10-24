"""Local USB provisioning and capture; serial data uses normal evidence ingestion."""
from __future__ import annotations

import json
import math
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from threading import Event, RLock, Thread

import serial
from serial.tools import list_ports

from app.evidence.schemas import LiveTelemetryInput


class UsbSensorSetup:
    SOURCE = "esp32-lab-01"
    PROTOCOL = "traceveil-usb-v1"

    def __init__(self, phase3, root: Path | None = None):
        self.phase3 = phase3
        self.root = root or Path(__file__).resolve().parents[3]
        self.lock = RLock()
        self.cancel = Event()
        self.thread: Thread | None = None
        self.state = {"state": "idle", "message": "Connect your ESP32 with a USB data cable.",
                      "port": None, "case_id": None, "session_id": None,
                      "last_reading_at": None, "readings": 0}

    def ports(self):
        return [{"port": p.device, "description": p.description}
                for p in list_ports.comports() if (p.vid, p.pid) == (0x10C4, 0xEA60)]

    def status(self):
        with self.lock:
            return dict(self.state)

    def update(self, **values):
        with self.lock:
            self.state.update(values)

    def start(self, case_id: int | None, name: str, port: str | None):
        with self.lock:
            if self.thread and self.thread.is_alive():
                # A repeated click never creates another case or capture.
                return self.status()
            candidates = self.ports()
            if port and not any(p["port"] == port for p in candidates):
                raise ValueError("USB board not found. Reconnect its data cable and try again.")
            if not port:
                if len(candidates) != 1:
                    raise ValueError("Connect one ESP32 USB board, or select its port if several are attached.")
                port = candidates[0]["port"]
            if not self.phase3.settings.live_source_tokens.get(self.SOURCE):
                raise ValueError("The local ESP32 source is not configured. Set up esp32-lab-01 first.")
            if case_id:
                self.phase3.batch.get_case(case_id)
            self.cancel.clear()
            self.state = {"state": "connecting", "message": "Checking the connected ESP32…", "port": port,
                          "case_id": case_id, "session_id": None, "last_reading_at": None, "readings": 0}
            self.thread = Thread(target=self._run, args=(port, case_id, name), name="traceveil-usb-sensor", daemon=True)
            self.thread.start()
            return self.status()

    def stop(self):
        self.cancel.set()
        if self.thread:
            self.thread.join(timeout=5)
        return self.status()

    def _open(self, port):
        # Avoid resetting the ESP32 whenever the dashboard reconnects.
        connection = serial.Serial(port=None, baudrate=115200, timeout=0.5, write_timeout=2)
        connection.dtr = False
        connection.rts = False
        connection.port = port
        connection.open()
        return connection

    def _hello(self, connection):
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline and not self.cancel.is_set():
            connection.write(b"HELLO\n")
            frame = self._read(connection)
            if frame.get("protocol") == self.PROTOCOL and frame.get("type") == "hello":
                return True
        return False

    @staticmethod
    def _read(connection):
        line = connection.readline(1024)
        try:
            frame = json.loads(line)
            return frame if isinstance(frame, dict) else {}
        except (ValueError, UnicodeError):
            return {}

    def _flash(self, port):
        self.update(state="flashing", message="Installing USB sensor firmware. Keep the board plugged in…")
        arduino = self.root / ".runtime/arduino"
        executable = arduino / "arduino-cli.exe"
        config = arduino / "arduino-cli.yaml"
        sketch = self.root / "hardware/esp32/traceveil_usb_sensor"
        build = arduino / "build-usb-sensor"
        if not executable.exists() or not config.exists():
            raise ValueError("Local ESP32 compiler is missing. Restore the prepared .runtime/arduino tools.")
        build.mkdir(parents=True, exist_ok=True)
        binary = build / "traceveil_usb_sensor.ino.bin"
        prefix = [str(executable), "--config-file", str(config)]
        if not binary.exists() or binary.stat().st_mtime < (sketch / "traceveil_usb_sensor.ino").stat().st_mtime:
            self._command(prefix + ["compile", "--fqbn", "esp32:esp32:esp32", "--build-path", str(build), str(sketch)], 240)
        if not self.cancel.is_set():
            self._command(prefix + ["upload", "--fqbn", "esp32:esp32:esp32", "--port", port, "--input-dir", str(build), str(sketch)], 90)

    def _command(self, command, timeout):
        # Fixed executable and arguments, never a user-supplied shell command.
        result = subprocess.run(command, cwd=self.root, capture_output=True, timeout=timeout,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if result.returncode:
            raise ValueError("Firmware installation failed. Close any serial monitor; if connecting fails, hold BOOT briefly and retry.")

    @staticmethod
    def telemetry(frame, case_id):
        if frame.get("protocol") != UsbSensorSetup.PROTOCOL or frame.get("type") != "sample":
            raise ValueError("Unexpected USB sensor frame.")
        sequence = frame.get("sequence")
        if type(sequence) is not int or sequence < 1:
            raise ValueError("Invalid sensor sequence.")
        for key, low, high in (("temperature_c", -40, 80), ("humidity_pct", 0, 100)):
            value = frame.get(key)
            if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high:
                raise ValueError("Invalid DHT22 reading. Check the sensor and wiring.")
        return LiveTelemetryInput(schema_version="1.0", case_id=case_id, source_id=UsbSensorSetup.SOURCE,
                                  device_id="esp32-lab-01", event_type="telemetry", sequence=sequence,
                                  observed_at=datetime.now(timezone.utc),
                                  metrics={"temperature_c": frame["temperature_c"], "humidity_pct": frame["humidity_pct"],
                                           "capture_transport": "usb", "timestamp_source": "host_received_utc"})

    def _session(self, case_id):
        # The physical source can be attached to only one active case.
        rows = self.phase3.db.execute("SELECT session_id,case_id,source_ids_json FROM live_sessions WHERE status='active'").fetchall()
        selected = None
        for row in rows:
            if self.SOURCE in json.loads(row["source_ids_json"]):
                if row["case_id"] == case_id:
                    selected = self.phase3.get_live_session(row["session_id"])
                else:
                    self.phase3.stop_live_session(row["session_id"], None)
        return selected or self.phase3.start_live_session(case_id, "USB DHT22 capture", [self.SOURCE], 15, None)

    def _run(self, port, case_id, name):
        connection = None
        session_id = None
        try:
            connection = self._open(port)
            if not self._hello(connection):
                connection.close()
                self._flash(port)
                if self.cancel.is_set():
                    return
                connection = self._open(port)
                if not self._hello(connection):
                    raise ValueError("ESP32 did not respond after installation. Unplug USB, reconnect and retry.")
            if self.cancel.is_set():
                return
            # Do not create a case or move an active source until a real board responds.
            if case_id is None:
                case_id = self.phase3.batch.create_case(name, "DHT22 readings captured over USB. Times are laptop receipt times in UTC.", "Local investigator")["id"]
            session = self._session(case_id)
            session_id = session["session_id"]
            self.update(state="waiting", message="ESP32 connected. Waiting for the first DHT22 reading…", case_id=case_id, session_id=session_id)
            self.phase3.audit(case_id, "usb.capture_started", "live_session", session_id, details={"port": port})
            connection.write(b"START\n")
            last_sample = time.monotonic()
            while not self.cancel.is_set():
                if self.phase3.get_live_session(session_id)["status"] != "active":
                    break
                frame = self._read(connection)
                if frame.get("type") == "error":
                    raise ValueError("DHT22 is not responding. Check + to 3V3, − to GND and OUT to GPIO 4, then retry.")
                if frame.get("type") != "sample":
                    if time.monotonic() - last_sample > 15:
                        raise ValueError("No sensor readings arrived for 15 seconds. Reconnect USB and check the DHT22 wiring.")
                    continue
                telemetry = self.telemetry(frame, case_id)
                receipt = self.phase3.submit_live(telemetry, self.phase3.settings.live_source_tokens[self.SOURCE], None)
                if not self.status()["readings"]:
                    deadline = time.monotonic() + 15
                    while not self.cancel.is_set():
                        saved = self.phase3.get_live_receipt(receipt["receipt_id"])
                        if saved["status"] == "completed":
                            break
                        if saved["status"] in {"failed", "rejected", "cancelled"} or time.monotonic() > deadline:
                            raise ValueError("Sensor connected, but its first reading could not be saved. Retry setup.")
                        self.cancel.wait(0.1)
                if self.cancel.is_set():
                    break
                last_sample = time.monotonic()
                self.update(state="capturing", message="USB sensor connected · readings are being saved.",
                            last_reading_at=telemetry.observed_at.isoformat(), readings=self.status()["readings"] + 1)
        except serial.SerialException:
            self.update(state="error", message="USB connection lost or busy. Reconnect the board and close any serial monitor, then retry.")
        except Exception as error:
            message = str(error) if isinstance(error, ValueError) else "Sensor setup failed. Reconnect USB and retry."
            self.update(state="error", message=message)
        finally:
            if connection and connection.is_open:
                try:
                    connection.write(b"STOP\n")
                except (serial.SerialException, OSError):
                    pass
                connection.close()
            if session_id:
                try:
                    if self.phase3.get_live_session(session_id)["status"] == "active":
                        self.phase3.stop_live_session(session_id, None)
                except (KeyError, ValueError):
                    pass
            if self.status()["state"] != "error":
                self.update(state="stopped", message="USB capture stopped. Saved readings remain in the case.")
