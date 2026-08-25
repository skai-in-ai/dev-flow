#!/usr/bin/env python3
"""Build a dependency-free wheel with the already-built JS bundle embedded."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import sys
import zipfile
from pathlib import Path


VERSION = "0.1.0"
DIST_NAME = "agent_orchestrator_harbor_full_dev_flow"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build(repo_root: Path, output_dir: Path) -> Path:
    package_root = repo_root / "packages" / "harbor-full-dev-flow"
    source_root = package_root / "src" / "harbor_full_dev_flow"
    dist_root = repo_root / "dist"
    bridge = dist_root / "harbor-bridge.js"
    if not bridge.is_file():
        raise SystemExit("build-wheel requires npm run build and dist/harbor-bridge.js")

    def is_runtime_asset(path: Path) -> bool:
        relative = path.relative_to(dist_root).as_posix()
        # The wheel carries the bridge's import graph only.  Test bundles,
        # source maps and extension entrypoints are not runtime dependencies
        # and can accidentally expose development-only code in a task image.
        return not (
            relative.startswith("test/")
            or "/test/" in relative
            or relative.startswith("extensions/")
            or relative.endswith(".test.js")
            or relative.endswith(".test.js.map")
        )

    dist_files = sorted(path for path in dist_root.rglob("*") if path.is_file() and is_runtime_asset(path))
    entries = []
    for path in dist_files:
        relative = path.relative_to(dist_root).as_posix()
        entries.append({"path": f"dist/{relative}", "sha256": sha256(path)})
    canonical = "\n".join(f"{entry['path']}\0{entry['sha256']}" for entry in entries).encode()
    manifest = {
        "schemaVersion": "harbor-runtime-bundle-1",
        "harborVersion": "0.20.0",
        "devFlowBundleVersion": VERSION,
        "nodeMajor": "22",
        "nvmTag": "v0.40.2",
        "piPackage": "@earendil-works/pi-coding-agent",
        "piVersion": "0.82.1",
        "runtimeReproducibility": "version-pinned-not-cryptographically-reproducible",
        "files": entries,
        "bundleSha256": hashlib.sha256(canonical).hexdigest(),
    }

    wheel_name = f"{DIST_NAME}-{VERSION}-py3-none-any.whl"
    output_dir.mkdir(parents=True, exist_ok=True)
    wheel_path = output_dir / wheel_name
    records: list[tuple[str, str, int]] = []

    def add_bytes(archive: zipfile.ZipFile, name: str, data: bytes) -> None:
        archive.writestr(name, data)
        encoded = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
        records.append((name, f"sha256={encoded}", len(data)))

    with zipfile.ZipFile(wheel_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for source in sorted(source_root.rglob("*.py")):
            name = f"harbor_full_dev_flow/{source.relative_to(source_root).as_posix()}"
            add_bytes(archive, name, source.read_bytes())
        add_bytes(archive, "harbor_full_dev_flow/assets/runtime_bundle/manifest.json", (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode())
        for path in dist_files:
            name = f"harbor_full_dev_flow/assets/runtime_bundle/dist/{path.relative_to(dist_root).as_posix()}"
            add_bytes(archive, name, path.read_bytes())

        dist_info = f"{DIST_NAME}-{VERSION}.dist-info"
        metadata = (
            "Metadata-Version: 2.1\n"
            f"Name: agent-orchestrator-harbor-full-dev-flow\n"
            f"Version: {VERSION}\n"
            "Summary: Thin Harbor 0.20.0 installed-agent wrapper\n"
            "Requires-Python: >=3.11\n"
        ).encode()
        wheel = b"Wheel-Version: 1.0\nGenerator: agent-orchestrator-build-wheel\nRoot-Is-Purelib: true\nTag: py3-none-any\n"
        add_bytes(archive, f"{dist_info}/METADATA", metadata)
        add_bytes(archive, f"{dist_info}/WHEEL", wheel)
        record_name = f"{dist_info}/RECORD"
        rows = [*records, (record_name, "", 0)]
        record_data = "".join(f"{name},{digest},{size}\n" for name, digest, size in rows).encode()
        archive.writestr(record_name, record_data)
    return wheel_path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent / "dist")
    args = parser.parse_args()
    print(build(args.repo_root.resolve(), args.output.resolve()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
