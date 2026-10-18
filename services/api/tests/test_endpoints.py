"""Integration tests for non-recommend endpoints on the SYNTHETIC test DB."""

from __future__ import annotations

import logging

import pytest
from conftest import body
from fakes import FakeEmbedding, FakeGeneration
from smartcity_api.providers.base import ProviderUnavailable


def test_health(make_client):
    r = make_client().get("/api/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"
    assert "x-request-id" in r.headers


def test_ready_reports_components_without_secrets(make_client):
    c = make_client(generator=FakeGeneration(), ai_api_key="sk-SECRET-should-not-leak")
    r = c.get("/api/ready")
    assert r.status_code == 200
    j = r.json()
    assert j["ready"] is True
    comps = j["components"]
    assert set(comps) == {"db", "data", "map", "embeddings", "llm", "routing"}
    assert (
        comps["db"]["status"] == "ok" and comps["data"]["status"] == "ok" and comps["map"]["status"] == "ok"
    )
    assert comps["embeddings"]["status"] == "ok" and "dim 64" in comps["embeddings"]["detail"]
    assert comps["llm"]["status"] == "ok"
    assert comps["routing"]["status"] == "not_configured"
    assert "SECRET" not in r.text and "localhost:11434" not in r.text


def test_ready_embedding_mismatch_and_llm_down(make_client):
    c = make_client(
        embedder=FakeEmbedding(dim=32), generator=FakeGeneration(probe_error=ProviderUnavailable("down"))
    )
    j = c.get("/api/ready").json()
    assert j["components"]["embeddings"]["status"] == "degraded"
    assert j["components"]["llm"]["status"] == "unavailable"
    assert j["ready"] is True  # AI degraded does not block readiness (retrieval_only fallback)


def test_ready_no_map_files(make_client, tmp_path):
    c = make_client(data_dir=tmp_path)
    r = c.get("/api/ready")
    assert r.status_code == 503 and r.json()["components"]["map"]["status"] == "unavailable"


def test_coverage(make_client):
    j = make_client().get("/api/coverage").json()
    assert j["type"] == "FeatureCollection" and j["dataset_version"] == "synthetic-v1"
    assert j["features"][0]["geometry"]["type"] == "Polygon"
    assert j["bbox"] == [71.395, 51.078, 71.435, 51.102]
    # No EXPO/Nur Alem place in the synthetic DB -> centre of coverage, honestly labelled
    assert j["default_origin"]["lat"] == pytest.approx(51.09) and j["default_origin"]["lon"] == pytest.approx(
        71.415
    )
    assert "не ваше местоположение" in j["default_origin_label"]


def test_map_layer_etag_304_and_cache(make_client):
    c = make_client()
    r = c.get("/api/map/buildings")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/geo+json")
    etag = r.headers["etag"]
    assert len(etag) == 66 and "max-age" in r.headers["cache-control"]
    r2 = c.get("/api/map/buildings", headers={"If-None-Match": etag})
    assert r2.status_code == 304 and r2.content == b""
    r3 = c.get("/api/map/buildings", headers={"If-None-Match": '"other"'})
    assert r3.status_code == 200


def test_map_whitelist_and_path_traversal(make_client):
    c = make_client()
    for bad in [
        "secret",
        "..%2Fsecret.txt",
        "../secret.txt",
        "%2e%2e%2fsecret.txt",
        "buildings.geojson",
        "manifest",
    ]:
        r = c.get(f"/api/map/{bad}")
        assert r.status_code == 404, bad
        assert "must never be served" not in r.text
        if r.headers.get("content-type", "").startswith("application/json"):
            assert r.json()["error"] in ("unknown_layer", "not_found")


def test_map_missing_file_is_503(make_client, tmp_path):
    r = make_client(data_dir=tmp_path).get("/api/map/roads")
    assert r.status_code == 503 and r.json()["error"] == "map_unavailable"


def test_places_bbox(make_client, place_ids):
    c = make_client()
    j = c.get("/api/places", params={"bbox": "71.395,51.078,71.435,51.102"}).json()
    ids = {i["place_id"] for i in j["items"]}
    assert place_ids["cafe_socket"] in ids and place_ids["inactive"] not in ids
    assert j["truncated"] is False
    j2 = c.get("/api/places", params={"bbox": "71.395,51.078,71.435,51.102", "category": "park"}).json()
    assert {i["category"] for i in j2["items"]} == {"park"}
    j3 = c.get("/api/places", params={"bbox": "71.395,51.078,71.435,51.102", "limit": 2}).json()
    assert len(j3["items"]) == 2 and j3["truncated"] is True


def test_places_bbox_validation(make_client):
    c = make_client()
    for bad in ["1,2,3", "a,b,c,d", "71.5,51.0,71.4,51.1", "nan,51,71.5,51.1", "0,0,10,10", "200,0,201,1"]:
        r = c.get("/api/places", params={"bbox": bad})
        assert r.status_code == 422, bad
        assert r.json()["error"] in ("invalid_bbox", "bbox_too_large")
    assert c.get("/api/places", params={"bbox": "71.39,51.07,71.44,51.11", "limit": 501}).status_code == 422
    assert (
        c.get("/api/places", params={"bbox": "71.39,51.07,71.44,51.11", "category": "bar"}).status_code == 422
    )


def test_place_detail_404_422_and_server_facts(make_client, place_ids):
    c = make_client()
    assert c.get("/api/places/not-a-uuid").json()["error"] == "invalid_place_id"
    assert c.get("/api/places/00000000-0000-0000-0000-000000000000").status_code == 404
    assert c.get(f"/api/places/{place_ids['inactive']}").status_code == 404
    d = c.get(f"/api/places/{place_ids['cafe_socket']}").json()
    assert d["source"]["url"] == "https://www.openstreetmap.org/node/900000001"
    assert d["website"] == "https://synthetic.example/cafe"
    assert {f["feature"] for f in d["verified_features"]} == {"socket", "wifi"}
    assert any(f["evidence"] == "OSM: power_supply=yes" for f in d["verified_features"])
    assert d["address"] == "SYNTHETIC улица Тестовая, 1"


def test_T26_unsafe_website_dropped(make_client, place_ids):
    d = make_client().get(f"/api/places/{place_ids['cafe_unknown']}").json()
    assert d["website"] is None  # javascript: URL in source data is never passed to the browser


def test_search(make_client, place_ids):
    c = make_client()
    j = c.get("/api/search", params={"q": "Учебный"}).json()
    assert j["items"] and j["items"][0]["name"] == "SYNTHETIC Сквер «Учебный»"
    assert j["method"].startswith("lexical")
    by_cat = c.get("/api/search", params={"q": "музей"}).json()
    assert any(i["category"] == "culture" for i in by_cat["items"])
    assert (
        c.get("/api/search", params={"q": "Тестовая"}).json()["items"][0]["place_id"]
        == place_ids["cafe_socket"]
    )
    pct = c.get("/api/search", params={"q": "%"}).json()  # LIKE wildcards are escaped
    assert pct["items"] == []
    assert c.get("/api/search", params={"q": "x" * 101}).status_code == 422
    assert c.get("/api/search", params={"q": ""}).status_code == 422
    assert c.get("/api/search", params={"q": "   "}).status_code == 422


def test_T25_xss_returned_as_data(make_client, place_ids):
    c = make_client()
    r = c.get("/api/search", params={"q": "<script>alert(1)</script>"})
    assert r.headers["content-type"].startswith("application/json")
    assert r.json()["query"] == "<script>alert(1)</script>"
    d = c.get(f"/api/places/{place_ids['xss']}").json()
    assert d["name"] == "SYNTHETIC <script>alert(1)</script> Галерея"  # verbatim JSON string, never HTML


def test_T23_route_unavailable(make_client):
    r = make_client().post("/api/route", json={"from": [71.4, 51.09], "to": [71.41, 51.09]})
    assert r.status_code == 501
    j = r.json()
    assert j["error"] == "routing_unavailable" and "request_id" in j
    assert "coordinates" not in r.text and "LineString" not in r.text


def test_rate_limit_429(make_client, origin):
    c = make_client(rate_limit="2/minute", rate_limit_general="3/minute")
    codes = [c.get("/api/search", params={"q": "кафе"}).status_code for _ in range(4)]
    assert codes == [200, 200, 200, 429]
    r = c.get("/api/search", params={"q": "кафе"})
    assert r.json()["error"] == "rate_limited" and int(r.headers["retry-after"]) >= 1
    assert c.get("/api/health").status_code == 200  # health/ready are exempt


def test_rate_limit_recommend(make_client, origin):
    c = make_client(rate_limit="1/minute")
    b = body(origin, origin={"lat": 10.0, "lon": 10.0})
    assert c.post("/api/recommend", json=b).status_code == 200
    assert c.post("/api/recommend", json=b).status_code == 429


def test_body_size_limit(make_client, origin):
    c = make_client(max_body_bytes=2048)
    r = c.post("/api/recommend", json=body(origin, query="а" * 1900))
    assert r.status_code == 413 and r.json()["error"] == "payload_too_large"


def test_cors_only_configured_origins(make_client):
    c = make_client(cors_origins="http://localhost:3000")
    ok = c.options(
        "/api/search", headers={"Origin": "http://localhost:3000", "Access-Control-Request-Method": "GET"}
    )
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:3000"
    bad = c.options(
        "/api/search", headers={"Origin": "http://evil.example", "Access-Control-Request-Method": "GET"}
    )
    assert bad.headers.get("access-control-allow-origin") is None
    g = c.get("/api/health", headers={"Origin": "http://evil.example"})
    assert "access-control-allow-origin" not in g.headers


def test_unknown_route_structured_404(make_client):
    r = make_client().get("/api/nope")
    assert r.status_code == 404 and r.json()["error"] == "not_found"


def test_logs_have_no_raw_query_or_exact_coords(make_client, origin, caplog):
    c = make_client(generator=None)
    secret_text = "секретный запрос пользователя Иванова"
    o = {"lat": 51.091234, "lon": 71.414567}
    lg = logging.getLogger("smartcity")
    lg.addHandler(caplog.handler)  # app logger does not propagate to root
    try:
        with caplog.at_level(logging.INFO, logger="smartcity"):
            r = c.post("/api/recommend", json=body(origin, origin=o, query=secret_text))
            assert r.status_code == 200
            c.get("/api/search", params={"q": "секретный поиск"})
    finally:
        lg.removeHandler(caplog.handler)
    from smartcity_api.observability import JsonFormatter

    fmt = JsonFormatter()
    lines = [fmt.format(rec) for rec in caplog.records]
    blob = "\n".join(lines)
    assert "recommend" in blob
    assert secret_text not in blob and "секретный поиск" not in blob
    assert "51.091234" not in blob and "71.414567" not in blob and "51.0912" not in blob
    assert "[51.09, 71.41]" in blob  # rounded to 0.01°


def test_coverage_default_origin_from_landmark_manifest(make_client, tmp_path):
    import json as _json

    (tmp_path / "manifests").mkdir()
    landmarks = [
        {
            "key": "expo_site",
            "name": "SYNTHETIC EXPO",
            "osm": "way/1",
            "centroid_lonlat": [71.42, 51.093],
            "inside_coverage": True,
        },
        {
            "key": "nur_alem",
            "name": "outside",
            "osm": "way/2",
            "centroid_lonlat": [0, 0],
            "inside_coverage": False,
        },
    ]
    (tmp_path / "manifests" / "landmarks.json").write_text(
        _json.dumps({"SYNTHETIC": True, "landmarks": landmarks}), encoding="utf-8"
    )
    j = make_client(data_dir=tmp_path).get("/api/coverage").json()
    assert j["default_origin"] == {"lat": 51.093, "lon": 71.42}
    assert "way/1" in j["default_origin_label"] and "не ваше местоположение" in j["default_origin_label"]
