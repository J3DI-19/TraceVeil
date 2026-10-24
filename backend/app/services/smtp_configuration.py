"""Local SMTP configuration, persisted alongside the other server settings."""

import json
import os
import re
import tempfile
from pathlib import Path
from threading import Lock

from app.core.config import Settings


SMTP_FIELDS = (
    "smtp_host", "smtp_port", "smtp_starttls", "smtp_username", "smtp_password",
    "smtp_from_address", "smtp_allowed_recipient_domains",
)
_write_lock = Lock()


def public_smtp_configuration(settings: Settings) -> dict:
    return {
        "host": settings.smtp_host or "",
        "port": settings.smtp_port,
        "starttls": settings.smtp_starttls,
        "username": settings.smtp_username or "",
        "password_set": bool(settings.smtp_password),
        "from_address": settings.smtp_from_address or "",
        "allowed_recipient_domains": settings.smtp_allowed_recipient_domains,
        "configured": bool(
            settings.smtp_host and settings.smtp_from_address
            and settings.smtp_allowed_recipient_domains
            and (not settings.smtp_username or settings.smtp_password)
        ),
    }


def save_smtp_configuration(settings: Settings, env_path: Path, values: dict) -> dict:
    """Write one atomic .env update, then apply it to the live Settings object."""
    if any(key.upper() in os.environ for key in SMTP_FIELDS):
        raise ValueError("smtp_environment_override")

    next_values = {
        "smtp_host": values["host"].strip(),
        "smtp_port": values["port"],
        "smtp_starttls": values["starttls"],
        "smtp_username": values["username"].strip(),
        "smtp_password": "" if values["clear_password"] else (
            values["password"] if values["password"] is not None else settings.smtp_password or ""
        ),
        "smtp_from_address": values["from_address"].strip(),
        "smtp_allowed_recipient_domains": values["allowed_recipient_domains"],
    }
    encoded = {
        key.upper(): json.dumps(",".join(value) if isinstance(value, list) else value, ensure_ascii=False)
        for key, value in next_values.items()
    }
    path = env_path.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    with _write_lock:
        original = path.read_text(encoding="utf-8") if path.exists() else ""
        kept = [line for line in original.splitlines() if not re.match(r"^\s*SMTP_[A-Z_]+\s*=", line)]
        candidate = "\n".join([*kept, *(f"{key}={value}" for key, value in encoded.items())]) + "\n"
        descriptor, temporary_name = tempfile.mkstemp(prefix=".smtp-", suffix=".env", dir=path.parent)
        temporary = Path(temporary_name)
        try:
            os.chmod(temporary, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as output:
                output.write(candidate)
            try:
                parsed = Settings(_env_file=temporary)
                if any(getattr(parsed, key) != value for key, value in next_values.items()):
                    raise ValueError("smtp_configuration_invalid")
            except Exception:
                raise ValueError("smtp_configuration_invalid") from None
            os.replace(temporary, path)
            for key, value in next_values.items():
                setattr(settings, key, value)
        finally:
            temporary.unlink(missing_ok=True)
    return public_smtp_configuration(settings)
