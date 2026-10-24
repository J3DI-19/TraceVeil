from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from app.core.errors import DatabaseUnavailableError

router = APIRouter(prefix="/usb-sensor", tags=["usb-sensor"])


class UsbSetupBody(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    case_id: int | None = Field(default=None, ge=1)
    name: str = Field(default="ESP32 DHT22 USB capture", min_length=1, max_length=200)
    port: str | None = Field(default=None, min_length=1, max_length=80)


class UsbStatus(BaseModel):
    state: Literal["idle", "connecting", "flashing", "waiting", "capturing", "stopped", "error"]
    message: str
    port: str | None
    case_id: int | None
    session_id: str | None
    last_reading_at: str | None
    readings: int


class UsbPort(BaseModel):
    port: str
    description: str


class UsbPorts(BaseModel):
    items: list[UsbPort]


def manager(request: Request):
    if not request.client or request.client.host not in {"127.0.0.1", "::1", "testclient"}:
        raise HTTPException(403, "USB setup is only available on this computer.")
    setup = request.app.state.usb_sensor
    if setup is None:
        raise DatabaseUnavailableError()
    origin = request.headers.get("origin")
    if origin and origin not in setup.phase3.settings.frontend_origins:
        raise HTTPException(403, "USB setup requires the local dashboard.")
    return setup


@router.get("/ports")
def ports(request: Request) -> UsbPorts:
    return {"items": manager(request).ports()}


@router.get("/status")
def status(request: Request) -> UsbStatus:
    return manager(request).status()


@router.post("/start", status_code=202)
def start(body: UsbSetupBody, request: Request) -> UsbStatus:
    return manager(request).start(body.case_id, body.name, body.port)


@router.post("/stop")
def stop(request: Request) -> UsbStatus:
    return manager(request).stop()
