"""Runtime configuration. All values come from the environment (see .env.example).

Secrets (AI_API_KEY, EMBEDDING_API_KEY) are server-only and never serialized into
responses, logs or readiness output.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    database_url: str = "postgresql+psycopg://smartcity:smartcity@localhost:5433/smartcity"
    public_app_url: str = "http://localhost:3000"
    cors_origins: str = "http://localhost:3000"

    ai_provider: Literal["ollama", "openai_compatible", "none"] = "ollama"
    ai_base_url: str = "http://localhost:11434"
    ai_api_key: SecretStr = SecretStr("")
    ai_model: str = "qwen2.5:3b"
    ai_timeout_seconds: float = 120.0
    ai_max_output_tokens: int = 700
    ai_temperature: float = 0.2

    embedding_provider: Literal["ollama", "openai_compatible", "none"] = "ollama"
    embedding_base_url: str = "http://localhost:11434"
    embedding_api_key: SecretStr = SecretStr("")
    embedding_model: str = "bge-m3"
    embedding_timeout_seconds: float = 30.0

    osm_source_url: str = "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
    coverage_config: Path = REPO_ROOT / "config" / "coverage.geojson"
    ingest_contact_user_agent: str = "SmartCity-prototype/0.1 (hackathon demo; bounded Astana extract)"

    routing_provider: Literal["none", "valhalla"] = "none"
    routing_base_url: str = ""

    log_level: str = "INFO"
    request_timeout_seconds: float = 150.0
    rate_limit: str = "20/minute"
    data_dir: Path = REPO_ROOT / "data"

    # Walking model used when no real router is configured (documented in docs/ADR-0001).
    walking_speed_m_per_min: float = Field(default=66.7, gt=0)  # 4.0 km/h, conservative
    straight_line_detour_factor: float = Field(default=1.3, ge=1.0)


@lru_cache
def get_settings() -> Settings:
    return Settings()
