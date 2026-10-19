"""Run only the approved bounded graph build; never widen limits on failure."""

import json
import subprocess
import time
from pathlib import Path

root = Path(__file__).resolve().parents[1]
data = root / "data/routing/pilot"
art = root / "artifacts/routing-pilot"
image = "ghcr.io/valhalla/valhalla@sha256:58c7dd3fb256f306b00c558fb76aea9fd4fb804edd831e2b4847c26511cca507"
image_bytes = 979291594
name = "smartcity-route-build-8"
command = [
    "docker",
    "run",
    "--name",
    name,
    "--network",
    "none",
    "--memory",
    "2g",
    "--memory-swap",
    "2g",
    "--cpus",
    "2",
    "--pids-limit",
    "128",
    "-v",
    f"{data}:/data",
    image,
    "bash",
    "-c",
    "timeout 900 valhalla_build_tiles -c /data/valhalla.json -j 1 /data/astana-pilot.osm.pbf; "
    'result=$?; echo MEMORY_PEAK_BYTES; cat /sys/fs/cgroup/memory.peak; exit "$result"',
]
start = time.monotonic()
peak_disk = 0
stopped = None
with (art / "build.log").open("w") as log:
    p = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
    while p.poll() is None:
        size = sum(f.stat().st_size for f in data.rglob("*") if f.is_file())
        peak_disk = max(peak_disk, size)
        if size + image_bytes > 3 * 1024**3 or time.monotonic() - start > 910:
            stopped = "disk_limit" if size + image_bytes > 3 * 1024**3 else "time_limit"
            subprocess.run(["docker", "stop", "-t", "5", name], check=False, stdout=log, stderr=log)
            break
        time.sleep(2)
    code = p.wait()
result = {
    "exit_code": code,
    "seconds": round(time.monotonic() - start, 2),
    "peak_output_bytes_sampled": peak_disk,
    "image_bytes": image_bytes,
    "stopped": stopped,
    "limits": {"memory_gib": 2, "cpu": 2, "threads": 1, "build_timeout_seconds": 900, "total_disk_gib": 3},
}
(art / "build-result.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))
raise SystemExit(code)
