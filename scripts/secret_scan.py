"""Minimal secret scan over tracked files (no network). Exit 1 on findings.

Patterns cover common API key formats and private keys. `.env.example` must have empty secrets.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

PATTERNS = {
    "private_key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----"),
    "openai_like_key": re.compile(r"\bsk-[A-Za-z0-9_-]{20,}"),
    "anthropic_key": re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}"),
    "github_token": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}"),
    "aws_access_key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "google_api_key": re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"),
    "slack_token": re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}"),
    "bearer_literal": re.compile(r"Bearer [A-Za-z0-9._-]{30,}"),
}
SKIP_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".pbf", ".woff", ".woff2", ".ttf", ".ico", ".dump"}


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    files = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
        cwd=root,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split()
    findings: list[str] = []
    for rel in files:
        p = root / rel
        if p.suffix.lower() in SKIP_SUFFIXES or not p.is_file() or p.stat().st_size > 5_000_000:
            continue
        text = p.read_text(errors="ignore")
        for name, rx in PATTERNS.items():
            for m in rx.finditer(text):
                line = text.count("\n", 0, m.start()) + 1
                findings.append(f"{rel}:{line}: {name}")
    env_example = root / ".env.example"
    if env_example.exists():
        for i, line in enumerate(env_example.read_text().splitlines(), 1):
            if re.match(r"^(AI_API_KEY|EMBEDDING_API_KEY)=.+", line):
                findings.append(f".env.example:{i}: secret variable must be empty")
    if (root / ".env").exists():
        tracked = subprocess.run(["git", "ls-files", ".env"], cwd=root, capture_output=True, text=True).stdout
        if tracked.strip():
            findings.append(".env is tracked by git")
    for f in findings:
        print(f)
    print(f"secret scan: {len(files)} files, {len(findings)} findings")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
