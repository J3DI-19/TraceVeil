import asyncio
import csv
import io
import os
from pathlib import Path
import shutil
import subprocess
from urllib.parse import urlparse

import httpx

from app.core.config import Settings

OLLAMA_THINKING_ENABLED = False
OLLAMA_TEMPERATURE = 0
OLLAMA_MAX_OUTPUT_TOKENS = 256
OLLAMA_GROUNDING_CONTEXT_BYTES = 8 * 1024
OLLAMA_REQUEST_CONTEXT_TOKENS = 8 * 1024
OLLAMA_KEEP_ALIVE = "15m"
_managed_ollama_process: subprocess.Popen | None = None


def ollama_executable() -> str | None:
    discovered = shutil.which("ollama")
    if discovered:
        return discovered
    if os.name == "nt":
        local_app_data = os.environ.get("LOCALAPPDATA")
        if local_app_data:
            candidate = Path(local_app_data) / "Programs" / "Ollama" / "ollama.exe"
            try:
                if candidate.is_file():
                    return str(candidate)
            except OSError:
                # Health reporting must not fail just because this process
                # cannot inspect the user's Ollama installation directory.
                pass
    return None


async def ollama_server_available(settings: Settings) -> bool:
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            response = await client.get(f"{settings.ollama_base_url.rstrip('/')}/api/tags")
            response.raise_for_status()
        return True
    except httpx.HTTPError:
        return False


def _windows_ollama_pid(settings: Settings) -> int | None:
    parsed = urlparse(settings.ollama_base_url)
    port = parsed.port or 11434
    netstat = subprocess.run(
        ["netstat", "-ano", "-p", "tcp"],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    for line in netstat.stdout.splitlines():
        columns = line.split()
        if len(columns) >= 5 and columns[0].upper() == "TCP" and columns[3].upper() == "LISTENING":
            if columns[1].rsplit(":", 1)[-1] == str(port) and columns[4].isdigit():
                return int(columns[4])
    return None


def _stop_ollama_process(settings: Settings) -> None:
    global _managed_ollama_process
    if os.name == "nt":
        pid = _windows_ollama_pid(settings)
        if pid is None:
            return
        listing = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        rows = list(csv.reader(io.StringIO(listing.stdout)))
        if not rows or Path(rows[0][0]).name.lower() != "ollama.exe":
            raise ValueError("ollama_runtime_owner_mismatch")
        stopped = subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if stopped.returncode != 0:
            raise ValueError("ollama_stop_failed")
        return
    if _managed_ollama_process is None or _managed_ollama_process.poll() is not None:
        raise ValueError("ollama_stop_requires_managed_process")
    _managed_ollama_process.terminate()
    _managed_ollama_process = None


async def set_ollama_server_running(settings: Settings, running: bool) -> None:
    global _managed_ollama_process
    available = await ollama_server_available(settings)
    if running and not available:
        executable = ollama_executable()
        if not executable:
            raise ValueError("ollama_executable_not_found")
        creation_flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        _managed_ollama_process = subprocess.Popen(
            [executable, "serve"],
            cwd=str(Path(executable).parent),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creation_flags,
        )
    elif not running and available:
        await asyncio.to_thread(_stop_ollama_process, settings)

    for _ in range(40):
        if await ollama_server_available(settings) is running:
            return
        await asyncio.sleep(0.25)
    raise ValueError("ollama_start_failed" if running else "ollama_stop_failed")


async def ollama_status(settings: Settings, *, enabled: bool = True) -> dict[str, object]:
    base_url = settings.ollama_base_url.rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=min(5.0, settings.ollama_timeout_seconds)) as client:
            tags_response = await client.get(f"{base_url}/api/tags")
            tags_response.raise_for_status()
            models = tags_response.json().get("models", [])
    except (httpx.HTTPError, ValueError, TypeError):
        return {
            "enabled": enabled,
            "available": False,
            "server_running": False,
            "server_control_supported": ollama_executable() is not None,
            "ready": False,
            "model": settings.ollama_model,
            "model_installed": False,
            "model_loaded": False,
            "provider": "Local Ollama",
            "thinking_enabled": OLLAMA_THINKING_ENABLED,
            "temperature": OLLAMA_TEMPERATURE,
            "max_output_tokens": OLLAMA_MAX_OUTPUT_TOKENS,
            "grounding_context_limit_bytes": OLLAMA_GROUNDING_CONTEXT_BYTES,
            "request_context_length": OLLAMA_REQUEST_CONTEXT_TOKENS,
            "keep_alive": OLLAMA_KEEP_ALIVE,
            "generation_timeout_seconds": settings.ollama_timeout_seconds,
        }

    selected = next(
        (
            model
            for model in models
            if isinstance(model, dict)
            and (model.get("name") == settings.ollama_model or model.get("model") == settings.ollama_model)
        ),
        None,
    )
    details = selected.get("details", {}) if isinstance(selected, dict) else {}
    show: dict[str, object] = {}
    if selected is not None:
        try:
            async with httpx.AsyncClient(timeout=min(5.0, settings.ollama_timeout_seconds)) as client:
                show_response = await client.post(f"{base_url}/api/show", json={"model": settings.ollama_model})
                show_response.raise_for_status()
                show = show_response.json()
        except (httpx.HTTPError, ValueError, TypeError):
            show = {}
    show_details = show.get("details", {}) if isinstance(show.get("details"), dict) else {}
    model_info = show.get("model_info", {}) if isinstance(show.get("model_info"), dict) else {}
    architecture = model_info.get("general.architecture")
    context_key = f"{architecture}.context_length" if architecture else "general.context_length"
    loaded = None
    try:
        async with httpx.AsyncClient(timeout=min(5.0, settings.ollama_timeout_seconds)) as client:
            ps_response = await client.get(f"{base_url}/api/ps")
            ps_response.raise_for_status()
            running = ps_response.json().get("models", [])
            loaded = next(
                (
                    model
                    for model in running
                    if isinstance(model, dict)
                    and (model.get("name") == settings.ollama_model or model.get("model") == settings.ollama_model)
                ),
                None,
            )
    except (httpx.HTTPError, ValueError, TypeError):
        loaded = None

    installed = selected is not None
    return {
        "enabled": enabled,
        "available": True,
        "server_running": True,
        "server_control_supported": ollama_executable() is not None,
        "ready": enabled and installed,
        "model": settings.ollama_model,
        "model_installed": installed,
        "model_loaded": loaded is not None,
        "provider": "Local Ollama",
        "family": show_details.get("family") or details.get("family"),
        "parameter_size": show_details.get("parameter_size") or details.get("parameter_size"),
        "quantization_level": show_details.get("quantization_level") or details.get("quantization_level"),
        "size_bytes": selected.get("size") if selected else None,
        "max_context_length": model_info.get(context_key) or model_info.get("general.context_length"),
        "active_context_length": loaded.get("context_length") if loaded else None,
        "size_vram_bytes": loaded.get("size_vram") if loaded else None,
        "expires_at": loaded.get("expires_at") if loaded else None,
        "capabilities": show.get("capabilities") or selected.get("capabilities", []),
        "thinking_enabled": OLLAMA_THINKING_ENABLED,
        "temperature": OLLAMA_TEMPERATURE,
        "max_output_tokens": OLLAMA_MAX_OUTPUT_TOKENS,
        "grounding_context_limit_bytes": OLLAMA_GROUNDING_CONTEXT_BYTES,
        "request_context_length": OLLAMA_REQUEST_CONTEXT_TOKENS,
        "keep_alive": OLLAMA_KEEP_ALIVE,
        "generation_timeout_seconds": settings.ollama_timeout_seconds,
    }
