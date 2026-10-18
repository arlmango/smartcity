"""Print a compact summary of captured live /api/recommend responses (and console/network logs).

uv run python tests/security/summarize_live.py artifacts/live/<run>
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> int:
    run = Path(sys.argv[1])
    for f in sorted((run / "responses").glob("*.json")):
        d = json.loads(f.read_text())
        r = d.get("response") or {}
        print(
            f"## {d['project']} | {d['test'][:60]} | http {d['status']} | {d['ms']} ms | {r.get('status')} {r.get('mode')} | {r.get('providers', {}).get('llm_model')}"
        )
        for x in r.get("recommendations", []):
            t = x["timing"]
            print(
                f"   - {x['name']} [{x['category']}] {x['distance']['meters']} m  out {t['outbound_min']} visit {t['visit_min']} ret {t['return_min']} buf {t['buffer_min']} = {t['total_min']}  hours={x['opening_status']} reason={x['reason_source']}: {(x['reason'] or '')[:160]}"
            )
        print(
            f"   warnings={[w['code'] for w in r.get('warnings', [])]} relax={[x['code'] for x in r.get('suggested_relaxations', [])]}"
        )
    print("\n# console / network")
    for f in sorted((run / "console").glob("*.json")):
        d = json.loads(f.read_text())
        items = d["consoleErrors"] + d["pageErrors"] + d["failedRequests"] + d["httpErrors"]
        if items:
            print(f"## {d['project']} | {d['test'][:60]}")
            for i in items:
                print("   ", i[:220])
    return 0


if __name__ == "__main__":
    sys.exit(main())
