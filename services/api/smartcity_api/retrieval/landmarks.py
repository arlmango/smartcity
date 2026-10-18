"""Reference landmarks from the ingest manifest (data/manifests/landmarks.json).

The manifest is produced by the ingest from the OSM snapshot (OSM id + centroid). The API only
reads it to place a clearly labelled demo start point; it never invents coordinates.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Landmark:
    key: str
    name: str
    lat: float
    lon: float
    osm: str


def load_landmark(data_dir: Path, keys: list[str]) -> Landmark | None:
    try:
        data = json.loads((data_dir / "manifests" / "landmarks.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    items = {lm.get("key"): lm for lm in data.get("landmarks", []) if isinstance(lm, dict)}
    for key in keys:
        lm = items.get(key)
        if not lm or lm.get("inside_coverage") is not True:
            continue
        ll = lm.get("centroid_lonlat")
        osm = lm.get("osm")
        if not (isinstance(ll, list) and len(ll) == 2 and isinstance(osm, str)):
            continue
        lon, lat = ll
        if not all(isinstance(v, int | float) and math.isfinite(v) for v in (lon, lat)):
            continue
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            continue
        return Landmark(
            key=key,
            name=str(lm.get("name") or lm.get("label") or key)[:120],
            lat=float(lat),
            lon=float(lon),
            osm=osm,
        )
    return None
