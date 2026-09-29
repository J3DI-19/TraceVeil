from functools import lru_cache
from pathlib import Path
from typing import Annotated

import json

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


ENV_PATH = Path(__file__).resolve().parents[2] / ".env"


class Settings(BaseSettings):
    app_name: str = "Traceveil"
    environment: str = "development"
    api_prefix: str = "/api/v1"
    database_url: str = "sqlite:///./data/traceveil.db"
    # NoDecode: pydantic-settings 2.6+ tries json.loads on list/dict env
    # vars BEFORE mode="before" validators run, which breaks the
    # comma-separated shape used in .env. NoDecode hands the raw string
    # to parse_frontend_origins unchanged.
    frontend_origins: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["http://localhost:5173", "http://127.0.0.1:5173"]
    )
    ollama_base_url: str = "http://127.0.0.1:11434"
    ollama_model: str = "qwen9b-q4_k_m"
    ollama_timeout_seconds: float = Field(default=2.0, gt=0)
    max_evidence_file_bytes: int = Field(default=50 * 1024 * 1024, gt=0)
    max_validation_issues: int = Field(default=100, gt=0)
    evidence_storage_path: str = "./data/evidence"
    report_storage_path: str = "./data/reports"
    live_source_tokens: dict[str, str] = Field(default_factory=dict)
    live_queue_size: int = Field(default=2048, ge=1, le=10000)
    live_rate_limit_per_second: int = Field(default=30, ge=1, le=1000)
    live_max_payload_bytes: int = Field(default=64 * 1024, ge=1024, le=1024 * 1024)
    live_stream_retention: int = Field(default=10000, ge=100, le=100000)
    live_stream_retention_hours: int = Field(default=24, ge=1, le=168)
    live_device_stale_seconds: int = Field(default=30, ge=5, le=300)
    # TV5-12: cap on audit rows emitted per (source_id or client IP) per
    # minute for live-endpoint authentication failures. Bounds the audit
    # table under a brute-force flood while still recording the first
    # rejection from each source/IP.
    live_auth_failure_audit_per_minute: int = Field(default=6, ge=1, le=60)
    smtp_host: str | None = None
    smtp_port: int = Field(default=587, ge=1, le=65535)
    smtp_starttls: bool = True
    smtp_username: str | None = None
    smtp_password: str | None = None
    smtp_from_address: str | None = None
    smtp_allowed_recipient_domains: Annotated[list[str], NoDecode] = Field(default_factory=list)

    model_config = SettingsConfigDict(env_file=ENV_PATH, extra="ignore", case_sensitive=False)

    @field_validator("frontend_origins", mode="before")
    @classmethod
    def parse_frontend_origins(cls, value: object) -> object:
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        return value

    @field_validator("live_source_tokens", mode="before")
    @classmethod
    def parse_live_tokens(cls, value: object) -> object:
        return json.loads(value) if isinstance(value, str) else value

    @field_validator("smtp_allowed_recipient_domains", mode="before")
    @classmethod
    def parse_recipient_domains(cls, value: object) -> object:
        if isinstance(value, str):
            return [item.strip().lower() for item in value.split(",") if item.strip()]
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()
