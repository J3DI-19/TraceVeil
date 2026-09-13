import httpx
import sqlite3
import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings, get_settings
from app.db.sqlite import SQLiteRepository
from app.main import create_app
from app.services import ollama as ollama_service
from app.api import health as health_api


def test_api_health(client):
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "api"}


def test_database_health(client):
    response = client.get("/api/v1/health/db")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "database"}


def test_database_startup_failure_keeps_health_available(monkeypatch, tmp_path):
    get_settings.cache_clear()
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'unavailable.db'}")
    monkeypatch.setattr(
        SQLiteRepository,
        "initialize",
        lambda self: (_ for _ in ()).throw(sqlite3.OperationalError("cannot open database")),
    )

    with TestClient(create_app()) as degraded:
        assert degraded.get("/api/v1/health").json() == {"status": "ok", "service": "api"}
        database = degraded.get("/api/v1/health/db")
        assert database.status_code == 200
        assert database.json() == {
            "status": "unavailable",
            "service": "database",
            "message": "The evidence database is unavailable.",
        }
        for path in ("/api/v1/cases", "/api/v1/imports/00000000-0000-4000-8000-000000000000"):
            response = degraded.get(path)
            assert response.status_code == 503
            assert response.json()["code"] == "database_unavailable"
            assert response.json()["retryable"] is True
            assert response.json()["request_id"]
            assert response.headers["x-request-id"] == response.json()["request_id"]
    get_settings.cache_clear()


def test_invalid_database_scheme_still_fails_startup(monkeypatch):
    get_settings.cache_clear()
    monkeypatch.setenv("DATABASE_URL", "postgresql://localhost/traceveil")
    with pytest.raises(ValueError, match="sqlite"):
        with TestClient(create_app()):
            pass
    get_settings.cache_clear()


def test_ollama_offline_is_degraded_not_failed(client):
    response = client.get("/api/v1/health/ai")
    assert response.status_code == 200
    assert response.json()["available"] is False


def test_ollama_online_reports_installed_model(monkeypatch):
    class MockAsyncClient:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, url):
            request = httpx.Request("GET", url)
            if url.endswith("/api/ps"):
                return httpx.Response(
                    200,
                    request=request,
                    json={"models": [{"name": "qwen9b-q4_k_m", "context_length": 32768, "size_vram": 6_000_000_000}]},
                )
            return httpx.Response(
                200,
                request=request,
                json={"models": [{"name": "qwen9b-q4_k_m", "size": 6_200_000_000}]},
            )

        async def post(self, url, json):
            request = httpx.Request("POST", url)
            return httpx.Response(
                200,
                request=request,
                json={
                    "details": {"family": "qwen3", "parameter_size": "10.7B", "quantization_level": "Q4_K_M"},
                    "model_info": {"general.architecture": "qwen35", "qwen35.context_length": 262144},
                    "capabilities": ["completion", "tools", "thinking"],
                },
            )

    monkeypatch.setattr(ollama_service.httpx, "AsyncClient", MockAsyncClient)
    settings = Settings(ollama_model="qwen9b-q4_k_m")
    result = __import__("asyncio").run(ollama_service.ollama_status(settings))
    assert result["available"] is True
    assert result["enabled"] is True
    assert result["ready"] is True
    assert result["model_installed"] is True
    assert result["model_loaded"] is True
    assert result["family"] == "qwen3"
    assert result["parameter_size"] == "10.7B"
    assert result["quantization_level"] == "Q4_K_M"
    assert result["max_context_length"] == 262144
    assert result["active_context_length"] == 32768
    assert result["thinking_enabled"] is False
    assert result["max_output_tokens"] == 256
    assert result["grounding_context_limit_bytes"] == 8 * 1024
    assert result["request_context_length"] == 8 * 1024
    assert result["keep_alive"] == "15m"


def test_ai_control_persists_and_is_reported(client):
    disabled = client.patch("/api/v1/health/ai", json={"enabled": False})
    assert disabled.status_code == 200
    assert disabled.json()["enabled"] is False
    assert disabled.json()["ready"] is False
    assert client.get("/api/v1/health/ai").json()["enabled"] is False

    enabled = client.patch("/api/v1/health/ai", json={"enabled": True})
    assert enabled.status_code == 200
    assert enabled.json()["enabled"] is True


def test_ollama_server_control_endpoint(client, monkeypatch):
    requested = []

    async def fake_control(settings, running):
        requested.append(running)

    monkeypatch.setattr(health_api, "set_ollama_server_running", fake_control)
    response = client.patch("/api/v1/health/ai/server", json={"running": True})
    assert response.status_code == 200
    assert requested == [True]


def test_ollama_server_controller_starts_and_stops(monkeypatch):
    settings = Settings(ollama_base_url="http://127.0.0.1:11434")
    state = {"running": False}
    launched = []
    stopped = []

    async def available(_settings):
        return state["running"]

    class FakeProcess:
        pass

    def fake_popen(*args, **kwargs):
        launched.append((args, kwargs))
        state["running"] = True
        return FakeProcess()

    def fake_stop(_settings):
        stopped.append(True)
        state["running"] = False

    monkeypatch.setattr(ollama_service, "ollama_server_available", available)
    monkeypatch.setattr(ollama_service, "ollama_executable", lambda: "C:/Ollama/ollama.exe")
    monkeypatch.setattr(ollama_service.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(ollama_service, "_stop_ollama_process", fake_stop)

    __import__("asyncio").run(ollama_service.set_ollama_server_running(settings, True))
    assert launched[0][0][0] == ["C:/Ollama/ollama.exe", "serve"]
    __import__("asyncio").run(ollama_service.set_ollama_server_running(settings, False))
    assert stopped == [True]
