"""Rebuild a small routing PBF from the committed Overpass road snapshot (no network).

The snapshot keeps every way's OSM node ids, geometry and tags, so the topology is the real
OSM topology inside the EXPO/MEGA coverage box. It is smaller than the Mac pilot extract
(highways only, coverage box only); report it as such, never as the same graph.

Run with pyosmium, e.g.: uv run --with osmium==4.3.2 python scripts/routing_snapshot_extract.py \
  --snapshot osm-20261018T200514Z --out data/routing/snapshot/astana-snapshot.osm.pbf
"""

import argparse
import gzip
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_ways(snapshot: str) -> list[dict]:
    path = ROOT / "data/snapshots" / snapshot / "map_roads.json.gz"
    data = json.loads(gzip.decompress(path.read_bytes()))
    return [e for e in data["elements"] if e.get("type") == "way" and e.get("tags", {}).get("highway")]


def collect(ways: list[dict]) -> tuple[dict[int, tuple[float, float]], list[dict]]:
    nodes: dict[int, tuple[float, float]] = {}
    for w in ways:
        if len(w["nodes"]) != len(w["geometry"]):
            raise SystemExit(f"way/{w['id']}: node/geometry length mismatch")
        for nid, g in zip(w["nodes"], w["geometry"], strict=True):
            point = (round(g["lon"], 7), round(g["lat"], 7))
            if nodes.setdefault(nid, point) != point:
                raise SystemExit(f"node/{nid}: conflicting coordinates in snapshot")
    return nodes, sorted(ways, key=lambda w: w["id"])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    import osmium  # optional dependency, only for this script

    nodes, ways = collect(load_ways(args.snapshot))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.unlink(missing_ok=True)
    writer = osmium.SimpleWriter(str(out))
    try:
        for nid in sorted(nodes):
            lon, lat = nodes[nid]
            writer.add_node(osmium.osm.mutable.Node(id=nid, location=(lon, lat), version=1))
        for w in ways:
            writer.add_way(osmium.osm.mutable.Way(id=w["id"], nodes=w["nodes"], tags=w["tags"], version=1))
    finally:
        writer.close()
    report = {
        "snapshot": args.snapshot,
        "ways": len(ways),
        "nodes": len(nodes),
        "bytes": out.stat().st_size,
        "sha256": hashlib.sha256(out.read_bytes()).hexdigest(),
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
