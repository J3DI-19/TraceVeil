from fastapi import APIRouter, Request
from pydantic import BaseModel

from app.core.config import get_settings
from app.core.errors import DatabaseUnavailableError
from app.services.ollama import ollama_status, set_ollama_server_running

router = APIRouter(tags=["health"])


class AiControlUpdate(BaseModel):
    enabled: bool


class OllamaServerUpdate(BaseModel):
    running: bool


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "api"}


@router.get("/health/db")
async def database_health(request: Request) -> dict[str, object]:
    repository = request.app.state.repository
    available = repository.is_available()
    result = {"status": "ok" if available else "unavailable", "service": "database"}
    if not available:
        result["message"] = "The evidence database is unavailable."
    return result


async def current_ai_status(request: Request) -> dict[str, object]:
    phase3 = request.app.state.phase3_service
    enabled = phase3.ai_enabled() if phase3 is not None else True
    return {"service": "ollama", **await ollama_status(get_settings(), enabled=enabled)}


@router.get("/health/ai")
async def ai_health(request: Request) -> dict[str, object]:
    return await current_ai_status(request)


@router.patch("/health/ai")
async def update_ai_control(body: AiControlUpdate, request: Request) -> dict[str, object]:
    phase3 = request.app.state.phase3_service
    if phase3 is None:
        raise DatabaseUnavailableError()
    phase3.set_ai_enabled(body.enabled)
    return await current_ai_status(request)


@router.patch("/health/ai/server")
async def update_ollama_server(body: OllamaServerUpdate, request: Request) -> dict[str, object]:
    await set_ollama_server_running(get_settings(), body.running)
    return await current_ai_status(request)
