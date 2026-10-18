"""Quality report + provenance manifest. Every number here is computed from the DB/snapshot."""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from datetime import UTC, datetime
from pathlib import Path

from smartcity_api.config import REPO_ROOT
from smartcity_api.db.models import IngestRun, Place, PlaceEvidence
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from smartcity_ingest.normalize import CATEGORY_LABELS, FEATURES
from smartcity_ingest.paths import CoverageArea, Paths
from smartcity_ingest.snapshot import Snapshot


def _load(p: Path) -> dict | None:
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def compute_stats(engine: Engine) -> dict:
    with Session(engine) as s:
        places = list(s.scalars(select(Place).where(Place.source == "osm")))
        n_evidence = len(list(s.scalars(select(PlaceEvidence.id))))
        runs = list(s.scalars(select(IngestRun).order_by(IngestRun.started_at.desc()).limit(10)))
    active = [p for p in places if p.active]
    by_cat = Counter(p.category for p in active)
    by_sub = Counter(f"{p.category}/{p.subcategory}" for p in active)
    feat: dict[str, Counter] = defaultdict(Counter)
    for p in active:
        for f in FEATURES:
            v = (p.amenities or {}).get(f, {}).get("value")
            feat[f]["true" if v is True else "false" if v is False else "unknown"] += 1
    basis = Counter()
    for p in active:
        for f in FEATURES:
            b = (p.amenities or {}).get(f, {}).get("basis")
            if b:
                basis[f"{f}:{b}"] += 1
    per_cat = {}
    for cat in CATEGORY_LABELS:
        ps = [p for p in active if p.category == cat]
        per_cat[cat] = {
            "count": len(ps),
            "with_opening_hours": sum(1 for p in ps if p.opening_hours_raw),
            "with_website": sum(1 for p in ps if p.website),
            "with_address": sum(1 for p in ps if (p.address or {}).get("formatted")),
            "generic_name": sum(1 for p in ps if p.name_is_generic),
            "polygon_geometry": sum(1 for p in ps if p.source_type != "node"),
        }
    last_complete = next((r for r in runs if r.status == "complete"), None)
    return {
        "total_rows": len(places),
        "active": len(active),
        "inactive_tombstones": len(places) - len(active),
        "by_category": dict(sorted(by_cat.items())),
        "by_subcategory": dict(sorted(by_sub.items())),
        "per_category": per_cat,
        "with_opening_hours": sum(1 for p in active if p.opening_hours_raw),
        "without_opening_hours": sum(1 for p in active if not p.opening_hours_raw),
        "with_website": sum(1 for p in active if p.website),
        "with_address": sum(1 for p in active if (p.address or {}).get("formatted")),
        "with_osm_description_tag": sum(1 for p in active if (p.tags or {}).get("description")),
        "generic_names": sum(1 for p in active if p.name_is_generic),
        "with_aliases": sum(1 for p in active if p.aliases),
        "by_source_type": dict(Counter(p.source_type for p in active)),
        "amenities": {f: dict(feat[f]) for f in FEATURES},
        "amenity_basis": dict(sorted(basis.items())),
        "evidence_rows": n_evidence,
        "source_updated_at_range": [
            min((p.source_updated_at for p in active if p.source_updated_at), default=None),
            max((p.source_updated_at for p in active if p.source_updated_at), default=None),
        ],
        "last_runs": [
            {
                "run_id": str(r.run_id),
                "status": r.status,
                "started_at": r.started_at.isoformat(),
                "dataset_version": r.dataset_version,
                "counts": {k: v for k, v in (r.counts or {}).items() if k != "dedup_merge_list"},
                "error": r.error_summary,
            }
            for r in runs[:5]
        ],
        "dedup_merges": (last_complete.counts or {}).get("dedup_merge_list", []) if last_complete else [],
    }


def _iso(v):
    return v.isoformat() if isinstance(v, datetime) else v


def write_reports(
    engine: Engine, snapshot: Snapshot, coverage: CoverageArea, paths: Paths, docs_path: Path | None = None
) -> dict:
    st = compute_stats(engine)
    st["source_updated_at_range"] = [_iso(v) for v in st["source_updated_at_range"]]
    map_m = _load(paths.map_dir / "manifest.json")
    idx_m = _load(paths.manifests / "index_manifest.json")
    lm = _load(paths.manifests / "landmarks.json")
    sm = snapshot.manifest
    manifest = {
        "generated_at": datetime.now(UTC).isoformat(),
        "dataset_version": snapshot.dataset_version,
        "source": {
            "name": "OpenStreetMap",
            "access": sm.get("source"),
            "endpoint": sm.get("endpoint"),
            "user_agent": sm.get("user_agent"),
            "editing_api_used": False,
            "tiles_prefetched": False,
        },
        "license": {
            "id": "ODbL-1.0",
            "url": "https://opendatacommons.org/licenses/odbl/1-0/",
            "attribution": "© OpenStreetMap contributors",
            "attribution_url": "https://www.openstreetmap.org/copyright",
        },
        "coverage": {
            "id": coverage.id,
            "name": coverage.name,
            "geometry": coverage.geojson,
            "bbox_lonlat": list(coverage.geometry.bounds),
        },
        "snapshot": {
            "path": str(snapshot.path.relative_to(REPO_ROOT))
            if snapshot.path.is_relative_to(REPO_ROOT)
            else str(snapshot.path),
            "status": sm.get("status"),
            "complete": snapshot.complete,
            "fetched_at": sm.get("fetched_at"),
            "osm_base_timestamp": sm.get("osm_base_timestamp"),
            "osm_base_timestamp_min": sm.get("osm_base_timestamp_min"),
            "retries": sm.get("retries", []),
            "snapshot_hash": snapshot.snapshot_hash,
            "groups": {
                k: {
                    kk: v.get(kk)
                    for kk in (
                        "status",
                        "elements",
                        "bytes",
                        "sha256",
                        "file_sha256",
                        "osm_base_timestamp",
                        "attempts",
                        "error",
                    )
                }
                for k, v in sm["groups"].items()
            },
            "queries": sm.get("queries"),
        },
        "places": st,
        "map": {k: map_m.get(k) for k in ("counts", "total_bytes", "buildings", "simplification", "layers")}
        if map_m
        else None,
        "index": idx_m,
        "landmarks": {
            "found": [
                {k: x.get(k) for k in ("key", "name", "osm", "centroid_lonlat")} for x in lm["landmarks"]
            ],
            "not_found": lm.get("not_found"),
        }
        if lm
        else None,
    }
    paths.manifests.mkdir(parents=True, exist_ok=True)
    (paths.manifests / "dataset_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, default=str) + "\n", encoding="utf-8"
    )
    docs_path = docs_path or (REPO_ROOT / "docs" / "DATA.md")
    docs_path.write_text(render_markdown(manifest, lm), encoding="utf-8")
    return {
        "dataset_manifest": str(paths.manifests / "dataset_manifest.json"),
        "docs": str(docs_path),
        "active_places": st["active"],
        "by_category": st["by_category"],
    }


def _row(*cells) -> str:
    return "| " + " | ".join(str(c) for c in cells) + " |"


def render_markdown(m: dict, lm: dict | None) -> str:
    st = m["places"]
    snap = m["snapshot"]
    L = []
    L.append("# Данные SmartCity")
    L.append("")
    L.append(
        "Документ сгенерирован командой `smartcity-ingest report` из БД и снимка; все числа вычислены, "
        "а не введены вручную. Не редактируйте таблицы руками — перегенерируйте отчёт."
    )
    L.append("")
    L.append("## Источник и лицензия")
    L.append(
        f"- Источник: OpenStreetMap, read-only Overpass API, endpoint `{m['source']['endpoint']}`. "
        "Editing API OSM 0.6 не используется, тайлы не запрашиваются."
    )
    L.append(
        "- Лицензия: Open Database License (ODbL) 1.0. Атрибуция обязательна: "
        "«© OpenStreetMap contributors» со ссылкой https://www.openstreetmap.org/copyright. "
        "База мест и слои карты — производная база данных OSM и распространяются на условиях ODbL "
        "(share-alike при публичном распространении производной базы)."
    )
    L.append(
        f"- Версия датасета: `{m['dataset_version']}`; снимок получен {snap['fetched_at']}; "
        f"OSM base timestamp групп: `{snap['osm_base_timestamp_min']}` … `{snap['osm_base_timestamp']}`; "
        f"статус снимка: **{snap['status']}**."
    )
    if snap.get("retries"):
        L.append(
            "- Повторная загрузка неудавшихся групп (`fetch --retry-failed`): "
            + "; ".join(f"{r['at']}: {', '.join(r['groups'])}" for r in snap["retries"])
            + ". Успешные группы сохранены без изменений; у каждой группы свой timestamp."
        )
    L.append(f"- snapshot_hash: `{snap['snapshot_hash']}`; путь: `{snap['path']}`.")
    bb = m["coverage"]["bbox_lonlat"]
    L.append(
        f"- Покрытие: `{m['coverage']['id']}` — {m['coverage']['name']}; bbox [lon,lat] "
        f"[{bb[0]}, {bb[1]}] – [{bb[2]}, {bb[3]}] (config/coverage.geojson). Вне покрытия данных нет."
    )
    L.append("")
    L.append("### Группы запросов Overpass")
    L.append(_row("группа", "статус", "элементов", "байт (raw)", "sha256 (raw)"))
    L.append(_row("---", "---", "---:", "---:", "---"))
    for k, g in snap["groups"].items():
        L.append(
            _row(
                k,
                g.get("status"),
                g.get("elements", "—"),
                g.get("bytes", "—"),
                f"`{(g.get('sha256') or '—')[:16]}…`" if g.get("sha256") else g.get("error", "—"),
            )
        )
    L.append("")
    L.append("## Места (таблица places, active=true)")
    L.append(
        f"Всего активных мест: **{st['active']}** (строк всего {st['total_rows']}, "
        f"tombstone {st['inactive_tombstones']})."
    )
    L.append("")
    L.append(_row("категория", "мест", "с часами", "с сайтом", "с адресом", "generic name", "полигон"))
    L.append(_row("---", "---:", "---:", "---:", "---:", "---:", "---:"))
    for cat, c in st["per_category"].items():
        L.append(
            _row(
                f"{cat} ({CATEGORY_LABELS[cat]})",
                c["count"],
                c["with_opening_hours"],
                c["with_website"],
                c["with_address"],
                c["generic_name"],
                c["polygon_geometry"],
            )
        )
    L.append("")
    L.append("Подкатегории: " + ", ".join(f"{k}: {v}" for k, v in st["by_subcategory"].items()) + ".")
    L.append("")
    L.append(f"- С opening_hours: {st['with_opening_hours']}; без: {st['without_opening_hours']}.")
    L.append(
        f"- С website (только http/https): {st['with_website']}; с адресом addr:*: {st['with_address']}; "
        f"с тегом description: {st['with_osm_description_tag']}."
    )
    L.append(
        f"- Безымянные детские площадки с серверной подписью «Детская площадка» (name_is_generic=true): "
        f"{st['generic_names']}."
    )
    L.append(
        f"- Тип исходного объекта: {st['by_source_type']}. Объединено дубликатов node→way/relation: "
        f"{len(st['dedup_merges'])}; мест с aliases: {st['with_aliases']}."
    )
    L.append(
        f"- Строк evidence (place_evidence): {st['evidence_rows']}. Диапазон source_updated_at: "
        f"{st['source_updated_at_range'][0]} … {st['source_updated_at_range'][1]}."
    )
    L.append("")
    L.append("### Признаки (amenities) по активным местам")
    L.append(_row("признак", "true", "false", "unknown"))
    L.append(_row("---", "---:", "---:", "---:"))
    for f, c in st["amenities"].items():
        L.append(_row(f, c.get("true", 0), c.get("false", 0), c.get("unknown", 0)))
    L.append("")
    L.append(
        "Основание (basis) непустых значений: "
        + ", ".join(f"{k}: {v}" for k, v in st["amenity_basis"].items())
        + "."
    )
    L.append(
        "Правила — docs/CONTRACTS.md §2. `unknown` означает отсутствие данных в OSM, а не «нет». "
        "Тишина/уют/розетки в большинстве мест в OSM не отмечены."
    )
    if st["dedup_merges"]:
        L.append("")
        L.append("### Объединённые дубликаты (последний complete-импорт)")
        L.append(_row("primary", "merged", "name", "distance, м"))
        L.append(_row("---", "---", "---", "---:"))
        for d in st["dedup_merges"]:
            L.append(_row(d["primary"], d["merged"], d["name"], d["distance_m"]))
    mp = m.get("map")
    if mp:
        L.append("")
        L.append("## Слои карты (data/map)")
        L.append(_row("слой", "объектов", "байт", "sha256"))
        L.append(_row("---", "---:", "---:", "---"))
        for k, v in mp["layers"].items():
            L.append(_row(k, v["features"], v["bytes"], f"`{v['sha256'][:16]}…`"))
        b = mp["buildings"]
        hp = b["height_provenance"]
        tot = sum(hp.values()) or 1
        L.append("")
        L.append(
            f"Высоты зданий: из `height` — {hp['height']} ({hp['height'] * 100 / tot:.1f}%), из "
            f"`building:levels`×3.2 м — {hp['levels']} ({hp['levels'] * 100 / tot:.1f}%), "
            f"по умолчанию 10 м (приближение) — {hp['default']} ({hp['default'] * 100 / tot:.1f}%). "
            f"Зданий с внутренними кольцами: {b['with_inner_rings']}. Источник высоты хранится в "
            "`height_source` каждого здания; значения `default` и `levels` — оценки."
        )
        simp = mp["simplification"]
        simp_txt = "применено к " + ", ".join(simp["layers"]) if simp["applied"] else "не применялось"
        L.append(
            f"Упрощение геометрии: {simp_txt}"
            "; здания не упрощаются. Дороги/вода/зелень обрезаны по полигону покрытия; здания, пересекающие "
            "границу, сохранены целиком."
        )
    idx = m.get("index")
    if idx:
        L.append("")
        L.append("## Embeddings")
        L.append(
            f"- Модель: `{idx['model_id']}` (provider {idx['provider']}, model {idx['model']}, "
            f"dim {idx['dim']}); строк для модели: {idx['rows_for_model']}; строк других моделей: "
            f"{idx['rows_other_models']}."
        )
        lr = idx["last_run"]
        L.append(
            f"- Последний запуск {lr['at']}: переиндексировано {lr['embedded']}, пропущено без изменений "
            f"{lr['skipped_unchanged']}."
        )
        L.append(
            "- Текст: имя, категория, подкатегория, кухня, адрес, описание из фактических полей. "
            "Инкрементальность: пропуск при совпадении content_hash и embedded_text_hash для активной "
            "модели; векторы разных моделей не смешиваются (model_id+dim)."
        )
    if lm:
        L.append("")
        L.append("## Ориентиры (A04, data/manifests/landmarks.json)")
        L.append(_row("ключ", "OSM", "имя", "центроид [lon, lat]"))
        L.append(_row("---", "---", "---", "---"))
        for x in lm["landmarks"]:
            osm = x["osm"] if isinstance(x["osm"], str) else f"{len(x['osm'])} ways ({x['osm'][0]}, …)"
            L.append(_row(x["key"], osm, x.get("name"), x["centroid_lonlat"]))
        if lm.get("not_found"):
            L.append(f"\nНе найдены в снимке: {', '.join(lm['not_found'])}.")
        pair = [
            c
            for c in lm["checks"]
            if c.get("from") in ("nur_alem", "expo_site") and c.get("to") == "mega_silk_way"
        ]
        for c in pair:
            L.append(
                f"\n{c['from']} → mega_silk_way: {c['distance_m']} м, азимут {c['bearing_deg']}° "
                f"({c['direction']})."
            )
    L.append("")
    L.append("## Ограничения")
    L.append(
        "- Данные OSM неполны и могут устаревать: часы работы, сайты и признаки есть не у всех мест; "
        "актуальность в реальном времени не гарантируется (дата снимка выше)."
    )
    L.append(
        "- Импортируются только именованные объекты категорий из CONTRACTS §1 (кроме детских площадок). "
        "Безымянные объекты остаются только на базовой карте."
    )
    L.append(
        "- Дедупликация node/way консервативна: та же категория + одинаковое нормализованное имя + точка "
        "внутри полигона или ≤60 м. Иные дубликаты (разные имена/категории) не объединяются."
    )
    L.append(
        "- Высоты зданий без тегов `height`/`building:levels` — единое приближение 10 м; `building:part` "
        "не используется (возможны упрощённые силуэты сложных зданий)."
    )
    L.append(
        "- Tombstone (active=false) ставится только после complete-снимка (все группы запросов успешны); "
        "partial/failed импорт ничего не деактивирует и не удаляет."
    )
    L.append("- Синтетические фикстуры находятся только в tests/fixtures/osm и используются только тестами.")
    L.append("")
    return "\n".join(L)
