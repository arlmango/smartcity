"""Review P2-7: with SMARTCITY_REQUIRE_DB=1 an unavailable test DB fails the run (no hidden skip)."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

TESTS = Path(__file__).parent


def _run(require: bool) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["SMARTCITY_TEST_DATABASE_URL"] = "postgresql+psycopg://nobody:nobody@127.0.0.1:1/unreachable_test"
    env.pop("SMARTCITY_REQUIRE_DB", None)
    if require:
        env["SMARTCITY_REQUIRE_DB"] = "1"
    return subprocess.run(  # noqa: S603 - fixed argv, test-only
        [
            sys.executable,
            "-m",
            "pytest",
            str(TESTS / "test_endpoints.py::test_health"),
            "-q",
            "-p",
            "no:cacheprovider",
        ],
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        cwd=TESTS.parent,
    )


def test_unreachable_db_fails_when_required():
    r = _run(require=True)
    assert r.returncode != 0, r.stdout
    assert "SMARTCITY_REQUIRE_DB=1" in r.stdout
    assert "skipped" not in r.stdout.splitlines()[-1]


def test_unreachable_db_skips_when_not_required():
    r = _run(require=False)
    assert r.returncode == 0, r.stdout
    assert "skipped" in r.stdout.splitlines()[-1]
