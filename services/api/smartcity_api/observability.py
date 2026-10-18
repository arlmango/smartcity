"""Structured JSON logging. Privacy: callers never pass raw query text or exact coordinates."""

from __future__ import annotations

import json
import logging
import sys
from datetime import UTC, datetime

_EXTRA_KEYS = (
    "event",
    "request_id",
    "method",
    "path",
    "status",
    "duration_ms",
    "client",
    "mode",
    "origin_rounded",
    "query_len",
    "budget_min",
    "shortlist",
    "ranked",
    "llm_candidate_ids",
    "result_ids",
    "semantic",
    "exclusions",
    "llm_attempts",
    "llm_failure",
    "llm_issues",
    "prompt_version",
    "timings_ms",
    "detail",
    "error",
)


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for k in _EXTRA_KEYS:
            if hasattr(record, k):
                payload[k] = getattr(record, k)
        if record.exc_info and record.exc_info[0] is not None:
            payload["exc_type"] = record.exc_info[0].__name__  # type only: no locals / request data
        return json.dumps(payload, ensure_ascii=False, default=str)


def configure_logging(level: str = "INFO") -> None:
    root = logging.getLogger("smartcity")
    if any(getattr(h, "_smartcity", False) for h in root.handlers):
        root.setLevel(level.upper())
        return
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    handler._smartcity = True  # type: ignore[attr-defined]
    root.addHandler(handler)
    root.setLevel(level.upper())
    root.propagate = False
