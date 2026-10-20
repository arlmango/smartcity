"""City-wide base map: /api/tiles, /api/basemap, /api/basemap/boundary (SYNTHETIC archives)."""

from __future__ import annotations

import shutil

from conftest import FIXTURE_TILE, FIXTURE_TILE_BYTES, write_basemap_fixture
from smartcity_api.middleware import log_path

Z, X, Y = FIXTURE_TILE


def test_tile_served_uncompressed_with_cache_headers(make_client):
    r = make_client().get(f"/api/tiles/base/{Z}/{X}/{Y}")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/x-protobuf"
    assert r.content == FIXTURE_TILE_BYTES  # gzip removed server-side; no Content-Encoding forwarded
    assert "content-encoding" not in r.headers
    assert r.headers["etag"].startswith('"') and "max-age=" in r.headers["cache-control"]


def test_tile_etag_revalidation_returns_304(make_client):
    c = make_client()
    etag = c.get(f"/api/tiles/buildings/{Z}/{X}/{Y}").headers["etag"]
    for header in (etag, f"W/{etag}", f'"other", {etag}'):
        r = c.get(f"/api/tiles/buildings/{Z}/{X}/{Y}", headers={"If-None-Match": header})
        assert r.status_code == 304 and r.content == b"" and r.headers["etag"] == etag
    assert c.get(f"/api/tiles/buildings/{Z}/{X}/{Y}", headers={"If-None-Match": '"x"'}).status_code == 200
    # Different tiles never share an ETag.
    assert c.get(f"/api/tiles/base/{Z}/{X + 1}/{Y}").headers["etag"] != etag


def test_empty_tile_is_204_not_error(make_client):
    r = make_client().get(f"/api/tiles/base/{Z}/{X + 1}/{Y}")
    assert r.status_code == 204 and r.content == b""


def test_tile_whitelist_and_range(make_client):
    c = make_client()
    assert c.get(f"/api/tiles/secret/{Z}/{X}/{Y}").json()["error"] == "unknown_tileset"
    assert c.get("/api/tiles/base/16/0/0").status_code == 404
    assert c.get("/api/tiles/base/2/4/0").status_code == 404
    assert c.get("/api/tiles/base/2/0/-1").status_code == 404
    assert c.get("/api/tiles/..%2Fsecret.txt/1/0/0").status_code == 404
    assert c.get("/api/tiles/base/a/0/0").status_code == 422


def test_tiles_unavailable_without_archives(make_client, tmp_path):
    r = make_client(data_dir=tmp_path).get(f"/api/tiles/base/{Z}/{X}/{Y}")
    assert r.status_code == 503 and r.json()["error"] == "basemap_unavailable"


def test_rebuilt_archive_is_reopened(make_client, tmp_path):
    d = tmp_path / "data"
    write_basemap_fixture(d / "basemap")
    c = make_client(data_dir=d)
    e1 = c.get(f"/api/tiles/base/{Z}/{X}/{Y}").headers["etag"]
    shutil.copy(d / "basemap" / "astana-buildings.pmtiles", d / "basemap" / "x.tmp")
    (d / "basemap" / "x.tmp").write_bytes((d / "basemap" / "x.tmp").read_bytes() + b"\0")
    (d / "basemap" / "x.tmp").replace(d / "basemap" / "astana-base.pmtiles")
    e2 = c.get(f"/api/tiles/base/{Z}/{X}/{Y}").headers["etag"]
    assert e1 != e2


def test_access_log_path_hides_viewed_area():
    assert log_path(f"/api/tiles/base/{Z}/{X}/{Y}") == "/api/tiles/base"
    assert log_path("/api/places/abc") == "/api/places/abc"


def test_tiles_have_their_own_rate_limit(make_client):
    c = make_client(rate_limit_general="2/minute", rate_limit_tiles="50/minute")
    for _ in range(10):
        assert c.get(f"/api/tiles/base/{Z}/{X}/{Y}").status_code == 200
    assert c.get("/api/coverage").status_code == 200
    c.get("/api/coverage")
    assert c.get("/api/coverage").status_code == 429


def test_basemap_info_noncommercial_offers_licensed_satellite(make_client):
    j = make_client(app_usage_mode="noncommercial").get("/api/basemap").json()
    assert j["usage_mode"] == "noncommercial"
    sat = j["satellite"]
    assert sat["enabled"] is True and "CC BY-NC-SA 4.0" in sat["license"]
    assert "Contains modified Copernicus Sentinel data 2024" in sat["attribution"]
    assert "colours adjusted" in sat["attribution"]  # CC BY-*: changes to the imagery are indicated
    assert sat["tiles"][0].startswith("https://tiles.maps.eox.at/")
    assert j["height_source"] == {"height": 1, "levels": 2, "estimate": 3, "default": 4}
    assert j["coverage"]["boundary_inside_tiles"] is True
    assert j["stylised_landmarks"] == [{"osm": "way/1", "centroid": [71.4, 51.0]}]


def test_basemap_info_commercial_mode_has_no_satellite(make_client, monkeypatch):
    monkeypatch.delenv("APP_USAGE_MODE", raising=False)  # the code default must be fail-closed
    monkeypatch.delenv("MAP_SATELLITE", raising=False)
    j = make_client(app_usage_mode="commercial").get("/api/basemap").json()
    assert j["satellite"]["enabled"] is False and "tiles" not in j["satellite"]
    # Fail-closed: without an explicit APP_USAGE_MODE=noncommercial there is no satellite.
    assert make_client().get("/api/basemap").json()["satellite"]["enabled"] is False
    j = make_client(app_usage_mode="noncommercial", map_satellite="off").get("/api/basemap").json()
    assert j["satellite"] == {"enabled": False, "reason": "MAP_SATELLITE=off"}


def test_basemap_boundary_and_missing(make_client, tmp_path):
    r = make_client().get("/api/basemap/boundary")
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/geo+json")
    assert make_client(data_dir=tmp_path).get("/api/basemap").status_code == 503
    assert make_client(data_dir=tmp_path).get("/api/basemap/boundary").status_code == 503


def test_missing_basemap_is_reported_but_does_not_gate_readiness(make_client, tmp_path, data_dir):
    d = tmp_path / "d"
    shutil.copytree(data_dir / "map", d / "map")
    r = make_client(data_dir=d).get("/api/ready")
    j = r.json()
    assert j["components"]["basemap"]["status"] == "unavailable"
    assert "make basemap" in j["components"]["basemap"]["detail"]
    assert j["components"]["map"]["status"] == "ok" and r.status_code == 200 and j["ready"] is True
    assert make_client().get("/api/ready").json()["components"]["basemap"]["status"] == "ok"


def test_tile_version_query_is_a_validated_cache_key(make_client):
    c = make_client()
    assert c.get(f"/api/tiles/base/{Z}/{X}/{Y}?v=abc123").status_code == 200
    assert c.get(f"/api/tiles/base/{Z}/{X}/{Y}?v=../../x").status_code == 422
    assert c.get("/api/basemap").json()["tiles_version"] is None  # fixture manifest has none


def test_basemap_info_tolerates_missing_height_stats(make_client, tmp_path):
    import json

    d = tmp_path / "d"
    write_basemap_fixture(d / "basemap")
    m = json.loads((d / "basemap" / "manifest.json").read_text())
    m["buildings"].pop("height_source")
    (d / "basemap" / "manifest.json").write_text(json.dumps(m))
    hs = make_client(data_dir=d).get("/api/basemap").json()["height_source"]
    assert hs == {"height": 0, "levels": 0, "estimate": 0, "default": 0}


def test_without_own_building_tiles_the_base_buildings_are_used_honestly(make_client, tmp_path):
    from smartcity_api.routes.tiles import basemap_status

    d = tmp_path / "data"
    write_basemap_fixture(d / "basemap")
    (d / "basemap" / "astana-buildings.pmtiles").unlink()
    c = make_client(data_dir=d)
    j = c.get("/api/basemap").json()
    assert j["building_tiles"] == "base"
    # Statistics of an archive that is not there are never presented.
    assert j["stylised_landmarks"] == [] and j["buildings"] is None
    assert set(j["height_source"].values()) == {0}
    assert "Protomaps" in j["buildings_source"]
    ok, detail = basemap_status(d)
    assert ok and "свои тайлы зданий не собраны" in detail
    assert c.get(f"/api/tiles/buildings/{Z}/{X}/{Y}").status_code == 503
    assert c.get(f"/api/tiles/base/{Z}/{X}/{Y}").status_code == 200


def test_own_building_tiles_are_reported(make_client):
    j = make_client().get("/api/basemap").json()
    assert j["building_tiles"] == "own"
