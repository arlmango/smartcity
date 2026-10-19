"""Bounded pilot extract: complete touching ways + restriction dependencies; no downloads."""

import json
import sys
import time
from pathlib import Path

import osmium

source, output = map(Path, sys.argv[1:3])
bbox = (71.35, 51.04, 71.48, 51.15)
started = time.monotonic()
pool = osmium.io.ThreadPool(1)
nodes, ways, restrictions = set(), set(), set()
for n in osmium.FileProcessor(str(source), osmium.osm.NODE, thread_pool=pool):
    if n.location.valid() and bbox[0] <= n.lon <= bbox[2] and bbox[1] <= n.lat <= bbox[3]:
        nodes.add(n.id)
for w in osmium.FileProcessor(str(source), osmium.osm.WAY, thread_pool=pool):
    if any(n.ref in nodes for n in w.nodes):
        ways.add(w.id)
for r in osmium.FileProcessor(str(source), osmium.osm.RELATION, thread_pool=pool):
    if r.tags.get("type") == "restriction" and any(m.type == "w" and m.ref in ways for m in r.members):
        restrictions.add(r.id)
with osmium.BackReferenceWriter(
    str(output), str(source), remove_tags=False, relation_depth=2, thread_pool=pool
) as writer:
    for obj in osmium.FileProcessor(str(source), thread_pool=pool):
        if (
            (obj.is_node() and obj.id in nodes)
            or (obj.is_way() and obj.id in ways)
            or (obj.is_relation() and obj.id in restrictions)
        ):
            writer.add(obj)
# Ensure no dangling way nodes or restriction way members.
node_ids, way_ids, needed_nodes, needed_ways = set(), set(), set(), set()
for obj in osmium.FileProcessor(str(output), thread_pool=pool):
    if obj.is_node():
        node_ids.add(obj.id)
    elif obj.is_way():
        way_ids.add(obj.id)
        needed_nodes.update(n.ref for n in obj.nodes)
    elif obj.is_relation():
        needed_ways.update(m.ref for m in obj.members if m.type == "w")
assert not needed_nodes - node_ids, "dangling node references"
assert not needed_ways - way_ids, "dangling restriction ways"
print(
    json.dumps(
        {
            "bbox": bbox,
            "source": source.name,
            "bytes": output.stat().st_size,
            "nodes": len(node_ids),
            "ways": len(way_ids),
            "restrictions": len(restrictions),
            "reference_complete": True,
            "seconds": round(time.monotonic() - started, 2),
        },
        indent=2,
    )
)
