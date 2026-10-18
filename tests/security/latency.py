"""Sequential latency sample (concurrency 1) for cheap read endpoints of a running API.

uv run python tests/security/latency.py http://127.0.0.1:8000 30 artifacts/qa/perf/api-latency.json
"""

from __future__ import annotations

import json
import os
import statistics
import sys
import time
from pathlib import Path

import httpx

PATHS = {
    "search": "/api/search?q=кофе",
    "places": "/api/places?bbox=71.39,51.075,71.445,51.115",
    "place_detail": None,  # filled from search
    "map_buildings": "/api/map/buildings",
    "map_buildings_304": "/api/map/buildings",
    "ready": "/api/ready",
}


def pct(xs: list[float], p: float) -> float:
    xs = sorted(xs)
    k = max(0, min(len(xs) - 1, round(p / 100 * (len(xs) - 1))))
    return round(xs[k], 1)


def main() -> int:
    base, n, out = sys.argv[1].rstrip("/"), int(sys.argv[2]), Path(sys.argv[3])
    c = httpx.Client(base_url=base, timeout=60)
    pid = c.get("/api/search", params={"q": "Mega"}).json()["items"][0]["place_id"]
    etag = c.get("/api/map/buildings").headers.get("etag")
    res = {}
    for name, path in PATHS.items():
        path = path or f"/api/places/{pid}"
        headers = {"If-None-Match": etag} if name.endswith("_304") else {}
        ms, codes, size = [], {}, 0
        for _ in range(n):
            t = time.perf_counter()
            r = c.get(path, headers=headers)
            ms.append((time.perf_counter() - t) * 1000)
            codes[r.status_code] = codes.get(r.status_code, 0) + 1
            size = len(r.content)
        res[name] = {
            "path": path,
            "n": n,
            "p50_ms": pct(ms, 50),
            "p95_ms": pct(ms, 95),
            "max_ms": round(max(ms), 1),
            "mean_ms": round(statistics.mean(ms), 1),
            "status": codes,
            "bytes": size,
        }
        print(name, res[name], flush=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(
            {
                "base": base,
                "method": f"sequential, concurrency 1, n={n}, httpx keep-alive from the same host",
                "loadavg": os.getloadavg(),
                "results": res,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
