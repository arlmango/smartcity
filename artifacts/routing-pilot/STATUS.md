# Local pedestrian pilot — built and integrated

User-approved volume approach succeeded after the earlier Documents bind mount failed.
The denied bind mount was not retried; global Docker/macOS file permissions stayed unchanged.

- Valhalla 3.8.3 ARM64, pinned official image `sha256:58c7dd3fb256f306b00c558fb76aea9fd4fb804edd831e2b4847c26511cca507`.
- Prepared extract: 2,077,208 bytes; 226,129 nodes, 39,440 complete ways, 1,744 restriction relations.
  No dangling way nodes/restriction ways. Original Kazakhstan PBF unchanged.
- Build in named volume `smartcity-route-pilot-8`, network none, 2 GiB memory/swap ceiling, 2 CPUs,
  one build thread, 900 seconds limit. Exit 0, OOMKilled=false, container elapsed 1.005 seconds.
- Cgroup memory peak 137,039,872 bytes (130.7 MiB); final volume 9,917,384 bytes (9.46 MiB).
  Image 979,291,594 bytes + local duplicate 2,086,696 + volume = 991,295,674 bytes, below 3 GiB.
  These are final disk sizes; the monitor did not sample a transient peak before the quick build ended.
- Serving only `127.0.0.1:8208` from own container `smartcity-route-local-8`, 512 MiB / 1 CPU,
  read-only volume. Docker internal-network host forwarding did not work; the serving container uses
  the ordinary Docker bridge with a loopback-only published port. No external route API requests.
- Separate test API `127.0.0.1:8108`, preview `127.0.0.1:3208`. Baseline stack unchanged.

## Geometry evidence

`control-audit.json` and `control-lines.geojson` retain three public control routes. Paths have
50–98 vertices per leg and lie within 0.06 m of source OSM highway geometry sampled every 5 m.
Outgoing routes: alley 702 m / 635.264 s; independence 708 m / 640.227 s; Mega 728 m / 661.839 s.
Return legs were independently calculated. Shapes include bends and differ between directions.

Mega's straight segment would cross 243.68 m of building interiors; the routed path crosses 0 m.
The audit excludes `building=roof`: the shared start passes under OSM canopy 1461813336, tagged
layer=1, min_height=5.9 m. This is an OSM topology check, not field validation of physical access.
Mega destination is an object centroid, 83.76 m from the snapped network endpoint. That gap is
shown honestly and its estimated access time is included; no invented connector/interior path is drawn.

## Reproduce

Use the existing local PBF with `scripts/routing_extract.py`, copy `config/valhalla-pilot.json`
to ignored `data/routing/pilot/valhalla.json`, then run `scripts/routing_pilot.py --name FRESH_NAME`.
The script refuses existing volumes, uses `docker cp` for only PBF/config, never downloads,
and bounds memory, CPU, disk and timeout; owned container is stopped on timeout/interruption.
A rebuild was not needed after successful graph creation. Its revised cleanup is separately checked.

Historical failed attempt remains in `build.log` / `build-result.json`. Successful build evidence:
`volume-build.log` / `volume-build-result.json`. Final integration checks and screenshots: `REPORT.md`.
