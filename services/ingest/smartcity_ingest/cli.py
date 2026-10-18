"""smartcity-ingest CLI: fetch | import | build-map | index | report | landmarks | all."""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

from smartcity_api.config import Settings, get_settings
from sqlalchemy import create_engine, func, select

from smartcity_ingest.paths import Paths, load_coverage
from smartcity_ingest.snapshot import Snapshot, latest_snapshot, load_snapshot

log = logging.getLogger("smartcity_ingest")


def _engine(s: Settings, url: str | None):
    return create_engine(url or s.database_url, pool_pre_ping=True)


def _snapshot(paths: Paths, arg: str | None) -> Snapshot:
    if arg:
        p = Path(arg)
        if not p.is_absolute() and not p.exists():
            p = paths.snapshots / arg
    else:
        p = latest_snapshot(paths.snapshots)
        if p is None:
            raise SystemExit("no snapshot found; run `smartcity-ingest fetch` first")
    return load_snapshot(p)


def cmd_fetch(s: Settings, paths: Paths, args) -> int:
    from smartcity_ingest.overpass import OverpassClient, query_groups
    from smartcity_ingest.snapshot import fetch_snapshot

    cov = load_coverage(Path(s.coverage_config))
    groups = query_groups()
    if args.groups:
        wanted = set(args.groups.split(","))
        groups = [g for g in groups if g.name in wanted]
    client = OverpassClient(s.osm_source_url, s.ingest_contact_user_agent)
    try:
        if args.retry_failed:
            from smartcity_ingest.snapshot import retry_failed_groups

            base = _snapshot(paths, args.retry_failed)
            if base.manifest.get("endpoint") != s.osm_source_url:
                raise SystemExit("retry must use the snapshot's original endpoint")
            snap = retry_failed_groups(client, base, groups, cov)
        else:
            snap = fetch_snapshot(
                client,
                groups,
                cov,
                paths.snapshots,
                endpoint=s.osm_source_url,
                user_agent=s.ingest_contact_user_agent,
            )
    finally:
        client.close()
    args.fetched_snapshot = str(snap.path)
    m = snap.manifest
    print(
        json.dumps(
            {
                "snapshot": str(snap.path),
                "status": m["status"],
                "osm_base": m["osm_base_timestamp"],
                "groups": {
                    k: {kk: v.get(kk) for kk in ("status", "elements", "bytes", "error")}
                    for k, v in m["groups"].items()
                },
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return {"complete": 0, "partial": 3, "failed": 2}[m["status"]]


def cmd_import(s: Settings, paths: Paths, args) -> int:
    from smartcity_ingest.importer import run_import

    snap = _snapshot(paths, args.from_snapshot)
    cov = load_coverage(Path(s.coverage_config))
    res = run_import(_engine(s, args.database_url), snap, cov)
    counts = {k: v for k, v in res.counts.items() if k != "dedup_merge_list"}
    print(
        json.dumps(
            {
                "run_id": str(res.run_id),
                "status": res.status,
                "snapshot": snap.dataset_version,
                "counts": counts,
                "error": res.error,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return {"complete": 0, "partial": 3, "failed": 2}[res.status]


def cmd_build_map(s: Settings, paths: Paths, args) -> int:
    from smartcity_ingest.mapbuild import build_map

    snap = _snapshot(paths, args.from_snapshot)
    cov = load_coverage(Path(s.coverage_config))
    try:
        m = build_map(snap, cov, paths.map_dir)
    except RuntimeError as e:
        print(f"build-map skipped, existing data/map left unchanged: {e}", file=sys.stderr)
        return 3
    print(
        json.dumps(
            {
                "counts": m["counts"],
                "total_bytes": m["total_bytes"],
                "height_provenance": m["buildings"]["height_provenance"],
                "simplified": m["simplification"]["applied"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def cmd_index(s: Settings, paths: Paths, args) -> int:
    from smartcity_api.db.models import Place
    from smartcity_api.providers.http_providers import build_embedding_provider
    from sqlalchemy.orm import Session

    from smartcity_ingest.indexer import run_index, write_index_manifest

    provider = build_embedding_provider(s)
    if provider is None:
        print("EMBEDDING_PROVIDER=none: index not built", file=sys.stderr)
        return 2
    eng = _engine(s, args.database_url)
    res = run_index(eng, provider, prune_other_models=args.prune_other_models)
    with Session(eng) as ses:
        active = ses.scalar(select(func.count()).select_from(Place).where(Place.active.is_(True))) or 0
    write_index_manifest(paths.manifests / "index_manifest.json", res, provider, active)
    print(json.dumps(res.__dict__, ensure_ascii=False, indent=2))
    return 0


def cmd_report(s: Settings, paths: Paths, args) -> int:
    from smartcity_ingest.report import write_reports

    snap = _snapshot(paths, args.from_snapshot)
    cov = load_coverage(Path(s.coverage_config))
    out = write_reports(_engine(s, args.database_url), snap, cov, paths)
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


def cmd_landmarks(s: Settings, paths: Paths, args) -> int:
    from smartcity_ingest.landmarks import write_landmarks

    snap = _snapshot(paths, args.from_snapshot)
    cov = load_coverage(Path(s.coverage_config))
    out = write_landmarks(snap, cov, paths.manifests / "landmarks.json")
    print(json.dumps({"found": len(out["landmarks"]), "checks": out["checks"]}, ensure_ascii=False, indent=2))
    return 0 if len(out["landmarks"]) >= 5 else 1


def cmd_all(s: Settings, paths: Paths, args) -> int:
    rc = cmd_fetch(s, paths, args) if not args.from_snapshot else 0
    if rc == 2:
        print("fetch failed: database untouched", file=sys.stderr)
        return 2
    if not args.from_snapshot:
        args.from_snapshot = args.fetched_snapshot
    rc_imp = cmd_import(s, paths, args)
    if rc_imp == 2:
        return 2
    rc_map = cmd_build_map(s, paths, args)
    if getattr(args, "skip_index", False):
        cmd_landmarks(s, paths, args)
        cmd_report(s, paths, args)
        return max(rc, rc_imp, rc_map)
    try:
        rc_idx = cmd_index(s, paths, args)
    except Exception as e:  # noqa: BLE001 - provider outage must not hide the data report
        print(
            f"index failed (committed batches kept; rerun `index`): {type(e).__name__}: {e}", file=sys.stderr
        )
        rc_idx = 4
    cmd_landmarks(s, paths, args)
    cmd_report(s, paths, args)
    return max(rc, rc_imp, rc_map, rc_idx)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="smartcity-ingest", description=__doc__)
    ap.add_argument("--database-url", default=None, help="override DATABASE_URL")
    ap.add_argument("-v", "--verbose", action="store_true")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("fetch", "import", "build-map", "index", "report", "landmarks", "all"):
        p = sub.add_parser(name)
        if name != "fetch":
            p.add_argument(
                "--from-snapshot",
                default=None,
                help="snapshot dir or dataset_version under data/snapshots (default: latest)",
            )
        if name in ("fetch", "all"):
            p.add_argument("--groups", default=None, help="comma-separated subset of query groups (debug)")
            p.add_argument(
                "--retry-failed",
                default=None,
                metavar="SNAPSHOT",
                help="re-fetch only the failed groups of an existing snapshot (same endpoint)",
            )
        if name in ("index", "all"):
            p.add_argument("--prune-other-models", action="store_true")
        if name == "all":
            p.add_argument("--skip-index", action="store_true", help="data, map, reports only")
    args = ap.parse_args(argv)
    if not hasattr(args, "from_snapshot"):
        args.from_snapshot = None
    if not hasattr(args, "prune_other_models"):
        args.prune_other_models = False
    if not hasattr(args, "groups"):
        args.groups = None
    if not hasattr(args, "retry_failed"):
        args.retry_failed = None
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    s = get_settings()
    paths = Paths.from_settings(s)
    handlers = {
        "fetch": cmd_fetch,
        "import": cmd_import,
        "build-map": cmd_build_map,
        "index": cmd_index,
        "report": cmd_report,
        "landmarks": cmd_landmarks,
        "all": cmd_all,
    }
    return handlers[args.cmd](s, paths, args)


if __name__ == "__main__":
    sys.exit(main())
