"""Run the labelled query set (tests/eval/queries.json) against a running SmartCity API.

Each response is checked against expectations and global invariants using the live DB as ground
truth. Writes artifacts/eval/<ts>/results.json and summary.md. Exit code 1 if any hard-constraint
violation or grounding error is found (expectation misses are reported, not hidden).

Usage: uv run python scripts/eval_queries.py [--api http://127.0.0.1:8000] [--split dev|holdout|all]
"""

from __future__ import annotations

import argparse
import json
import secrets
import time
from datetime import UTC, datetime
from pathlib import Path

import httpx
from sqlalchemy import create_engine, text

from smartcity_api.config import get_settings

ROOT = Path(__file__).resolve().parents[1]
ORIGIN_QUERIES = {"mega": ["Mega Silk Way", "Мега Силк Вей"], "expo": ["Нур Алем", "Nur Alem", "EXPO", "Экспо"]}


def resolve_origins(client: httpx.Client) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for key, names in ORIGIN_QUERIES.items():
        for name in names:
            r = client.get("/api/search", params={"q": name})
            items = r.json().get("items", []) if r.status_code == 200 else []
            if items:
                out[key] = {"label": items[0]["name"], "place_id": items[0]["place_id"], **items[0]["coordinates"]}
                break
    if "expo" not in out:
        cov = client.get("/api/coverage").json()
        out["expo"] = {"label": cov["default_origin_label"], "place_id": None, **cov["default_origin"]}
    return out


def check(q: dict, req: dict, resp: dict, db) -> tuple[list[str], list[str]]:
    """Return (violations, misses). Violations = grounding/hard-constraint/budget errors."""
    violations: list[str] = []
    misses: list[str] = []
    recs = resp.get("recommendations", [])
    exp = q.get("expect", {})
    ids = [r["place_id"] for r in recs]
    if len(ids) != len(set(ids)):
        violations.append("duplicate place_id")
    hard = {c["value"] for c in resp["constraints_applied"]["hard"] if c["kind"] == "required_feature"}
    for r in recs:
        row = db.execute(
            text("SELECT name, ST_Y(location::geometry) lat, ST_X(location::geometry) lon, active "
                 "FROM places WHERE id = :id"), {"id": r["place_id"]},
        ).first()
        if row is None or not row.active:
            violations.append(f"{r['place_id']}: not an active DB place")
            continue
        if row.name != r["name"] or abs(row.lat - r["coordinates"]["lat"]) > 1e-9 or abs(
            row.lon - r["coordinates"]["lon"]) > 1e-9:
            violations.append(f"{r['place_id']}: name/coordinates differ from DB")
        t = r["timing"]
        total = t["outbound_min"] + t["visit_min"] + (t["return_min"] or 0) + t["buffer_min"]
        if total != t["total_min"] or t["total_min"] > req["time_budget_min"]:
            violations.append(f"{r['place_id']}: budget arithmetic/limit broken")
        if (t["return_min"] is not None) != req["return_to_start"]:
            violations.append(f"{r['place_id']}: return leg inconsistent with return_to_start")
        verified = {f["feature"] for f in r["verified_features"] if f["value"]}
        for feat in hard:
            if feat not in verified:
                violations.append(f"{r['place_id']}: hard feature {feat} not verified")
        for feat in exp.get("hard_features_verified", []):
            if feat not in verified:
                violations.append(f"{r['place_id']}: expected hard feature {feat} not verified")
        if r["category"] in exp.get("excluded_categories", []):
            violations.append(f"{r['place_id']}: excluded category {r['category']}")
        if exp.get("categories_only") and r["category"] not in exp["categories_only"]:
            violations.append(f"{r['place_id']}: category {r['category']} outside 'only' set")
        if exp.get("opening_status_all") and r["opening_status"] != exp["opening_status_all"]:
            violations.append(f"{r['place_id']}: opening_status {r['opening_status']}")
    if "status_in" in exp and resp["status"] not in exp["status_in"]:
        misses.append(f"status {resp['status']} not in {exp['status_in']}")
    if len(recs) < exp.get("min_results", 0):
        misses.append(f"{len(recs)} results < {exp['min_results']}")
    if exp.get("categories_any") and recs and not any(r["category"] in exp["categories_any"] for r in recs):
        misses.append(f"no result in categories {exp['categories_any']}")
    if exp.get("no_prompt_leak"):
        blob = json.dumps(resp, ensure_ascii=False).lower()
        if "system prompt" in blob or "ты — помощник" in blob or "инструкции:" in blob:
            violations.append("possible system prompt leak")
    return violations, misses


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://127.0.0.1:8000")
    ap.add_argument("--split", default="all", choices=["dev", "holdout", "all"])
    args = ap.parse_args()
    spec = json.loads((ROOT / "tests/eval/queries.json").read_text())
    ts = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    out = ROOT / "artifacts" / "eval" / ts
    out.mkdir(parents=True, exist_ok=True)
    engine = create_engine(get_settings().database_url)
    results = []
    with httpx.Client(base_url=args.api, timeout=300) as client, engine.connect() as db:
        origins = resolve_origins(client)
        for q in spec["queries"]:
            if args.split != "all" and q["split"] != args.split:
                continue
            o = origins[q["origin"]]
            req = {
                "origin": {"lat": o["lat"], "lon": o["lon"]},
                "query": q["query"],
                "time_budget_min": q["time_budget_min"],
                "return_to_start": q["return_to_start"],
                "interests": q.get("interests", []),
                "constraints": q.get("constraints", {}),
                "client_request_id": "eval-" + secrets.token_hex(6),
            }
            t0 = time.monotonic()
            r = client.post("/api/recommend", json=req)
            dt = round(time.monotonic() - t0, 1)
            if r.status_code != 200:
                results.append({"id": q["id"], "split": q["split"], "http": r.status_code, "latency_s": dt,
                                "violations": [f"HTTP {r.status_code}"], "misses": []})
                continue
            resp = r.json()
            violations, misses = check(q, req, resp, db)
            results.append({
                "id": q["id"], "split": q["split"], "query": q["query"], "origin": o["label"],
                "latency_s": dt, "status": resp["status"], "mode": resp["mode"],
                "providers": resp["providers"],
                "hard": resp["constraints_applied"]["hard"],
                "results": [{"place_id": x["place_id"], "name": x["name"], "category": x["category"],
                             "total_min": x["timing"]["total_min"], "opening_status": x["opening_status"],
                             "reason": x["reason"], "unknown_features": x["unknown_features"]}
                            for x in resp["recommendations"]],
                "message": resp["message"], "warnings": resp["warnings"],
                "relaxations": [x["code"] for x in resp["suggested_relaxations"]],
                "violations": violations, "misses": misses,
            })
            print(f"{q['id']} {resp['status']:<20} {resp['mode']:<14} {dt:>6}s viol={len(violations)} miss={len(misses)}")
    (out / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))
    total_v = sum(len(x["violations"]) for x in results)
    lines = ["# Eval results", f"date: {ts}", f"api: {args.api}", "",
             "| id | split | status | mode | n | latency s | violations | misses |", "|---|---|---|---|---|---|---|---|"]
    for x in results:
        lines.append(f"| {x['id']} | {x['split']} | {x.get('status', 'http ' + str(x.get('http')))} | "
                     f"{x.get('mode', '')} | {len(x.get('results', []))} | {x['latency_s']} | "
                     f"{'; '.join(x['violations']) or 0} | {'; '.join(x['misses']) or 0} |")
    lines += ["", f"hard-constraint/grounding violations: {total_v}"]
    (out / "summary.md").write_text("\n".join(lines) + "\n")
    print(f"report: {out}")
    return 1 if total_v else 0


if __name__ == "__main__":
    raise SystemExit(main())
