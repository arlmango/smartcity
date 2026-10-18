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
    ai_timeout_seconds: float = 150.0  # CPU generation measured 50-190 s under load
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
    request_timeout_seconds: float = 200.0
    rate_limit: str = "20/minute"  # POST /api/recommend, per client IP (in-memory)
    # Added by backend-rag: limits for other endpoints, body size, generation fan-in.
    rate_limit_general: str = "300/minute"  # other /api/* endpoints except health/ready
    trust_forwarded_for: bool = False  # use X-Forwarded-For only behind a trusted proxy (e.g. web)
    max_body_bytes: int = Field(default=32768, ge=1024, le=1_048_576)
    llm_max_candidates: int = Field(default=5, ge=1, le=8)  # candidates passed to the generator
    ai_query_interpretation: bool = False  # optional LLM query paraphrase (soft only); slow on CPU
    ai_interpretation_timeout_seconds: float = 30.0
    map_cache_max_age_seconds: int = 300
    data_dir: Path = REPO_ROOT / "data"

    # Walking model used when no real router is configured (documented in docs/ADR-0001).
    walking_speed_m_per_min: float = Field(default=66.7, gt=0)  # 4.0 km/h, conservative
    straight_line_detour_factor: float = Field(default=1.3, ge=1.0)


@lru_cache
def get_settings() -> Settings:
    return Settings()
