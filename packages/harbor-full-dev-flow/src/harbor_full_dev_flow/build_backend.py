"""Small PEP 517 adapter that delegates to the repository wheel builder."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def build_wheel(wheel_directory: str, config_settings=None, metadata_directory=None) -> str:
    package_root = Path(__file__).resolve().parents[2]
    builder = package_root / "build-wheel.py"
    result = subprocess.run(
        [sys.executable, str(builder), "--repo-root", str(package_root.parents[1]), "--output", wheel_directory],
        check=True,
        capture_output=True,
        text=True,
    )
    return Path(result.stdout.strip().splitlines()[-1]).name


def prepare_metadata_for_build(metadata_directory: str, config_settings=None) -> str:
    name = "agent_orchestrator_harbor_full_dev_flow-0.1.0.dist-info"
    target = Path(metadata_directory) / name
    target.mkdir(parents=True, exist_ok=True)
    (target / "METADATA").write_text(
        "Metadata-Version: 2.1\nName: agent-orchestrator-harbor-full-dev-flow\nVersion: 0.1.0\nRequires-Python: >=3.11\n",
        encoding="utf-8",
    )
    (target / "WHEEL").write_text("Wheel-Version: 1.0\nGenerator: agent-orchestrator-build-wheel\nRoot-Is-Purelib: true\nTag: py3-none-any\n", encoding="utf-8")
    return name
