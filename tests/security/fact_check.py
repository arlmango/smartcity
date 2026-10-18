"""Cross-check captured live /api/recommend responses against the live database (read-only).

For every recommendation in every JSON file under the given directories (files written by
apps/web/tests/live/helpers.ts `collect().flush()` or the eval runner):
  - place_id exists, is active; name / name_is_generic / category / coordinates equal the DB row;
  - source.url == https://www.openstreetmap.org/{source_type}/{source_id} (server-built);
  - website and opening_hours_raw equal the DB;
  - timing: total = outbound + visit + return + buffer <= time_budget_min, buffer = max(5, ceil(10% road)),
    return == outbound when return_to_start, else null; visit >= 0;
  - distance (when the exact scripted origin is known) == haversine(origin, DB location) ± 2 m
    and outbound == ceil(d × 1.3 / 66.7).
Read-only: one SELECT per place_id.

  uv run python tests/security/fact_check.py --db postgresql://smartcity:smartcity@127.0.0.1:5433/smartcity \
      --out artifacts/qa/fact-check.json artifacts/live/<run>/responses
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import psycopg

R = 6371008.8
# Scripted test origins (rounded value in the artifact → exact point used by the test).
KNOWN_ORIGINS = {
    (51.09, 71.42): (51.089242, 71.416197),  # demo point (/api/coverage default_origin, Alem.ai)
    (51.09, 71.41): (51.08908605, 71.40728592973313),  # "Mega Silk Way" picked via /api/search
}


def hav(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (
        math.sin((p2 - p1) / 2) ** 2
        + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    )
    return 2 * R * math.asin(min(1.0, math.sqrt(a)))


def walk(d):
    return 0 if d <= 0 else math.ceil(round(d * 1.3 / 66.7, 9))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("dirs", nargs="+")
    a = ap.parse_args()
    files = sorted(f for d in a.dirs for f in Path(d).rglob("*.json"))
    rows = []
    problems = []
    with psycopg.connect(a.db, autocommit=True) as conn:
        conn.execute("SET default_transaction_read_only = on")
        for f in files:
            try:
                doc = json.loads(f.read_text())
            except Exception:
                continue
            resp = doc.get("response") or doc.get("result")
            req = doc.get("request") or {}
            if not isinstance(resp, dict) or "recommendations" not in resp:
                continue
            budget = req.get("time_budget_min")
            ret = req.get("return_to_start", True)
            o = req.get("origin") or {}
            exact = KNOWN_ORIGINS.get((o.get("lat"), o.get("lon"))) if o else None
            for rec in resp["recommendations"]:
                pid = rec["place_id"]
                r = conn.execute(
                    "SELECT name, name_is_generic, category, ST_Y(location::geometry), ST_X(location::geometry), "
                    "source_type, source_id, website, opening_hours_raw, active FROM places WHERE id = %s",
                    (pid,),
                ).fetchone()
                issues = []
                if r is None:
                    issues.append("place_id not in DB")
                else:
                    name, generic, cat, lat, lon, st, sid, web, oh, active = r
                    if not active:
                        issues.append("place inactive (tombstoned) in DB now")
                    if rec["name"] != name:
                        issues.append(f"name {rec['name']!r} != DB {name!r}")
                    if rec.get("name_is_generic") is not None and rec["name_is_generic"] != generic:
                        issues.append("name_is_generic mismatch")
                    if rec["category"] != cat:
                        issues.append(f"category {rec['category']} != {cat}")
                    c = rec.get("coordinates")
                    if c and (abs(c["lat"] - lat) > 1e-7 or abs(c["lon"] - lon) > 1e-7):
                        issues.append(f"coordinates {c} != DB ({lat},{lon})")
                    url = (rec.get("source") or {}).get("url") or rec.get("source_url")
                    if url != f"https://www.openstreetmap.org/{st}/{sid}":
                        issues.append(f"source url {url} != osm/{st}/{sid}")
                    if "website" in rec and rec["website"] != web:
                        issues.append(f"website {rec['website']!r} != DB {web!r}")
                    if "opening_hours_raw" in rec and rec["opening_hours_raw"] != oh:
                        issues.append("opening_hours_raw mismatch")
                    for ev in rec.get("evidence", []):
                        u = ev.get("source_url")
                        if u and not u.startswith("https://www.openstreetmap.org/"):
                            issues.append(f"evidence url not OSM: {u}")
                    if exact and "distance" in rec:
                        d = hav(exact[0], exact[1], lat, lon)
                        if abs(rec["distance"]["meters"] - d) > 2:
                            issues.append(f"distance {rec['distance']['meters']} != haversine {d:.1f}")
                        if rec["timing"]["outbound_min"] != walk(d):
                            issues.append(
                                f"outbound {rec['timing']['outbound_min']} != walk({d:.0f})={walk(d)}"
                            )
                t = rec["timing"]
                road = t["outbound_min"] + (t["return_min"] or 0)
                s = t["outbound_min"] + t["visit_min"] + (t["return_min"] or 0) + t["buffer_min"]
                if s != t["total_min"]:
                    issues.append(f"sum {s} != total {t['total_min']}")
                if budget is not None and t["total_min"] > budget:
                    issues.append(f"total {t['total_min']} > budget {budget}")
                if t["buffer_min"] != max(5, -(-road // 10)):  # integer ceil(10% of road)
                    issues.append(f"buffer {t['buffer_min']} != max(5, ceil(10% of {road}))")
                if ret and t["return_min"] != t["outbound_min"]:
                    issues.append("return != outbound with return_to_start")
                if not ret and t["return_min"] is not None:
                    issues.append("return present without return_to_start")
                rows.append({"file": str(f), "place_id": pid, "name": rec["name"], "issues": issues})
                if issues:
                    problems.append(rows[-1])
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(
        json.dumps(
            {"files": len(files), "recommendations_checked": len(rows), "problems": problems, "rows": rows},
            ensure_ascii=False,
            indent=2,
        )
    )
    print(f"files={len(files)} recommendations={len(rows)} problems={len(problems)}")
    for p in problems:
        print(" -", p["file"], p["name"], p["issues"])
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
