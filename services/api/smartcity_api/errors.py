"""Structured API errors -> ErrorResponse JSON."""

from __future__ import annotations


class ApiError(Exception):
    def __init__(self, status: int, error: str, message: str, headers: dict[str, str] | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.error = error
        self.message = message
        self.headers = headers or {}


class ClientDisconnected(Exception):  # noqa: N818 - control-flow signal
    """The HTTP client went away; stop waiting for slow providers."""
