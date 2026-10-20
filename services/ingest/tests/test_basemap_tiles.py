"""City base map building tiles: heights, roofs, landmark checks, tiling — SYNTHETIC OSM data only."""

from __future__ import annotations

import gzip
import json
import math
from collections import Counter
from pathlib import Path

import mapbox_vector_tile
import pytest
from pmtiles.reader import MmapSource, Reader, all_tiles
from shapely.geometry import Point, box
from smartcity_ingest import roofs, vtiles

BBOX = (71.40, 51.08, 71.43, 51.10)


def _ring(cx: float, cy: float, half_m: float, n: int = 4, start: int = 0) -> list[tuple[float, float]]:
    """Square (n=4) or regular polygon around (cx, cy), half-size in metres."""
    k = 111_320 * math.cos(math.radians(cy))
    pts = []
    for i in range(n):
        a = 2 * math.pi * i / n + math.pi / 4
        pts.append((cx + half_m * math.cos(a) / k, cy + half_m * math.sin(a) / 110_540))
    return pts


def _osm_xml(path: Path, ways: list[tuple[int, list[tuple[float, float]], dict]], relations=()) -> Path:
    nodes, out_ways, nid = [], [], 1
    for wid, ring, tags in ways:
        refs = []
        for lon, lat in ring:
            nodes.append(f'<node id="{nid}" version="1" lat="{lat:.7f}" lon="{lon:.7f}"/>')
            refs.append(nid)
            nid += 1
        refs.append(refs[0])
        nd = "".join(f'<nd ref="{r}"/>' for r in refs)
        tg = "".join(f'<tag k="{k}" v="{v}"/>' for k, v in tags.items())
        out_ways.append(f'<way id="{wid}" version="1">{nd}{tg}</way>')
    rels = []
    for rid, members, tags in relations:
        mm = "".join(f'<member type="way" ref="{m}" role="outer"/>' for m in members)
        tg = "".join(f'<tag k="{k}" v="{v}"/>' for k, v in tags.items())
        rels.append(f'<relation id="{rid}" version="1">{mm}{tg}</relation>')
    path.write_text(
        '<?xml version="1.0"?><osm version="0.6">' + "".join(nodes + out_ways + rels) + "</osm>",
        encoding="utf-8",
    )
    return path


@pytest.fixture()
def synthetic_osm(tmp_path):
    c = (71.4162, 51.0893)
    ways = [
        (10, _ring(71.405, 51.085, 20), {"building": "yes", "building:levels": "5"}),
        (11, _ring(71.406, 51.085, 3), {"building": "yes"}),  # ~18 m² -> 3 m by area
        (12, _ring(71.407, 51.085, 7), {"building": "yes"}),  # ~98 m² -> 6 m by area
        (13, _ring(71.408, 51.085, 4), {"building": "garage"}),  # 3 m by type
        (14, _ring(71.409, 51.085, 30), {"building": "yes"}),  # 3600 m² -> explicit default 10 m
        (15, _ring(71.410, 51.086, 10), {"building": "house", "roof:shape": "hipped", "height": "9"}),
        (16, _ring(71.411, 51.086, 10, n=24), {"building": "yes", "height": "20", "roof:shape": "dome"}),
        (20, _ring(*c, 60, n=6), {"building": "office", "museum": "future", "name": "SYNTH parent"}),
        (21, _ring(*c, 40, n=48), {"building:part": "yes", "height": "100", "roof:shape": "round"}),
        (30, _ring(71.42, 51.095, 12), {"building": "yes", "colour": "x", "building:colour": "navy"}),
    ]
    boundary = [
        (900, [(71.401, 51.081), (71.429, 51.081), (71.429, 51.099), (71.401, 51.099)], {}),
    ]
    _osm_xml(
        tmp_path / "synthetic.osm",
        ways + boundary,
        relations=[(77, [900], {"type": "boundary", "boundary": "administrative", "admin_level": "4"})],
    )
    lm = roofs.LandmarkShape(
        osm="way/21",
        shape="sphere",
        label="SYNTH · стилизация",
        note="synthetic",
        parent="way/20",
        parent_tags={"museum": "future"},
        expected_center=c,
        max_offset_m=30,
        min_circularity=0.95,
    )
    return tmp_path / "synthetic.osm", lm


def _by_fid(items):
    out: dict[int, list] = {}
    for b in items:
        out.setdefault(b.fid, []).append(b.props)
    return out


def test_extract_heights_roofs_and_landmark(synthetic_osm):
    pbf, lm = synthetic_osm
    stats: Counter = Counter()
    items, results = vtiles.extract_buildings(pbf, BBOX, stats, [lm])
    f = _by_fid(items)
    assert f[10 * 2][0]["src"] == "levels" and f[10 * 2][0]["h"] == 16.0
    assert (f[11 * 2][0]["h"], f[11 * 2][0]["src"], f[11 * 2][0]["eb"]) == (3.0, "estimate", "area")
    assert (f[12 * 2][0]["h"], f[12 * 2][0]["eb"]) == (6.0, "area")
    assert (f[13 * 2][0]["h"], f[13 * 2][0]["eb"]) == (3.0, "type")
    assert (f[14 * 2][0]["h"], f[14 * 2][0]["src"]) == (10.0, "default")
    assert stats["src_estimate"] == 3 and stats["estimate_area"] == 2 and stats["estimate_type"] == 1

    hipped = f[15 * 2]
    body = [p for p in hipped if "rs" not in p][0]
    slices = [p for p in hipped if p.get("rs")]
    assert body["roofed"] == 1 and body["h"] < 9 and len(slices) == roofs.SLICES["linear"]
    assert slices[-1]["h"] == pytest.approx(9.0)
    assert all(a["h"] == pytest.approx(b["mh"]) for a, b in zip(slices, slices[1:], strict=False))
    dome = [p for p in f[16 * 2] if p.get("rs")]
    assert len(dome) == roofs.SLICES["curved"] and dome[-1]["h"] == pytest.approx(20.0)
    assert stats["roofs_linear"] == 1 and stats["roofs_curved"] == 1

    # Curated sphere: checks passed, every piece marked as stylisation, one labelled slice.
    assert results[0]["applied"] is True and results[0]["problems"] == []
    sphere = f[21 * 2]
    assert len(sphere) >= 10 and all(p["styl"] == 1 and p["rs"] == 1 for p in sphere)
    assert [p["lbl"] for p in sphere if "lbl" in p] == ["SYNTH · стилизация"]
    assert min(p["mh"] for p in sphere) == 0 and max(p["h"] for p in sphere) == pytest.approx(100)
    # A sphere, not an egg: its vertical extent equals the footprint diameter (~80 m), on a stem.
    ball = sphere[1:]
    assert 100 - min(p["mh"] for p in ball) == pytest.approx(80, abs=4)
    # The outline with ground-level parts is drawn by its parts in 3D.
    assert f[20 * 2][0].get("has_parts") == 1
    # Every piece (roof slices and stylisation slices too) names its OSM object, so the map can hide
    # an object that a landmark model replaces.
    assert {p["oid"] for p in f[15 * 2]} == {"w15"} and {p["oid"] for p in sphere} == {"w21"}
    # Tagged colour is normalised and softened, unknown values dropped.
    assert f[30 * 2][0]["col"].startswith("#") and f[30 * 2][0]["col"] != "#000080"


def test_landmark_not_applied_when_checks_fail(synthetic_osm):
    pbf, lm = synthetic_osm
    moved = roofs.LandmarkShape(**{**lm.__dict__, "expected_center": (71.40, 51.08)})
    wrong_parent = roofs.LandmarkShape(**{**lm.__dict__, "parent_tags": {"museum": "art"}})
    for bad in (moved, wrong_parent):
        items, results = vtiles.extract_buildings(pbf, BBOX, Counter(), [bad])
        assert results[0]["applied"] is False and results[0]["problems"]
        assert not any(b.props.get("styl") for b in items)
    missing = roofs.LandmarkShape(**{**lm.__dict__, "osm": "way/999"})
    _, results = vtiles.extract_buildings(pbf, BBOX, Counter(), [missing])
    assert results[0] == {"osm": "way/999", "applied": False, "problems": ["element not found in extract"]}


def test_circularity_uses_local_metres():
    k = math.cos(math.radians(51.09))
    circle_lonlat = Point(0, 0).buffer(1, 64)
    from shapely import affinity

    circle_lonlat = affinity.translate(affinity.scale(circle_lonlat, 1e-3 / k, 1e-3), 71.4, 51.09)
    assert roofs.circularity(circle_lonlat) > 0.99
    assert roofs.circularity(box(0, 0, 1000, 100)) < 0.4


def test_flat_or_small_roofs_are_not_invented():
    g = vtiles.merc(box(71.40, 51.08, 71.4003, 51.0803))
    pieces, kind = roofs.slice_roof(g, {"h": 9.0, "mh": 0.0, "src": "height"}, None, 0.63)
    assert kind is None and len(pieces) == 1
    pieces, kind = roofs.slice_roof(g, {"h": 9.0, "mh": 0.0, "src": "height", "roof": "flat"}, None, 0.63)
    assert kind is None
    tiny = vtiles.merc(box(71.40, 51.08, 71.40003, 51.08002))
    _, kind = roofs.slice_roof(tiny, {"h": 6.0, "mh": 0.0, "src": "estimate", "roof": "gabled"}, None, 0.63)
    assert kind is None


def test_tagged_roof_height_is_used():
    g = vtiles.merc(box(71.40, 51.08, 71.4006, 51.0804))
    pieces, kind = roofs.slice_roof(g, {"h": 12.0, "mh": 0.0, "src": "height", "roof": "gabled"}, 2.0, 0.63)
    assert kind == "linear" and pieces[0].props["h"] == pytest.approx(10.0)


def test_write_pmtiles_roundtrip(synthetic_osm, tmp_path):
    pbf, lm = synthetic_osm
    items, _ = vtiles.extract_buildings(pbf, BBOX, Counter(), [lm])
    info = vtiles.write_pmtiles(items, BBOX, tmp_path / "b.pmtiles")
    assert set(info["tiles_per_zoom"]) == {"13", "14", "15"}
    with open(tmp_path / "b.pmtiles", "rb") as fh:
        r = Reader(MmapSource(fh))
        meta = r.metadata()
        assert meta["vector_layers"][0]["id"] == "buildings" and "src" in meta["vector_layers"][0]["fields"]
        props = []
        for (z, _x, _y), data in all_tiles(r.get_bytes):
            if z == 15:
                for feat in mapbox_vector_tile.decode(gzip.decompress(data))["buildings"]["features"]:
                    props.append(feat["properties"])
    assert {p["src"] for p in props} >= {"levels", "estimate", "default", "height"}
    assert any(p.get("lbl") == "SYNTH · стилизация" for p in props)


def test_extract_boundary(synthetic_osm):
    pbf, _ = synthetic_osm
    g = vtiles.extract_boundary(pbf, 77)
    assert g is not None and g.bounds == pytest.approx((71.401, 51.081, 71.429, 51.099), abs=1e-6)
    assert vtiles.extract_boundary(pbf, 12345) is None


def test_landmark_config_is_valid():
    from smartcity_api.config import REPO_ROOT

    lms = roofs.load_landmarks(REPO_ROOT / "config" / "landmark_shapes.json")
    assert [lm.osm for lm in lms] == ["way/1461813334"]
    assert "стилизац" in lms[0].label and lms[0].parent_tags == {"museum": "future"}
    raw = json.loads((REPO_ROOT / "config" / "landmark_shapes.json").read_text(encoding="utf-8"))
    assert raw["landmarks"][0]["evidence"]


def test_invalid_geometry_never_reaches_the_encoder_as_a_collection():
    # make_valid() of a ring with a spike yields GeometryCollection(Polygon, LineString); MVT encoding
    # of collections raises, which would abort the whole build.
    import shapely
    from shapely.geometry import Polygon

    z, x, y = 15, 22883, 10958
    minx, miny, maxx, maxy = vtiles.tile_bounds(z, x, y)
    cx, cy, d = (minx + maxx) / 2, (miny + maxy) / 2, 40
    spiky = Polygon(
        [(cx, cy), (cx + d, cy), (cx + d, cy + d), (cx, cy + d), (cx, cy), (cx - d, cy), (cx, cy)]
    )
    gc = shapely.make_valid(spiky)
    assert gc.geom_type == "GeometryCollection"
    data = vtiles.encode_tile([vtiles.Building(1, gc, {"h": 5.0, "mh": 0.0, "src": "height"})], z, x, y)
    feats = mapbox_vector_tile.decode(data)["buildings"]["features"]
    assert len(feats) == 1 and feats[0]["geometry"]["type"] == "Polygon"


def test_building_part_gets_no_footprint_area_estimate():
    from smartcity_ingest.mapbuild import building_heights

    part = building_heights({"building:part": "yes"}, area_m2=30)
    assert part["height_source"] == "default"
    assert building_heights({"building:part": "garage"}, area_m2=30)["estimate_basis"] == "type"
