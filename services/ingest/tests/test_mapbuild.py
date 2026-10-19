"""Map layer tests on SYNTHETIC fixtures."""

from __future__ import annotations

import json

import pytest
from shapely.geometry import shape
from smartcity_ingest.mapbuild import build_map, building_heights
from smartcity_ingest.snapshot import sha256_file


def test_building_heights_rules():
    assert building_heights({"height": "30"}) == {
        "height_m": 30.0,
        "min_height_m": 0.0,
        "height_source": "height",
    }
    assert building_heights({"height": "12.5 m", "building:levels": "3"})["height_source"] == "height"
    h = building_heights({"building:levels": "5"})
    assert h["height_m"] == 16.0 and h["height_source"] == "levels" and h["levels"] == 5
    assert building_heights({}) == {"height_m": 10.0, "min_height_m": 0.0, "height_source": "default"}
    assert building_heights({"height": "abc"})["height_source"] == "default"
    assert building_heights({"building:levels": "9", "building:min_level": "2"})["min_height_m"] == 6.4
    bad = building_heights({"height": "5", "min_height": "8"})
    assert bad["min_height_m"] == 0.0 and "min_height_note" in bad


def test_building_height_estimates_by_type_and_area():
    # Real data first, then levels, then a documented estimate — never a silent 10 m for houses/garages.
    assert building_heights({"building": "garage"}) == {
        "height_m": 3.0,
        "min_height_m": 0.0,
        "height_source": "estimate",
        "estimate_basis": "type",
    }
    assert building_heights({"building": "house"})["height_m"] == 6.0
    assert building_heights({"building": "warehouse"})["height_m"] == 8.0
    assert building_heights({"building": "house", "building:levels": "3"})["height_source"] == "levels"
    assert building_heights({"building": "garage", "height": "4"})["height_source"] == "height"
    small = building_heights({"building": "yes"}, area_m2=25)
    assert (small["height_m"], small["estimate_basis"]) == (3.0, "area")
    assert building_heights({"building": "yes"}, area_m2=120)["height_m"] == 6.0
    big = building_heights({"building": "yes"}, area_m2=900)
    assert (big["height_m"], big["height_source"]) == (10.0, "default")
    # Unknown size or an unlisted type keeps the explicit default.
    assert building_heights({"building": "yes"})["height_source"] == "default"
    assert building_heights({"building": "apartments"}, area_m2=60)["height_source"] == "default"


@pytest.fixture()
def built(tmp_path, coverage, fixture_groups, make_snapshot):
    snap = make_snapshot(fixture_groups)
    out = tmp_path / "map"
    m = build_map(snap, coverage, out)
    layers = {
        n: json.loads((out / f"{n}.geojson").read_text())
        for n in ("buildings", "roads", "water", "green", "coverage")
    }
    return m, layers, out


def test_buildings_layer(built):
    m, layers, _ = built
    feats = {f["properties"]["id"]: f for f in layers["buildings"]["features"]}
    assert "way/9205" not in feats  # outside coverage
    assert feats["way/9201"]["properties"]["height_source"] == "height"
    assert feats["way/9201"]["properties"]["height_m"] == 30.0
    assert feats["way/9202"]["properties"]["height_source"] == "levels"
    assert feats["way/9203"]["properties"]["height_source"] == "default"
    rel = feats["relation/7101"]
    g = shape(rel["geometry"])
    assert g.is_valid and g.geom_type == "Polygon" and len(g.interiors) == 1
    assert rel["properties"]["min_height_m"] == 3.0 and rel["properties"]["height_m"] == 28.8
    for f in feats.values():
        geom = shape(f["geometry"])
        assert geom.is_valid and geom.geom_type in ("Polygon", "MultiPolygon")
        x, y = geom.exterior.coords[0] if geom.geom_type == "Polygon" else geom.geoms[0].exterior.coords[0]
        assert 71 < x < 72 and 51 < y < 52  # [lon, lat]
    prov = m["buildings"]["height_provenance"]
    assert sum(prov.values()) == 5 and prov["height"] == 1 and prov["levels"] == 2
    assert m["buildings"]["with_inner_rings"] == 1
    assert layers["buildings"]["metadata"]["attribution"] == "© OpenStreetMap contributors"


def test_roads_clipped_and_rounded(built):
    _, layers, _ = built
    roads = layers["roads"]["features"]
    assert [f["properties"]["highway"] for f in roads] == ["primary"]  # proposed excluded
    coords = roads[0]["geometry"]["coordinates"]
    assert roads[0]["geometry"]["type"] == "LineString"
    assert min(c[0] for c in coords) >= 71.39 - 1e-9
    for c in coords:
        assert round(c[0], 6) == c[0] and round(c[1], 6) == c[1]


def test_manifest_hashes_and_other_layers(built):
    m, layers, out = built
    for name, entry in m["layers"].items():
        assert entry["sha256"] == sha256_file(out / entry["file"])
        assert entry["features"] == len(layers[name]["features"])
    assert m["license"] == "ODbL-1.0"
    assert layers["water"]["features"][0]["properties"]["kind"] == "water"
    assert layers["green"]["features"][0]["properties"]["kind"] == "grass"
    assert layers["coverage"]["features"][0]["geometry"]["type"] == "Polygon"
    assert m["simplification"]["applied"] is False


def test_map_requires_complete_map_groups(tmp_path, coverage, fixture_groups, make_snapshot):
    snap = make_snapshot(fixture_groups, failed=("map_roads",))
    with pytest.raises(RuntimeError):
        build_map(snap, coverage, tmp_path / "map2")
