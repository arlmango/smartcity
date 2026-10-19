"""Build wrapper must stop only its owned container when attaching is interrupted."""

import importlib.util
import json
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

spec = importlib.util.spec_from_file_location("pilot", Path(__file__).parents[1] / "routing_pilot.py")
pilot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)


@pytest.mark.parametrize("interruption", [subprocess.TimeoutExpired("docker", 910), KeyboardInterrupt()])
def test_interruption_stops_owned_container(tmp_path, interruption):
    data = tmp_path / "data/routing/pilot"
    data.mkdir(parents=True)
    for filename in ("astana-pilot.osm.pbf", "valhalla.json"):
        (data / filename).write_text("prepared")
    inspections = iter([{"Running": True, "ExitCode": 0}, {"Running": False, "ExitCode": 137}])

    def docker(*args):
        if args[:2] == ("image", "inspect"):
            return json.dumps([{"Size": 100}])
        if args[0] == "inspect":
            return json.dumps([{"State": next(inspections)}])
        return ""

    with (
        patch.object(pilot, "ROOT", tmp_path),
        patch.object(pilot, "docker", side_effect=docker),
        patch("sys.argv", ["pilot", "--name", "isolated-test"]),
        patch.object(
            pilot.subprocess, "run", side_effect=[interruption, subprocess.TimeoutExpired("stop", 10), None]
        ) as run,
    ):
        with pytest.raises(SystemExit) as exited:
            pilot.main()
    assert exited.value.code == 137
    assert run.call_args_list[1].args[0] == ["docker", "stop", "-t", "5", "isolated-test"]
    assert run.call_args_list[2].args[0] == ["docker", "kill", "isolated-test"]
    result = json.loads((tmp_path / "artifacts/routing-pilot/isolated-test.json").read_text())
    assert result["interrupted"] == type(interruption).__name__
    assert result["state"]["Running"] is False
