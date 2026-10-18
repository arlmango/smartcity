"""Raw Overpass snapshots on disk: data/snapshots/<dataset_version>/.

Each group's raw response is stored gzip-compressed (deterministic, mtime=0) together with the
sha256 of the raw bytes. snapshot.json lists the queries, per-group status, the OSM base
timestamp and whether the snapshot is complete (every group succeeded).
"""

from __future__ import annotations

import gzip
import hashlib
import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from smartcity_ingest.overpass import OverpassClient, OverpassError, QueryGroup, build_query
from smartcity_ingest.paths import CoverageArea

log = logging.getLogger("smartcity_ingest.snapshot")

MANIFEST = "snapshot.json"


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def parse_osm_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
    except ValueError:
        return None


@dataclass
class Snapshot:
    path: Path
    manifest: dict
    _cache: dict[str, dict] = field(default_factory=dict)

    @property
    def dataset_version(self) -> str:
        return self.manifest["dataset_version"]

    @property
    def complete(self) -> bool:
        return bool(self.manifest.get("complete"))

    @property
    def snapshot_hash(self) -> str:
        return self.manifest["snapshot_hash"]

    @property
    def osm_base(self) -> datetime | None:
        return parse_osm_ts(self.manifest.get("osm_base_timestamp"))

    @property
    def fetched_at(self) -> datetime:
        return datetime.fromisoformat(self.manifest["fetched_at"])

    def group_ok(self, name: str) -> bool:
        g = self.manifest["groups"].get(name)
        return bool(g and g.get("status") == "ok")

    def elements(self, name: str) -> list[dict]:
        if not self.group_ok(name):
            return []
        if name not in self._cache:
            g = self.manifest["groups"][name]
            raw = gzip.decompress((self.path / g["file"]).read_bytes())
            if sha256_bytes(raw) != g["sha256"]:
                raise ValueError(f"snapshot group {name}: sha256 mismatch")
            self._cache[name] = json.loads(raw)
        return self._cache[name].get("elements", [])

    def verify(self) -> None:
        for name in self.manifest["groups"]:
            if self.group_ok(name):
                self.elements(name)


def _snapshot_hash(groups: dict[str, dict]) -> str:
    parts = [f"{k}:{v.get('status')}:{v.get('sha256', '')}" for k, v in sorted(groups.items())]
    return sha256_bytes("\n".join(parts).encode())


def write_group(dirpath: Path, name: str, raw: bytes) -> dict:
    fname = f"{name}.json.gz"
    (dirpath / fname).write_bytes(gzip.compress(raw, compresslevel=9, mtime=0))
    data = json.loads(raw)
    return {
        "status": "ok",
        "file": fname,
        "sha256": sha256_bytes(raw),
        "file_sha256": sha256_file(dirpath / fname),
        "bytes": len(raw),
        "elements": len(data.get("elements", [])),
        "osm_base_timestamp": (data.get("osm3s") or {}).get("timestamp_osm_base"),
        "generator": data.get("generator"),
    }


def finalize_manifest(dirpath: Path, manifest: dict) -> Snapshot:
    groups = manifest["groups"]
    stamps = [g["osm_base_timestamp"] for g in groups.values() if g.get("osm_base_timestamp")]
    manifest["osm_base_timestamp"] = max(stamps) if stamps else None
    manifest["osm_base_timestamp_min"] = min(stamps) if stamps else None
    manifest["complete"] = all(g.get("status") == "ok" for g in groups.values())
    manifest["status"] = (
        "complete"
        if manifest["complete"]
        else ("failed" if not any(g.get("status") == "ok" for g in groups.values()) else "partial")
    )
    manifest["snapshot_hash"] = _snapshot_hash(groups)
    (dirpath / MANIFEST).write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return Snapshot(path=dirpath, manifest=manifest)


def fetch_snapshot(
    client: OverpassClient,
    groups: list[QueryGroup],
    coverage: CoverageArea,
    snapshots_dir: Path,
    *,
    endpoint: str,
    user_agent: str,
    now: datetime | None = None,
) -> Snapshot:
    now = now or datetime.now(UTC)
    version = "osm-" + now.strftime("%Y%m%dT%H%M%SZ")
    dirpath = snapshots_dir / version
    dirpath.mkdir(parents=True, exist_ok=False)
    poly = coverage.overpass_poly()
    manifest: dict = {
        "dataset_version": version,
        "source": "OpenStreetMap via Overpass API (read-only)",
        "endpoint": endpoint,
        "user_agent": user_agent,
        "license": "ODbL-1.0",
        "attribution": "© OpenStreetMap contributors",
        "coverage_id": coverage.id,
        "coverage_geometry": coverage.geojson,
        "fetched_at": now.isoformat(),
        "groups": {},
        "queries": {},
    }
    for g in groups:
        _fetch_group(client, g, poly, dirpath, manifest)
    manifest["finished_at"] = datetime.now(UTC).isoformat()
    return finalize_manifest(dirpath, manifest)


def _fetch_group(client: OverpassClient, g: QueryGroup, poly: str, dirpath: Path, manifest: dict) -> None:
    q = build_query(g, poly)
    manifest["queries"][g.name] = q
    log.info("fetch group %s", g.name)
    try:
        res = client.run(q)
        entry = write_group(dirpath, g.name, res.raw)
        entry["attempts"] = res.attempts
        log.info("group %s: %d elements, %d bytes", g.name, entry["elements"], entry["bytes"])
    except OverpassError as e:
        entry = {"status": "failed", "error": str(e)[:300]}
        log.error("group %s failed: %s", g.name, e)
    entry["kind"] = g.kind
    entry["fetched_at"] = datetime.now(UTC).isoformat()
    prev = manifest["groups"].get(g.name)
    if prev and prev.get("status") == "failed":
        entry["previous_failures"] = prev.get("previous_failures", []) + [
            {"error": prev.get("error"), "fetched_at": prev.get("fetched_at")}
        ]
    manifest["groups"][g.name] = entry


def retry_failed_groups(
    client: OverpassClient, snapshot: Snapshot, groups: list[QueryGroup], coverage: CoverageArea
) -> Snapshot:
    """Re-fetch only the failed groups of an existing snapshot into the same directory.

    Successful groups are kept byte-for-byte; each group records its own fetched_at and OSM base
    timestamp, so the snapshot stays auditable (osm_base_timestamp_min/max are reported)."""
    manifest = snapshot.manifest
    if manifest.get("coverage_id") != coverage.id:
        raise ValueError("snapshot coverage differs from configured coverage")
    poly = coverage.overpass_poly()
    failed = [g for g in groups if manifest["groups"].get(g.name, {}).get("status") != "ok"]
    for g in failed:
        _fetch_group(client, g, poly, snapshot.path, manifest)
    manifest.setdefault("retries", []).append(
        {"at": datetime.now(UTC).isoformat(), "groups": [g.name for g in failed]}
    )
    return finalize_manifest(snapshot.path, manifest)


def load_snapshot(path: Path) -> Snapshot:
    manifest = json.loads((path / MANIFEST).read_text(encoding="utf-8"))
    snap = Snapshot(path=path, manifest=manifest)
    snap.verify()
    return snap


def latest_snapshot(snapshots_dir: Path) -> Path | None:
    cands = sorted(p for p in snapshots_dir.glob("osm-*") if (p / MANIFEST).exists())
    return cands[-1] if cands else None
