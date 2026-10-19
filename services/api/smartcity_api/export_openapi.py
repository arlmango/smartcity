"""Export the OpenAPI snapshot deterministically.

Usage: uv run python -m smartcity_api.export_openapi [--check] [path]
Default path: packages/contracts/openapi.json. --check exits 1 if the file is out of date.
No DB or provider connection is made (providers are built lazily, nothing is probed).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from smartcity_api.config import REPO_ROOT, Settings

DEFAULT_PATH = REPO_ROOT / "packages" / "contracts" / "openapi.json"


def render() -> str:
    from smartcity_api.main import create_app

    app = create_app(Settings())
    spec = app.openapi()
    return json.dumps(spec, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    check = "--check" in args
    args = [a for a in args if a != "--check"]
    path = Path(args[0]) if args else DEFAULT_PATH
    content = render()
    if check:
        current = path.read_text(encoding="utf-8") if path.exists() else ""
        if current != content:
            print(
                f"{path} is out of date; run: uv run python -m smartcity_api.export_openapi", file=sys.stderr
            )
            return 1
        print(f"{path} is up to date")
        return 0
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
