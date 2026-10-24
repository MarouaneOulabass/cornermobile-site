"""Application settings. Every secret comes from the environment, never from code."""

from __future__ import annotations

import secrets
import warnings
from functools import lru_cache
from pathlib import Path

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="AUDITFLOW_", extra="ignore")

    env: str = "dev"  # dev | test | prod
    database_url: str = "postgresql+psycopg://auditflow:auditflow@localhost:5432/auditflow"
    secret_key: str = ""
    access_token_minutes: int = 12 * 60
    cookie_secure: bool = False

    # Object storage: "local" (filesystem) or "s3" (any S3-compatible endpoint, e.g. MinIO).
    storage_backend: str = "local"
    storage_dir: Path = REPO_ROOT / "var" / "storage"
    s3_endpoint_url: str | None = None
    s3_bucket: str = "auditflow"
    s3_access_key: str | None = None
    s3_secret_key: str | None = None
    s3_region: str = "us-east-1"

    # Jobs: "inline" runs jobs in-process (tests, local dev); "rq" dispatches to Redis workers.
    job_backend: str = "inline"
    redis_url: str = "redis://localhost:6379/0"

    # AI layer (provider-agnostic). "none" = deterministic heuristics only.
    llm_provider: str = "none"
    llm_model: str = "claude-opus-5-5"
    anthropic_api_key: str | None = None
    llm_redact_pii: bool = True

    max_upload_mb: int = 50
    max_files_per_upload: int = 500
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:3000"])
    demo_data_dir: Path = REPO_ROOT / "demo-data"

    @model_validator(mode="after")
    def _secret(self) -> Settings:
        if not self.secret_key:
            if self.env == "prod":
                raise ValueError("AUDITFLOW_SECRET_KEY must be set in production")
            warnings.warn("AUDITFLOW_SECRET_KEY not set: using an ephemeral key", stacklevel=2)
            self.secret_key = secrets.token_urlsafe(48)
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
