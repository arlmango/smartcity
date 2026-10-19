import json,time,osmium
from collections import Counter
p='/Users/mango/smartcity/data/cache/osm/kazakhstan-261018.osm.pbf'
bounds={'coverage':(71.390,51.075,71.445,51.115),'pilot_buffer':(71.35,51.04,71.48,51.15),'city':(71.15,50.83,71.85,51.38)}
ids={k:set() for k in bounds}; counts={k:Counter() for k in bounds}; started=time.monotonic()
class Nodes(osmium.SimpleHandler):
 def node(self,n):
  if not n.location.valid(): return
  x,y=n.location.lon,n.location.lat
  for k,(w,s,e,no) in bounds.items():
   if w<=x<=e and s<=y<=no: ids[k].add(n.id)
class Ways(osmium.SimpleHandler):
 def way(self,w):
  h=w.tags.get('highway')
  if not h:return
  for k,v in ids.items():
   if any(n.ref in v for n in w.nodes): counts[k][h]+=1
Nodes().apply_file(p);Ways().apply_file(p)
print(json.dumps({'elapsed_seconds':round(time.monotonic()-started,2),'note':'Read-only count; ways with at least one node inside bbox. Not a complete extracted graph, no topology validation.','regions':{k:{'bbox':b,'nodes':len(ids[k]),'highway_ways':sum(counts[k].values()),'highways':dict(counts[k])} for k,b in bounds.items()}},indent=2))
