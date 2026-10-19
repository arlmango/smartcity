"""City-wide base map for the whole of Astana (separate from the bounded recommendation database).

Two local PMTiles archives in DATA_DIR/basemap, served as /api/tiles/{base,buildings}/{z}/{x}/{y}:
- astana-base.pmtiles: extract of a Protomaps daily planet build (OSM, ODbL) for CITY_BBOX,
  made with the pinned `pmtiles` CLI (HTTP range requests; the planet is never downloaded);
- astana-buildings.pmtiles: SmartCity's own building tiles from a Geofabrik Kazakhstan extract
  (md5-verified), with height and height source (vtiles.py).
manifest.json records sources, dates, checksums and height-source statistics.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import platform
import subprocess
import tarfile
import zipfile
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path

import httpx
from shapely.geometry import box, mapping
from smartcity_api.config import REPO_ROOT

from smartcity_ingest import roofs, vtiles
from smartcity_ingest.geometry import round_coords
from smartcity_ingest.mapbuild import (
    AREA_HOUSE_M2,
    AREA_SMALL_M2,
    DEFAULT_HEIGHT_M,
    HOUSE_TYPE_HEIGHT_M,
    LEVEL_HEIGHT_M,
    LOW_LARGE_TYPE_HEIGHT_M,
    SMALL_TYPE_HEIGHT_M,
    area_m2_lonlat,
)
from smartcity_ingest.snapshot import sha256_file

log = logging.getLogger("smartcity_ingest.basemap")
logging.getLogger("httpx").setLevel(logging.WARNING)  # redirect URLs carry signed query strings

# Rectangle around Astana's administrative boundary (OSM relation 3087155, KZ-71: 71.218–71.785 E,
# 50.858–51.351 N on 2026-10-18) with a margin. Tiles cover this rectangle; the build checks that the
# boundary really lies inside it and records the result (manifest "coverage").
CITY_BBOX: tuple[float, float, float, float] = (71.15, 50.83, 71.85, 51.38)
ADMIN_BOUNDARY_RELATION = 3087155
BOUNDARY_FILE = "astana-boundary.geojson"
LANDMARKS_CONFIG = "config/landmark_shapes.json"
LICENSES = {
    "osm": {
        "license": "ODbL-1.0",
        "attribution": "© OpenStreetMap contributors",
        "url": "https://www.openstreetmap.org/copyright",
    },
    "protomaps_basemap": {
        "license": "ODbL-1.0 (OSM-derived tiles; Natural Earth at low zooms is public domain)",
        "attribution": "© OpenStreetMap contributors · Protomaps",
        "url": "https://docs.protomaps.com/basemaps/downloads",
    },
}
MAX_ZOOM = 15

PROTOMAPS_BUILDS = "https://build-metadata.protomaps.dev/builds.json"
PROTOMAPS_URL = "https://build.protomaps.com/{key}"
GEOFABRIK_URL = "https://download.geofabrik.de/asia/kazakhstan-latest.osm.pbf"

PMTILES_VERSION = "1.31.2"
_PMTILES_RELEASE = f"https://github.com/protomaps/go-pmtiles/releases/download/v{PMTILES_VERSION}/"
PMTILES_ASSETS: dict[tuple[str, str], tuple[str, str]] = {
    ("Darwin", "arm64"): (
        f"go-pmtiles-{PMTILES_VERSION}_Darwin_arm64.zip",
        "40528f7f616fcbf91207cd48c8fc023d213f6d86c0cbf1f748732803d1880f3d",
    ),
    ("Darwin", "x86_64"): (
        f"go-pmtiles-{PMTILES_VERSION}_Darwin_x86_64.zip",
        "1f0dc02eee6c58312dd6c509faee1b5c32f0596568af1bf51f1b034e7a88a65b",
    ),
    ("Linux", "x86_64"): (
        f"go-pmtiles_{PMTILES_VERSION}_Linux_x86_64.tar.gz",
        "3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f",
    ),
    ("Linux", "aarch64"): (
        f"go-pmtiles_{PMTILES_VERSION}_Linux_arm64.tar.gz",
        "f8bd47e7ea866863489cad588fbaf2f31f42e5821f7a03f009b3769f05801cb1",
    ),
}

BASE_FILE = "astana-base.pmtiles"
BUILDINGS_FILE = "astana-buildings.pmtiles"


def _download(client: httpx.Client, url: str, dest: Path) -> None:
    tmp = dest.with_suffix(dest.suffix + ".part")
    with client.stream("GET", url, follow_redirects=True) as r:
        r.raise_for_status()
        with tmp.open("wb") as f:
            for chunk in r.iter_bytes(1 << 20):
                f.write(chunk)
    tmp.replace(dest)


def pmtiles_binary(cache: Path, client: httpx.Client) -> Path:
    """PMTILES_BIN, or the pinned go-pmtiles release (sha256-verified) cached under data/cache/bin."""
    if os.environ.get("PMTILES_BIN"):
        return Path(os.environ["PMTILES_BIN"])
    key = (platform.system(), platform.machine())
    if key not in PMTILES_ASSETS:
        raise SystemExit(f"no pinned pmtiles binary for {key}; set PMTILES_BIN")
    name, sha = PMTILES_ASSETS[key]
    bindir = cache / "bin" / f"pmtiles-{PMTILES_VERSION}"
    exe = bindir / "pmtiles"
    if exe.is_file():
        return exe
    bindir.mkdir(parents=True, exist_ok=True)
    archive = bindir / name
    _download(client, _PMTILES_RELEASE + name, archive)
    if sha256_file(archive) != sha:
        archive.unlink()
        raise SystemExit(f"checksum mismatch for {name}")
    if name.endswith(".zip"):
        with zipfile.ZipFile(archive) as z:
            z.extract("pmtiles", bindir)
    else:
        with tarfile.open(archive) as t:
            t.extract("pmtiles", bindir, filter="data")
    exe.chmod(0o755)
    archive.unlink()
    return exe


def latest_protomaps_build(client: httpx.Client) -> dict:
    builds = client.get(PROTOMAPS_BUILDS).raise_for_status().json()
    builds = [b for b in builds if str(b.get("key", "")).endswith(".pmtiles")]
    if not builds:
        raise SystemExit("no Protomaps builds listed")
    return max(builds, key=lambda b: b["key"])


def build_base(out: Path, cache: Path, client: httpx.Client, build_key: str | None) -> dict:
    build = {"key": build_key} if build_key else latest_protomaps_build(client)
    url = PROTOMAPS_URL.format(key=build["key"])
    exe = pmtiles_binary(cache, client)
    bbox = ",".join(str(v) for v in CITY_BBOX)
    tmp = out.with_suffix(".tmp")
    tmp.unlink(missing_ok=True)
    log.info("pmtiles extract %s bbox=%s", url, bbox)
    subprocess.run(  # noqa: S603 - fixed binary and arguments, no shell
        [str(exe), "extract", url, str(tmp), f"--bbox={bbox}", f"--maxzoom={MAX_ZOOM}"],
        check=True,
    )
    tmp.replace(out)
    return {"source": url, "build": build, "pmtiles_cli": PMTILES_VERSION}


def fetch_pbf(cache: Path, client: httpx.Client) -> tuple[Path, str]:
    """Geofabrik Kazakhstan extract; `-latest` redirects to a dated file, which is cached by name."""
    head = client.head(GEOFABRIK_URL, follow_redirects=False)
    target = head.headers.get("location") or GEOFABRIK_URL
    name = target.rsplit("/", 1)[-1]
    osm_dir = cache / "osm"
    osm_dir.mkdir(parents=True, exist_ok=True)
    pbf = osm_dir / name
    md5_expected = client.get(target + ".md5", follow_redirects=True).raise_for_status().text.split()[0]
    if not pbf.is_file() or _md5(pbf) != md5_expected:
        log.info("downloading %s", target)
        _download(client, target, pbf)
        if _md5(pbf) != md5_expected:
            raise SystemExit(f"md5 mismatch for {name}")
    return pbf, target


def _md5(path: Path) -> str:
    h = hashlib.md5()  # noqa: S324 - integrity check against Geofabrik's published md5, not security
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _write_atomic(path: Path, text: str) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def write_boundary(pbf: Path, out: Path) -> dict:
    """City boundary as GeoJSON (for the map) + a check that the tiles really cover it."""
    g = vtiles.extract_boundary(pbf, ADMIN_BOUNDARY_RELATION)
    if g is None:
        log.warning("admin boundary relation %s not found", ADMIN_BOUNDARY_RELATION)
        out.unlink(missing_ok=True)  # never serve a stale boundary the manifest no longer vouches for
        return {"admin_boundary": None, "boundary_inside_tiles": None}
    simple = round_coords(g.simplify(1e-5, preserve_topology=True), 6)
    _write_atomic(
        out,
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {"osm": f"relation/{ADMIN_BOUNDARY_RELATION}", "name": "Астана"},
                        "geometry": mapping(simple),
                    }
                ],
                "metadata": {"attribution": "© OpenStreetMap contributors", "license": "ODbL-1.0"},
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ),
    )
    inside = box(*CITY_BBOX).contains(g)
    if not inside:
        log.warning("Astana boundary extends beyond the tile bbox %s", CITY_BBOX)
    return {
        "admin_boundary": f"relation/{ADMIN_BOUNDARY_RELATION}",
        "boundary_bounds": [round(v, 5) for v in g.bounds],
        "boundary_area_km2": round(area_m2_lonlat(g) / 1e6, 1),
        "boundary_inside_tiles": inside,
        "tiles_bbox": list(CITY_BBOX),
        "file": out.name,
    }


def build_basemap(
    data_dir: Path,
    *,
    user_agent: str,
    protomaps_build: str | None = None,
    pbf: Path | None = None,
    skip_base: bool = False,
) -> dict:
    out_dir = data_dir / "basemap"
    cache = data_dir / "cache"
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / "manifest.json"
    previous = json.loads(manifest_path.read_text()) if manifest_path.is_file() else {}
    with httpx.Client(
        headers={"User-Agent": user_agent}, timeout=httpx.Timeout(60.0, connect=20.0)
    ) as client:
        if skip_base:
            base_info = previous.get("base", {})
        else:
            base_info = build_base(out_dir / BASE_FILE, cache, client, protomaps_build)
        source_url = None
        if pbf is None:
            pbf, source_url = fetch_pbf(cache, client)
    stats: Counter = Counter()
    landmarks = roofs.load_landmarks(REPO_ROOT / LANDMARKS_CONFIG)
    items, landmark_results = vtiles.extract_buildings(pbf, CITY_BBOX, stats, landmarks)
    tiles = vtiles.write_pmtiles(items, CITY_BBOX, out_dir / BUILDINGS_FILE)
    coverage = write_boundary(pbf, out_dir / BOUNDARY_FILE)
    manifest = {
        "built_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "bbox": list(CITY_BBOX),
        "coordinate_order": "[lon, lat]",
        "attribution": "© OpenStreetMap contributors (ODbL); base tiles: Protomaps Basemap",
        "licenses": LICENSES,
        "tiles_version": "",
        "coverage": coverage,
        "base": {
            **base_info,
            "file": BASE_FILE,
            "bytes": (out_dir / BASE_FILE).stat().st_size,
            "sha256": sha256_file(out_dir / BASE_FILE),
        },
        "buildings": {
            "source": source_url or str(pbf.name),
            "pbf_sha256": sha256_file(pbf),
            "file": BUILDINGS_FILE,
            "bytes": (out_dir / BUILDINGS_FILE).stat().st_size,
            "sha256": sha256_file(out_dir / BUILDINGS_FILE),
            "zooms": [vtiles.MIN_ZOOM, vtiles.MAX_ZOOM],
            "level_height_m": LEVEL_HEIGHT_M,
            "default_height_m": DEFAULT_HEIGHT_M,
            "counts": {
                "buildings": stats["buildings"],
                "parts": stats["parts"],
                "outlines_drawn_by_parts": stats["outlines_with_parts"],
                "invalid_skipped": stats["invalid_area"],
            },
            "height_source": {
                "height": stats["src_height"],
                "levels": stats["src_levels"],
                "estimate": stats["src_estimate"],
                "default": stats["src_default"],
            },
            "estimate_basis": {"type": stats["estimate_type"], "area": stats["estimate_area"]},
            "estimate_rules": {
                "по типу": {
                    "гараж, сарай, киоск и т. п.": SMALL_TYPE_HEIGHT_M,
                    "частный дом": HOUSE_TYPE_HEIGHT_M,
                    "склад, ангар, навес и т. п.": LOW_LARGE_TYPE_HEIGHT_M,
                },
                "по площади (building=yes)": {
                    f"меньше {AREA_SMALL_M2:g} м²": SMALL_TYPE_HEIGHT_M,
                    f"меньше {AREA_HOUSE_M2:g} м²": HOUSE_TYPE_HEIGHT_M,
                },
            },
            "roofs": {
                "linear": stats["roofs_linear"],
                "curved": stats["roofs_curved"],
                "sphere": stats["roofs_sphere"],
                "landmark": stats["roofs_landmark"],
            },
            "landmarks": landmark_results,
            **tiles,
        },
    }
    # Cache key for tile URLs: changes whenever either archive changes (browsers cache tiles for a day).
    manifest["tiles_version"] = hashlib.sha256(
        (manifest["base"]["sha256"] + manifest["buildings"]["sha256"]).encode()
    ).hexdigest()[:12]
    _write_atomic(manifest_path, vtiles.manifest_json(manifest))
    return manifest
