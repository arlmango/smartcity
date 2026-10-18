"""Filesystem layout and coverage configuration."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from shapely.geometry import shape
from shapely.geometry.base import BaseGeometry
from smartcity_api.config import REPO_ROOT, Settings


@dataclass(frozen=True)
class Paths:
    data_dir: Path

    @property
    def snapshots(self) -> Path:
        return self.data_dir / "snapshots"

    @property
    def map_dir(self) -> Path:
        return self.data_dir / "map"

    @property
    def manifests(self) -> Path:
        return self.data_dir / "manifests"

    @classmethod
    def from_settings(cls, s: Settings) -> Paths:
        d = Path(s.data_dir)
        if not d.is_absolute():
            d = REPO_ROOT / d
        return cls(data_dir=d)


@dataclass(frozen=True)
class CoverageArea:
    id: str
    name: str
    geometry: BaseGeometry  # shapely, lon/lat
    geojson: dict  # original geometry (GeoJSON)

    def overpass_poly(self) -> str:
        """Overpass `poly:"lat lon lat lon ..."` filter (exterior ring, lat first by Overpass syntax)."""
        geom = self.geometry
        if geom.geom_type == "MultiPolygon":
            geom = max(geom.geoms, key=lambda g: g.area)
        coords = list(geom.exterior.coords)[:-1]
        return " ".join(f"{lat:.6f} {lon:.6f}" for lon, lat in coords)


def load_coverage(path: Path) -> CoverageArea:
    if not path.is_absolute():
        path = REPO_ROOT / path
    data = json.loads(path.read_text(encoding="utf-8"))
    feat = data["features"][0] if data.get("type") == "FeatureCollection" else data
    geom = shape(feat["geometry"])
    if geom.geom_type not in ("Polygon", "MultiPolygon") or not geom.is_valid:
        raise ValueError("coverage must be a valid Polygon/MultiPolygon")
    minx, miny, maxx, maxy = geom.bounds
    # Guard against swapped [lat, lon]: Astana is lon ~71, lat ~51.
    if not (60 < minx < 80 and 45 < miny < 56):
        raise ValueError("coverage coordinates must be [lon, lat] around Astana")
    props = feat.get("properties") or {}
    return CoverageArea(
        id=props.get("id", "coverage"),
        name=props.get("name", props.get("id", "coverage")),
        geometry=geom,
        geojson=feat["geometry"],
    )
