"""Pure ASGI middleware: request id + access log, body size limit, in-memory rate limiting.

Pure ASGI (not BaseHTTPMiddleware) so that client-disconnect detection keeps working for
long LLM calls. Access logs carry path only (no query string: it may contain search text or
coordinates).
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
import uuid
from collections import deque

from starlette.types import ASGIApp, Message, Receive, Scope, Send

log = logging.getLogger("smartcity.access")

_RATE_RE = re.compile(r"^\s*(\d+)\s*/\s*(second|minute|hour)\s*$")
_PERIODS = {"second": 1.0, "minute": 60.0, "hour": 3600.0}


def parse_rate(spec: str) -> tuple[int, float]:
    m = _RATE_RE.match(spec or "")
    if not m:
        raise ValueError(f"invalid rate limit spec: {spec!r} (expected N/second|minute|hour)")
    return int(m.group(1)), _PERIODS[m.group(2)]


class SlidingWindowLimiter:
    def __init__(self, spec: str, now=time.monotonic) -> None:
        self.limit, self.period = parse_rate(spec)
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()
        self._now = now
        self._last_sweep = now()

    def hit(self, key: str) -> tuple[bool, int]:
        """Returns (allowed, retry_after_seconds)."""
        now = self._now()
        with self._lock:
            if now - self._last_sweep > self.period * 2:
                for k in [k for k, q in self._hits.items() if not q or now - q[-1] > self.period]:
                    del self._hits[k]
                self._last_sweep = now
            q = self._hits.setdefault(key, deque())
            while q and now - q[0] >= self.period:
                q.popleft()
            if len(q) >= self.limit:
                return False, max(1, int(self.period - (now - q[0])) + 1)
            q.append(now)
            return True, 0


def _headers(scope: Scope) -> dict[str, str]:
    return {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}


async def _send_json(send: Send, status: int, body: dict, extra_headers: list[tuple[bytes, bytes]]) -> None:
    data = json.dumps(body, ensure_ascii=False).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(data)).encode()),
                *extra_headers,
            ],
        }
    )
    await send({"type": "http.response.body", "body": data})


class _BodyTooLarge(Exception):
    pass


class SmartCityMiddleware:
    def __init__(
        self,
        app: ASGIApp,
        *,
        max_body_bytes: int,
        recommend_limit: str,
        general_limit: str,
        trust_forwarded_for: bool = False,
    ) -> None:
        self.app = app
        self.max_body = max_body_bytes
        self.recommend_limiter = SlidingWindowLimiter(recommend_limit)
        self.general_limiter = SlidingWindowLimiter(general_limit)
        self.trust_xff = trust_forwarded_for

    def _client_key(self, scope: Scope, headers: dict[str, str]) -> str:
        if self.trust_xff and headers.get("x-forwarded-for"):
            # Last hop = address seen by the trusted proxy in front of us (client-supplied
            # entries are earlier in the list and cannot override it).
            return headers["x-forwarded-for"].split(",")[-1].strip()[:64]
        client = scope.get("client")
        return client[0] if client else "unknown"

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request_id = uuid.uuid4().hex
        scope.setdefault("state", {})["request_id"] = request_id
        rid_header = (b"x-request-id", request_id.encode())
        t0 = time.monotonic()
        path: str = scope.get("path", "")
        method: str = scope.get("method", "GET")
        headers = _headers(scope)
        status_holder = {"status": 0, "started": False}

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                status_holder["status"] = message["status"]
                status_holder["started"] = True
                message["headers"] = [*message.get("headers", []), rid_header]
            await send(message)

        def access_log() -> None:
            log.info(
                "request",
                extra={
                    "event": "access",
                    "request_id": request_id,
                    "method": method,
                    "path": path[:200],
                    "status": status_holder["status"],
                    "duration_ms": int((time.monotonic() - t0) * 1000),
                },
            )

        # Rate limiting.
        if path.startswith("/api/") and path not in ("/api/health", "/api/ready"):
            limiter = self.recommend_limiter if path == "/api/recommend" else self.general_limiter
            allowed, retry = limiter.hit(self._client_key(scope, headers))
            if not allowed:
                await _send_json(
                    send_wrapper,
                    429,
                    {
                        "error": "rate_limited",
                        "message": "Слишком много запросов. Повторите позже.",
                        "request_id": request_id,
                    },
                    [(b"retry-after", str(retry).encode())],
                )
                access_log()
                return

        # Body size limit (declared and streamed).
        cl = headers.get("content-length")
        if cl is not None:
            try:
                too_big = int(cl) > self.max_body
            except ValueError:
                too_big = True
            if too_big:
                await _send_json(
                    send_wrapper,
                    413,
                    {
                        "error": "payload_too_large",
                        "message": "Слишком большой запрос",
                        "request_id": request_id,
                    },
                    [],
                )
                access_log()
                return
        received = 0

        async def receive_wrapper() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_body:
                    raise _BodyTooLarge()
            return message

        try:
            await self.app(scope, receive_wrapper, send_wrapper)
        except _BodyTooLarge:
            if not status_holder["started"]:
                await _send_json(
                    send_wrapper,
                    413,
                    {
                        "error": "payload_too_large",
                        "message": "Слишком большой запрос",
                        "request_id": request_id,
                    },
                    [],
                )
        finally:
            access_log()
