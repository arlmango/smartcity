"""Reproduce the approved bounded build in a NEW named volume; never reuse or widen limits."""

import argparse
import json
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
IMAGE = "ghcr.io/valhalla/valhalla@sha256:58c7dd3fb256f306b00c558fb76aea9fd4fb804edd831e2b4847c26511cca507"


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", required=True, help="Fresh pilot name; existing volumes are refused")
    args = parser.parse_args()
    data = ROOT / "data/routing/pilot"
    artifacts = ROOT / "artifacts/routing-pilot"
    artifacts.mkdir(parents=True, exist_ok=True)
    volume = args.name + "-data"
    if volume in docker("volume", "ls", "-q").splitlines():
        raise SystemExit("Refusing existing volume; use a new name")
    image_bytes = int(json.loads(docker("image", "inspect", IMAGE))[0]["Size"])
    local_bytes = sum(p.stat().st_size for p in data.rglob("*") if p.is_file())
    for filename in ("astana-pilot.osm.pbf", "valhalla.json"):
        if not (data / filename).is_file():
            raise SystemExit(f"Missing prepared {filename}; run extraction first")
    disk_allowance = 3 * 1024**3 - image_bytes - local_bytes
    if disk_allowance <= 0:
        raise SystemExit("No disk budget remains")
    docker("volume", "create", volume)
    # Monitor inside the isolated container; do not mount Documents or fetch anything.
    shell = f'''timeout --kill-after=5 900 valhalla_build_tiles -c /data/valhalla.json \
 -j 1 /data/astana-pilot.osm.pbf &
child=$!
(while kill -0 "$child" 2>/dev/null; do
 size=$(du -sb /data | cut -f1)
 if [ "$size" -gt {disk_allowance} ]; then
  echo DISK_LIMIT; kill "$child"; sleep 5; kill -KILL "$child" 2>/dev/null; break
 fi
 sleep 1
done) &
monitor=$!
wait "$child"; result=$?
kill "$monitor" 2>/dev/null || true
echo MEMORY_PEAK_BYTES; cat /sys/fs/cgroup/memory.peak
echo OUTPUT_BYTES; du -sb /data
exit "$result"'''
    docker(
        "create",
        "--name",
        args.name,
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
        f"{volume}:/data",
        IMAGE,
        "bash",
        "-c",
        shell,
    )
    for filename in ("astana-pilot.osm.pbf", "valhalla.json"):
        docker("cp", str(data / filename), f"{args.name}:/data/{filename}")
    started = time.monotonic()
    interrupted = None
    with (artifacts / f"{args.name}.log").open("w") as log:
        try:
            subprocess.run(
                ["docker", "start", "-a", args.name],
                stdout=log,
                stderr=subprocess.STDOUT,
                timeout=910,
                check=False,
            )
        except (subprocess.TimeoutExpired, KeyboardInterrupt) as exc:
            interrupted = type(exc).__name__
        finally:
            state = json.loads(docker("inspect", args.name))[0]["State"]
            if state["Running"]:
                # Only our newly created, uniquely named container is touched.
                try:
                    subprocess.run(
                        ["docker", "stop", "-t", "5", args.name],
                        stdout=log,
                        stderr=log,
                        timeout=10,
                        check=True,
                    )
                except (subprocess.TimeoutExpired, subprocess.CalledProcessError):
                    subprocess.run(
                        ["docker", "kill", args.name], stdout=log, stderr=log, timeout=10, check=True
                    )
    state = json.loads(docker("inspect", args.name))[0]["State"]
    result = {
        "exit_code": state["ExitCode"],
        "interrupted": interrupted,
        "state": state,
        "seconds": time.monotonic() - started,
        "volume": volume,
        "image_bytes": image_bytes,
        "local_bytes": local_bytes,
        "limits": {
            "memory_gib": 2,
            "cpu": 2,
            "threads": 1,
            "build_timeout_seconds": 900,
            "total_disk_gib": 3,
        },
    }
    (artifacts / f"{args.name}.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    raise SystemExit(state["ExitCode"])


if __name__ == "__main__":
    main()
