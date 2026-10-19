# Pilot blocked before graph build

Approved official ARM64 image downloaded successfully, pinned digest:
`sha256:58c7dd3fb256f306b00c558fb76aea9fd4fb804edd831e2b4847c26511cca507`.
Installed image size 979291594 bytes (~934 MiB).

Local extract succeeded in 109.7 seconds: 2077208 bytes, 226129 nodes, 39440 complete ways,
1744 restriction relations. Explicit reference validation passed (no dangling way nodes/restriction ways).
See extract.json. Source PBF and original checkout unchanged. Generated PBF/config remain in
`data/routing/pilot`; data/routing ignored by git. Reproducible config retained in config/valhalla-pilot.json.

Attempted action: run `valhalla_build_tiles` in container `smartcity-route-build-8`, mounting
`/Users/mango/Documents/Codex/2026-10-19/task-8/smartcity/data/routing/pilot` to `/data`.
Docker denied the bind mount:
`mkdir /host_mnt/Users/mango/Documents: operation not permitted`.
Exit 125 after 6.02 seconds. Container inspected: status=created, Running=false,
StartedAt=0001-01-01T00:00:00Z. The graph builder never executed. No OOM or timeout.
Memory limit 2147483648, NanoCPUs 2000000000, network=none were recorded in container configuration.
This is Docker/macOS filesystem access, not an automatic approval-review rejection.

Per instruction, stopped the pilot. No retry of the denied mount, no broader file-sharing permission,
no Docker-global change, no resource increase. Baseline web/api/Ollama/DB still running on their original ports.
No graph, routed API/UI integration, routing tests, or routing screenshots exist yet; earlier comparison
iteration remains intact. Current config/script compile; ruff check passes. No fake line added.

Proposed next safe step, pending parent approval: create an isolated named Docker volume, use `docker cp`
to copy the existing 2 MiB extract/config into a stopped pilot container, then build from that volume
under the SAME limits. This avoids requiring Docker access to the host Documents folder. Monitor combined
image+volume+local duplicate size under 3 GiB; retain 2 GiB RAM, 2 CPUs, -j1, 900s timeout, no network during build.
Serving should remain local-only on a separate port, with no external geolocation API.

Existing Library screenshots from iteration 1 remain:
- Desktop: libfile_eabd057d23808191bbcf02abb2a65c9c / file_0000000004bc81fbaeae496c1387d4c2
- Mobile: libfile_e38badbeae348191b7b39a2464938cd6 / file_00000000d70081f8b19fdb3f3a8c133e
