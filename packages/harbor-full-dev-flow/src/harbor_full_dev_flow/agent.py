from __future__ import annotations

import hashlib
import json
import stat
import re
import shlex
from pathlib import Path, PurePosixPath
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent, CliFlag, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


HARBOR_VERSION = "0.20.0"
NVM_TAG = "v0.40.2"
NODE_MAJOR = "22"
PI_VERSION = "0.82.1"
PI_PACKAGE = "@earendil-works/pi-coding-agent"
BUNDLE_REMOTE_ROOT = PurePosixPath("/opt/agent-orchestrator/harbor-runtime")
DEFAULT_AGENT_LOG_PATH = PurePosixPath("/logs/agent/full-dev-flow")
DEFAULT_ARTIFACT_PATH = PurePosixPath("/logs/artifacts")
PI_AUTH_REMOTE_DIR = PurePosixPath("/opt/agent-orchestrator/pi-auth")
PI_AUTH_REMOTE_FILE = PI_AUTH_REMOTE_DIR / "auth.json"
_SHA256 = re.compile(r"^[a-f0-9]{64}$", re.IGNORECASE)


class HarnessCompatibilityError(RuntimeError):
    """A deterministic pre-model incompatibility in a Harbor task/runtime."""


class FullDevFlowAgent(BaseInstalledAgent):
    """Thin Harbor installed-agent delegation to the existing TS core."""

    SUPPORTS_ATIF = True
    SUPPORTS_RESUME = False

    def __init__(
        self,
        logs_dir: Path,
        model_name: str | None = None,
        extra_env: dict[str, str] | None = None,
        compatibility_manifest_path: str | None = None,
        bundle_root: str | None = None,
        pi_auth_json_path: str | None = None,
        agent_workdir: str | None = None,
        max_cycles: int | None = None,
        max_fix_cycles: int | None = None,
        **kwargs: Any,
    ):
        if max_cycles is not None and (not isinstance(max_cycles, int) or isinstance(max_cycles, bool) or max_cycles < 1):
            raise HarnessCompatibilityError(
                "harness_incompatibility: max_cycles must be a positive integer"
            )
        if max_fix_cycles is not None and (not isinstance(max_fix_cycles, int) or isinstance(max_fix_cycles, bool)):
            raise HarnessCompatibilityError(
                "harness_incompatibility: max_fix_cycles must be a non-negative integer"
            )
        if max_fix_cycles is not None and max_fix_cycles < 0:
            raise HarnessCompatibilityError(
                "harness_incompatibility: max_fix_cycles must be a non-negative integer"
            )
        if max_cycles is not None and max_fix_cycles is not None:
            raise HarnessCompatibilityError(
                "harness_incompatibility: max_cycles and max_fix_cycles cannot both be configured"
            )
        if self.name() == "single-pi-subscription" and (max_cycles is not None or max_fix_cycles is not None):
            raise HarnessCompatibilityError(
                "harness_incompatibility: max_fix_cycles applies only to FullDevFlowAgent" if max_fix_cycles is not None else
                "harness_incompatibility: max_cycles applies only to FullDevFlowAgent"
            )
        super().__init__(logs_dir=logs_dir, model_name=model_name, extra_env=extra_env, **kwargs)
        self._compatibility_manifest_path = compatibility_manifest_path
        self._bundle_root_override = Path(bundle_root) if bundle_root else None
        # Explicit host input only; never infer it from HOME or inspect its contents.
        self._pi_auth_json_path = pi_auth_json_path
        self._agent_workdir_override = agent_workdir
        self._max_cycles = max_cycles if max_cycles is not None else (max_fix_cycles + 1 if max_fix_cycles is not None else None)
        self._legacy_max_fix_cycles = max_fix_cycles
        self._runtime_resolved: dict[str, Any] = {}
        self._session_mode = "unknown"
        self._session_evidence = "none"
    @staticmethod
    def name() -> str:
        return "full-dev-flow"

    def version(self) -> str:
        return "0.1.0"

    def get_version_command(self) -> str:
        return ". \"$HOME/.nvm/nvm.sh\"; pi --version"

    async def install(self, environment: BaseEnvironment) -> None:
        """Install the embedded JS bundle and pinned Pi runtime, without a model call."""
        bundle_root = self._bundle_root()
        manifest = self._read_bundle_manifest(bundle_root)
        try:
            uid, gid = await self._container_identity(environment)
            remote_parent = shlex.quote(str(BUNDLE_REMOTE_ROOT.parent))
            remote_root = shlex.quote(str(BUNDLE_REMOTE_ROOT))
            # Harbor upload_dir does not guarantee creation of missing parent
            # directories. Prepare only this controlled destination first and
            # make it readable/traversable by the default agent user.
            await self._exec_root(
                environment,
                f"mkdir -p {remote_parent} {remote_root} && "
                f"chown {uid}:{gid} {remote_parent} {remote_root} && "
                f"chmod 755 {remote_parent} {remote_root} && test -d {remote_root}",
            )
            await self._upload_bundle(environment, bundle_root, manifest)
            await self._exec_root(
                environment,
                "if ! command -v apt-get >/dev/null 2>&1; then exit 42; fi; "
                "apt-get update && apt-get install -y curl",
            )
            await self._exec_agent(
                environment,
                "set -euo pipefail; "
                "export NVM_DIR=\"$HOME/.nvm\"; "
                f"curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/{NVM_TAG}/install.sh | bash; "
                ". \"$NVM_DIR/nvm.sh\"; "
                f"nvm install {NODE_MAJOR}; nvm alias default {NODE_MAJOR}; "
                "node --version; npm --version",
            )
            node_result = await self._exec_agent(
                environment,
                "set -euo pipefail; export NVM_DIR=\"$HOME/.nvm\"; "
                ". \"$NVM_DIR/nvm.sh\"; node --version; npm --version",
            )
            node_version, npm_version = self._versions(node_result.stdout or "", 2)
            if not node_version.startswith(f"v{NODE_MAJOR}."):
                raise HarnessCompatibilityError(f"harness_incompatibility: resolved Node is {node_version!r}, expected major {NODE_MAJOR}")
            pi_result = await self._exec_agent(
                environment,
                "set -euo pipefail; export NVM_DIR=\"$HOME/.nvm\"; "
                ". \"$NVM_DIR/nvm.sh\"; "
                f"npm install -g {PI_PACKAGE}@{PI_VERSION}; pi --version",
            )
            pi_version = self._parse_pi_version(pi_result.stdout or "")
            if pi_version != PI_VERSION:
                raise HarnessCompatibilityError(f"harness_incompatibility: resolved Pi is {pi_version!r}, expected {PI_VERSION}")
            remote_hash = await self._exec_agent(
                environment,
                f"cd {shlex.quote(str(BUNDLE_REMOTE_ROOT))}; sha256sum dist/harbor-bridge.js",
            )
            self._assert_remote_bundle_hash(remote_hash.stdout or "", manifest)
        except HarnessCompatibilityError:
            raise
        except Exception as exc:
            raise HarnessCompatibilityError(f"harness_incompatibility: pinned runtime setup failed: {exc}") from exc

        self._runtime_resolved = {
            "harborVersion": HARBOR_VERSION,
            "nvmTag": NVM_TAG,
            "nodeMajor": NODE_MAJOR,
            "nodeVersion": node_version,
            "npmVersion": npm_version,
            "piPackage": PI_PACKAGE,
            "piVersion": PI_VERSION,
            "bundleSha256": manifest["bundleSha256"],
            "runtimeReproducibility": "version-pinned-not-cryptographically-reproducible",
        }
        self._write_host_json("runtime-resolved.json", self._runtime_resolved)

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        if not instruction.strip():
            raise HarnessCompatibilityError("harness_incompatibility: instruction is empty")
        compatibility = self._read_compatibility_manifest()
        workspace = await self._validate_compatibility(compatibility, environment)
        handoff = self._build_handoff(instruction, compatibility, workspace)
        bridge_context = self._build_bridge_context(compatibility, workspace)
        handoff_path = self._write_host_json("handoff.json", handoff)
        context_path = self._write_host_json("bridge-context.json", bridge_context)
        remote_log_dir = self._remote_agent_log_dir(compatibility)
        remote_handoff = str(remote_log_dir / "handoff.json")
        auth_source = self._validate_pi_auth_source()

        # Everything above is pure validation or host-side artifact creation.
        # Keep credentials out of the container until all of those checks have
        # passed, then guarantee cleanup even if setup/upload/bridge fails.
        primary_error: BaseException | None = None
        try:
            await self._install_pi_auth(environment, auth_source)
            # Harbor's agent log mount is not guaranteed to exist in a custom
            # task image. Create only the validated task-local path before
            # uploading; never create or inspect a broad host path.
            await self._exec_agent(environment, f"mkdir -p {shlex.quote(str(remote_log_dir))}")
            await environment.upload_file(handoff_path, remote_handoff)
            await environment.upload_file(context_path, str(remote_log_dir / "bridge-context.json"))
            command = (
                'set -euo pipefail; export NVM_DIR="$HOME/.nvm"; '
                '. "$NVM_DIR/nvm.sh"; '
                f"node {shlex.quote(str(BUNDLE_REMOTE_ROOT / 'dist' / 'harbor-bridge.js'))} "
                f"--handoff {shlex.quote(remote_handoff)}"
            )
            result = await self._exec_agent(
                environment,
                command,
                cwd=workspace,
                env={"PI_CODING_AGENT_DIR": str(PI_AUTH_REMOTE_DIR)},
            )
            if getattr(result, "return_code", 0) != 0:
                raise RuntimeError(f"Full dev-flow bridge failed with exit {result.return_code}")
        except BaseException as exc:
            primary_error = exc
            raise
        finally:
            try:
                await self._remove_pi_auth(environment)
            except HarnessCompatibilityError as cleanup_error:
                if primary_error is None:
                    raise
                # Do not silently replace the model-free primary failure with
                # cleanup noise. The fixed message is intentionally free of
                # command output and credential/path values.
                raise HarnessCompatibilityError(
                    f"harness_incompatibility: primary run failure ({type(primary_error).__name__}) preserved; "
                    "Pi auth cleanup also failed"
                ) from cleanup_error

    def populate_context_post_run(self, context: AgentContext) -> None:
        telemetry_path = self.logs_dir / "full-dev-flow" / "telemetry.json"
        try:
            telemetry = json.loads(telemetry_path.read_text(encoding="utf-8"))
            usage = telemetry.get("usage") if isinstance(telemetry, dict) else None
            if not isinstance(usage, dict):
                return
            context.n_input_tokens = _number_or_none(usage.get("inputTokens"))
            context.n_cache_tokens = _number_or_none(usage.get("cacheReadTokens"))
            context.n_output_tokens = _number_or_none(usage.get("outputTokens"))
            actual_cost = _number_or_none(usage.get("actualCostUsd"))
            context.cost_usd = actual_cost if actual_cost is not None else _number_or_none(usage.get("estimatedCostUsd"))
            context.metadata = {
                "harness": "full-dev-flow",
                "runId": telemetry.get("orchestration", {}).get("runId") if isinstance(telemetry.get("orchestration"), dict) else None,
                "artifactRefs": ["full-dev-flow/telemetry.json", "full-dev-flow/trajectory.json"],
                "normalizationWarnings": telemetry.get("provenance", {}).get("normalizationWarnings", []) if isinstance(telemetry.get("provenance"), dict) else [],
                "cyclePolicy": {
                    "requestedMaxCycles": self._max_cycles,
                    "appliedMaxCycles": telemetry.get("configuration", {}).get("maxCycles") if isinstance(telemetry.get("configuration"), dict) else None,
                    "legacyMaxFixCycles": self._legacy_max_fix_cycles,
                },
            }
        except (OSError, json.JSONDecodeError, AttributeError, TypeError):
            return

    def _bundle_root(self) -> Path:
        return self._bundle_root_override or Path(__file__).parent / "assets" / "runtime_bundle"

    @staticmethod
    def _read_bundle_manifest(bundle_root: Path) -> dict[str, Any]:
        path = bundle_root / "manifest.json"
        try:
            manifest = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise HarnessCompatibilityError(f"harness_incompatibility: runtime bundle manifest unavailable: {exc}") from exc
        if not isinstance(manifest, dict) or not isinstance(manifest.get("files"), list) or not _SHA256.fullmatch(str(manifest.get("bundleSha256", ""))):
            raise HarnessCompatibilityError("harness_incompatibility: invalid runtime bundle manifest")
        return manifest

    async def _upload_bundle(self, environment: BaseEnvironment, bundle_root: Path, manifest: dict[str, Any]) -> None:
        canonical_entries: list[str] = []
        for entry in manifest["files"]:
            if not isinstance(entry, dict) or not isinstance(entry.get("path"), str) or not _SHA256.fullmatch(str(entry.get("sha256", ""))):
                raise HarnessCompatibilityError("harness_incompatibility: invalid runtime bundle file entry")
            relative = PurePosixPath(entry["path"])
            if relative.is_absolute() or ".." in relative.parts:
                raise HarnessCompatibilityError("harness_incompatibility: runtime bundle path escapes root")
            local = bundle_root.joinpath(*relative.parts)
            if not local.is_file() or _file_sha256(local) != entry["sha256"]:
                raise HarnessCompatibilityError(f"harness_incompatibility: runtime bundle digest mismatch for {entry['path']}")
            canonical_entries.append(f"{entry['path']}\0{entry['sha256']}")
        canonical_digest = hashlib.sha256("\n".join(canonical_entries).encode()).hexdigest()
        if canonical_digest.lower() != str(manifest["bundleSha256"]).lower():
            raise HarnessCompatibilityError("harness_incompatibility: runtime bundle manifest digest mismatch")
        if not (bundle_root / "dist" / "harbor-bridge.js").is_file():
            raise HarnessCompatibilityError("harness_incompatibility: bridge asset is missing")
        await environment.upload_dir(bundle_root, str(BUNDLE_REMOTE_ROOT))

    async def _exec_root(self, environment: BaseEnvironment, command: str, **kwargs: Any) -> Any:
        return await self.exec_as_root(environment, command=command, **kwargs)

    async def _exec_agent(self, environment: BaseEnvironment, command: str, **kwargs: Any) -> Any:
        return await self.exec_as_agent(environment, command=command, **kwargs)

    @staticmethod
    def _validate_agent_workdir(workdir: object) -> str:
        if not isinstance(workdir, str) or not workdir.startswith("/") or "\0" in workdir:
            raise HarnessCompatibilityError(
                "harness_incompatibility: agent workdir must be an absolute task path"
            )
        return workdir

    @classmethod
    def _task_config_workdir(cls, environment: BaseEnvironment) -> str | None:
        """Return an explicitly configured task workdir, if Harbor supplied one.

        Harbor providers already apply the image's Dockerfile ``WORKDIR`` when
        ``cwd`` is omitted.  We must therefore not invent a fallback such as
        ``/workspace``: some benchmark tasks use ``/app`` while others use
        ``/workspace``.  An explicit ``[environment].workdir`` is passed
        through only after validating that it is a safe absolute task path.
        """
        config = getattr(environment, "task_env_config", None)
        workdir = getattr(config, "workdir", None)
        if workdir is None or workdir == "":
            return None
        return cls._validate_agent_workdir(workdir)

    def _agent_workdir(self, environment: BaseEnvironment) -> str | None:
        """Resolve an explicit agent kwarg before Harbor's task workdir."""
        if self._agent_workdir_override is not None:
            return self._validate_agent_workdir(self._agent_workdir_override)
        return self._task_config_workdir(environment)

    def _read_compatibility_manifest(self) -> dict[str, Any]:
        candidate = Path(self._compatibility_manifest_path) if self._compatibility_manifest_path else self.logs_dir / "full-dev-flow" / "task-compatibility.json"
        try:
            parsed = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise HarnessCompatibilityError(f"harness_incompatibility: compatibility manifest unavailable: {exc}") from exc
        if not isinstance(parsed, dict):
            raise HarnessCompatibilityError("harness_incompatibility: compatibility manifest must be an object")
        return parsed

    async def _validate_compatibility(self, metadata: dict[str, Any], environment: BaseEnvironment) -> str:
        if metadata.get("fullDevFlowCompatible") is not True or metadata.get("workspaceKind") != "git-repo" or metadata.get("requiresGitRepo") is not True or metadata.get("requiresCleanTree") is not True:
            raise HarnessCompatibilityError("harness_incompatibility: workspace compatibility is not approved")
        if metadata.get("testsVisibleToAgent") is not True or metadata.get("verifierMode") not in {"shared", "separate"}:
            raise HarnessCompatibilityError("harness_incompatibility: tests/verifier boundary is not explicit")
        allow_local_commit = metadata.get("allowLocalCommit")
        if not isinstance(allow_local_commit, bool):
            raise HarnessCompatibilityError("harness_incompatibility: allowLocalCommit must be explicit boolean")
        if allow_local_commit:
            raise HarnessCompatibilityError(
                "harness_incompatibility: commit-capable benchmark mode requires baseline-aware review evidence"
            )
        if metadata.get("incompatibilityReasons"):
            raise HarnessCompatibilityError("harness_incompatibility: compatibility manifest has incompatibility reasons")
        revision = str(metadata.get("datasetRevision", "")).strip()
        digest = str(metadata.get("taskDigest", ""))
        if not revision or revision.lower() == "latest" or not _SHA256.fullmatch(digest):
            raise HarnessCompatibilityError("harness_incompatibility: dataset revision/digest is not locked")
        workspace = str(metadata.get("agentWorkdir", ""))
        if not workspace.startswith("/") or "\0" in workspace:
            raise HarnessCompatibilityError("harness_incompatibility: agent workdir must be an absolute task path")
        try:
            top_level = await self._exec_agent(
                environment,
                f"test -d {shlex.quote(workspace)} && git -C {shlex.quote(workspace)} rev-parse --show-toplevel",
            )
            if getattr(top_level, "return_code", 0) != 0 or (top_level.stdout or "").strip() != workspace:
                raise HarnessCompatibilityError("workspace Git root does not exactly match the locked agentWorkdir")
            clean = await self._exec_agent(
                environment,
                f"test -z \"$(git -C {shlex.quote(workspace)} status --porcelain --untracked-files=all)\"",
            )
            if getattr(clean, "return_code", 0) != 0:
                raise HarnessCompatibilityError("workspace is not a clean Git repository")
        except HarnessCompatibilityError:
            raise
        except Exception as exc:
            raise HarnessCompatibilityError(f"harness_incompatibility: workspace preflight failed: {exc}") from exc
        return workspace

    def _validate_pi_auth_source(self) -> Path:
        candidate = self._pi_auth_json_path
        if not isinstance(candidate, str) or not candidate.strip() or "\0" in candidate:
            raise HarnessCompatibilityError("harness_incompatibility: explicit Pi auth file is required")
        path = Path(candidate)
        if not path.is_absolute():
            raise HarnessCompatibilityError("harness_incompatibility: explicit Pi auth path must be absolute")
        try:
            metadata = path.lstat()
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
                raise HarnessCompatibilityError("harness_incompatibility: explicit Pi auth path is not a regular file")
            if metadata.st_mode & 0o077:
                raise HarnessCompatibilityError("harness_incompatibility: explicit Pi auth file permissions are too broad")
        except HarnessCompatibilityError:
            raise
        except OSError as exc:
            raise HarnessCompatibilityError("harness_incompatibility: explicit Pi auth file is unavailable") from exc
        return path

    async def _install_pi_auth(self, environment: BaseEnvironment, source: Path) -> None:
        """Install explicit Pi auth at a controlled, non-logs path with mode 0600."""
        try:
            uid, gid = await self._container_identity(environment)
            remote = shlex.quote(str(PI_AUTH_REMOTE_FILE))
            remote_dir = shlex.quote(str(PI_AUTH_REMOTE_DIR))
            await self._exec_root(
                environment,
                f"mkdir -p {remote_dir} && chown {uid}:{gid} {remote_dir} && chmod 700 {remote_dir} && test -d {remote_dir}",
            )
            # upload_file may create the file as root; secure ownership and
            # mode only after the upload, while the directory is already
            # traversable by the default agent user.
            await environment.upload_file(source, str(PI_AUTH_REMOTE_FILE))
            await self._exec_root(
                environment,
                f"chown {uid}:{gid} {remote} && chmod 600 {remote} && test -f {remote}",
            )
            permission = await self._exec_agent(
                environment,
                f"test -f {remote} && test \"$(stat -c %a {remote})\" = 600",
            )
            if getattr(permission, "return_code", 0) != 0:
                raise HarnessCompatibilityError("harness_incompatibility: container Pi auth permissions were not secured")
        except HarnessCompatibilityError:
            raise
        except Exception as exc:
            raise HarnessCompatibilityError("harness_incompatibility: Pi auth injection failed") from exc

    async def _container_identity(self, environment: BaseEnvironment) -> tuple[str, str]:
        try:
            identity = await self._exec_agent(environment, "id -u; id -g")
        except Exception as exc:
            raise HarnessCompatibilityError("harness_incompatibility: container agent identity is unavailable") from exc
        identity_lines = [line.strip() for line in (identity.stdout or "").splitlines() if line.strip()]
        if len(identity_lines) != 2 or not all(line.isdigit() for line in identity_lines):
            raise HarnessCompatibilityError("harness_incompatibility: container agent identity is unavailable")
        return identity_lines[0], identity_lines[1]

    async def _remove_pi_auth(self, environment: BaseEnvironment) -> None:
        remote = shlex.quote(str(PI_AUTH_REMOTE_FILE))
        remote_dir = shlex.quote(str(PI_AUTH_REMOTE_DIR))
        try:
            # The security invariant is that the credential file is gone. The
            # controlled directory may contain unrelated runtime files, so its
            # best-effort removal must never turn a successful file cleanup
            # into a failed Harbor trial.
            result = await self._exec_root(
                environment,
                f"rm -f {remote} && test ! -e {remote} && (rmdir {remote_dir} 2>/dev/null || true)",
            )
        except Exception as exc:
            raise HarnessCompatibilityError("harness_incompatibility: Pi auth cleanup failed") from exc
        if getattr(result, "return_code", 0) != 0:
            raise HarnessCompatibilityError("harness_incompatibility: Pi auth cleanup failed")

    def _build_handoff(self, instruction: str, metadata: dict[str, Any], workspace: str) -> dict[str, Any]:
        tests = metadata.get("deterministicTests")
        if not isinstance(tests, list) or not tests or not all(isinstance(item, str) and item.strip() for item in tests):
            raise HarnessCompatibilityError("harness_incompatibility: deterministicTests must be a non-empty string list")
        include = _safe_scope_list(metadata.get("scopeInclude"), "scopeInclude", required=True)
        exclude = _safe_scope_list(metadata.get("scopeExclude"), "scopeExclude", required=False)
        acceptance = _string_list(metadata.get("acceptanceCriteria"), "acceptanceCriteria", required=True)
        risks = _string_list(metadata.get("riskNotes"), "riskNotes", required=False)
        allow_local_commit = metadata.get("allowLocalCommit")
        if not isinstance(allow_local_commit, bool):
            raise HarnessCompatibilityError("harness_incompatibility: allowLocalCommit must be explicit boolean")
        commit_invariant = (
            "Local commits are permitted only inside this locked disposable workspace; never push or mutate a remote."
            if allow_local_commit
            else "Do not commit, push, merge, deploy, or mutate any remote or external system."
        )
        return {
            "repo": workspace,
            "objective": instruction,
            "scope": {"include": include, "exclude": exclude},
            "policy": {"allowLocalCommit": allow_local_commit},
            "invariantsAndNonGoals": [
                "Preserve the Harbor task workspace and Git boundary.",
                "Do not read or use verifier reward as agent feedback.",
                commit_invariant,
                "Do not change the existing production orchestration policy.",
            ],
            "acceptanceCriteria": acceptance,
            "constraints": ["Use only the existing Agent Orchestrator core runner.", "Do not infer hidden verifier behavior."],
            "tests": tests,
            "riskNotes": risks,
            "delivery": {"mode": "direct_main", "requireApproval": True},
        }

    def _build_bridge_context(self, metadata: dict[str, Any], workspace: str) -> dict[str, Any]:
        return {
            "taskId": metadata.get("taskId"),
            "taskName": metadata.get("taskName"),
            "datasetRef": metadata.get("datasetRef"),
            "datasetRevision": metadata.get("datasetRevision"),
            "taskDigest": metadata.get("taskDigest"),
            "agentWorkdir": workspace,
            "agentLogDir": str(self._remote_agent_log_dir(metadata)),
            "artifactDir": str(metadata.get("artifactRoot", DEFAULT_ARTIFACT_PATH)),
            "maxTier": metadata.get("maxTier"),
            # The bridge explicitly applies maxTier and (when supplied) the
            # evaluation-only maxCycles cap. Keep all other requested values
            # as evidence rather than claiming unsupported controls were applied.
            "requestedConfiguration": {
                "model": self.model_name,
                "reasoningEffort": metadata.get("reasoningEffort"),
                "timeoutSeconds": metadata.get("timeoutSeconds"),
                "trialCount": metadata.get("trialCount"),
                "maxTier": metadata.get("maxTier"),
                "maxCycles": self._max_cycles,
                "legacyMaxFixCycles": self._legacy_max_fix_cycles,
            },
            "effectiveConfiguration": {
                "model": None,
                "reasoningEffort": None,
                "timeoutSeconds": None,
                "trialCount": None,
                "maxTier": metadata.get("maxTier"),
                "maxCycles": None,
                "note": "core wires maxTier and explicit maxCycles; other requested controls are not applied",
            },
            "maxCycles": self._max_cycles,
            "legacyMaxFixCycles": self._legacy_max_fix_cycles,
            "runtimeResolved": self._runtime_resolved,
            "compatibility": {
                key: metadata[key]
                for key in (
                    "schemaVersion", "taskId", "taskName", "datasetRef", "datasetRevision",
                    "taskDigest", "taskRef", "workspaceKind", "requiresGitRepo", "requiresCleanTree",
                    "agentWorkdir", "agentLogDir", "artifactRoot", "testsVisibleToAgent",
                    "verifierMode", "fullDevFlowCompatible", "incompatibilityReasons",
                    "allowLocalCommit", "deterministicTests", "scopeInclude", "scopeExclude", "acceptanceCriteria", "riskNotes",
                )
                if key in metadata
            },
        }

    @staticmethod
    def _remote_agent_log_dir(metadata: dict[str, Any]) -> PurePosixPath:
        value = str(metadata.get("agentLogDir", DEFAULT_AGENT_LOG_PATH))
        path = PurePosixPath(value)
        if not path.is_absolute() or ".." in path.parts:
            raise HarnessCompatibilityError("harness_incompatibility: agent log path is not an absolute task path")
        return path

    def _write_host_json(self, name: str, value: Any) -> Path:
        directory = self.logs_dir / "full-dev-flow"
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / name
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        path.chmod(0o600)
        return path

    @staticmethod
    def _versions(output: str, count: int) -> tuple[str, ...]:
        lines = [line.strip() for line in output.splitlines() if line.strip()]
        if len(lines) < count:
            raise HarnessCompatibilityError("harness_incompatibility: Node/npm versions were not reported")
        return tuple(lines[-count:])

    @staticmethod
    def _parse_pi_version(output: str) -> str:
        lines = [line.strip() for line in output.splitlines() if line.strip()]
        if not lines:
            raise HarnessCompatibilityError("harness_incompatibility: Pi version was not reported")
        value = lines[-1].removeprefix("pi ").removeprefix("v").strip()
        return value

    @staticmethod
    def _assert_remote_bundle_hash(output: str, manifest: dict[str, Any]) -> None:
        digest = output.strip().split()[0] if output.strip() else ""
        expected = next((entry.get("sha256") for entry in manifest["files"] if entry.get("path") == "dist/harbor-bridge.js"), None)
        if not digest or expected is None or digest.lower() != str(expected).lower():
            raise HarnessCompatibilityError("harness_incompatibility: remote bridge digest mismatch")


class SinglePiSubscriptionAgent(FullDevFlowAgent):
    """Single-invocation Pi wrapper with explicit subscription auth injection.

    This intentionally reuses only FullDevFlowAgent's narrow runtime/auth
    security helpers. It does not invoke the TypeScript bridge or any review,
    retry, or orchestration loop.
    """

    SUPPORTS_ATIF = True
    SUPPORTS_RESUME = False
    CLI_FLAGS = [
        CliFlag(
            "thinking",
            cli="--thinking",
            type="enum",
            choices=["off", "minimal", "low", "medium", "high", "xhigh"],
        ),
    ]
    _OUTPUT_FILENAME = "pi.txt"
    _REMOTE_LOG_DIR = PurePosixPath("/logs/agent/pi")

    @staticmethod
    def name() -> str:
        return "single-pi-subscription"

    def version(self) -> str:
        return PI_VERSION

    async def install(self, environment: BaseEnvironment) -> None:
        """Install only the pinned Pi fork; no model command is run here."""
        try:
            await self._exec_root(
                environment,
                "if ! command -v apt-get >/dev/null 2>&1; then exit 42; fi; "
                "apt-get update && apt-get install -y curl",
            )
            await self._exec_agent(
                environment,
                "set -euo pipefail; "
                "export NVM_DIR=\"$HOME/.nvm\"; "
                f"curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/{NVM_TAG}/install.sh | bash; "
                ". \"$NVM_DIR/nvm.sh\"; "
                f"nvm install {NODE_MAJOR}; nvm alias default {NODE_MAJOR}; "
                "node --version; npm --version",
            )
            node_result = await self._exec_agent(
                environment,
                "set -euo pipefail; export NVM_DIR=\"$HOME/.nvm\"; "
                ". \"$NVM_DIR/nvm.sh\"; node --version; npm --version",
            )
            node_version, npm_version = self._versions(node_result.stdout or "", 2)
            if not node_version.startswith(f"v{NODE_MAJOR}."):
                raise HarnessCompatibilityError(
                    f"harness_incompatibility: resolved Node is {node_version!r}, expected major {NODE_MAJOR}"
                )
            pi_result = await self._exec_agent(
                environment,
                "set -euo pipefail; export NVM_DIR=\"$HOME/.nvm\"; "
                ". \"$NVM_DIR/nvm.sh\"; "
                f"npm install -g {PI_PACKAGE}@{PI_VERSION}; pi --version",
            )
            pi_version = self._parse_pi_version(pi_result.stdout or "")
            if pi_version != PI_VERSION:
                raise HarnessCompatibilityError(
                    f"harness_incompatibility: resolved Pi is {pi_version!r}, expected {PI_VERSION}"
                )
        except HarnessCompatibilityError:
            raise
        except Exception as exc:
            raise HarnessCompatibilityError(
                f"harness_incompatibility: pinned Pi setup failed: {exc}"
            ) from exc

        self._runtime_resolved = {
            "harborVersion": HARBOR_VERSION,
            "nvmTag": NVM_TAG,
            "nodeMajor": NODE_MAJOR,
            "nodeVersion": node_version,
            "npmVersion": npm_version,
            "piPackage": PI_PACKAGE,
            "piVersion": PI_VERSION,
            "agent": self.name(),
            "runtimeReproducibility": "version-pinned-not-cryptographically-reproducible",
        }
        self._write_pi_json("runtime-resolved.json", self._runtime_resolved)

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        if not instruction.strip():
            raise HarnessCompatibilityError("harness_incompatibility: instruction is empty")
        if self.model_name != "openai-codex/gpt-5.6-luna":
            raise HarnessCompatibilityError(
                "harness_incompatibility: Single Pi requires provider-qualified openai-codex/gpt-5.6-luna"
            )
        if self._resolved_flags.get("thinking") != "medium":
            raise HarnessCompatibilityError(
                "harness_incompatibility: Single Pi requires Harbor thinking=medium"
            )
        auth_source = self._validate_pi_auth_source()
        remote_log_dir = self._REMOTE_LOG_DIR
        remote_auth_env = {"PI_CODING_AGENT_DIR": str(PI_AUTH_REMOTE_DIR)}
        # Do not hardcode /workspace.  When Harbor has an explicit task
        # workdir, pass it through; otherwise cwd=None lets the environment
        # provider honor the image's own WORKDIR (e.g. /app or /workspace).
        agent_cwd = self._agent_workdir(environment)
        escaped_instruction = shlex.quote(instruction)
        cli_flags = self.build_cli_flags()
        command = (
            ". \"$HOME/.nvm/nvm.sh\"; "
            f"pi --print --mode json --session-dir {shlex.quote(str(remote_log_dir / 'sessions'))} "
            "--provider openai-codex --model gpt-5.6-luna "
            f"{cli_flags} {escaped_instruction} "
            "2>&1 | grep -v '\"type\":\"message_update\"' | "
            f"stdbuf -oL tee {shlex.quote(str(remote_log_dir / self._OUTPUT_FILENAME))}"
        )

        primary_error: BaseException | None = None
        try:
            await self._install_pi_auth(environment, auth_source)
            session_probe = await self._exec_agent(
                environment,
                f"test ! -d {shlex.quote(str(remote_log_dir / 'sessions'))} || test -z \"$(find {shlex.quote(str(remote_log_dir / 'sessions'))} -mindepth 1 -print -quit)\"",
            )
            if getattr(session_probe, "return_code", 0) == 0:
                self._session_mode = "fresh"
                self._session_evidence = "preflight-empty-session-dir"
            else:
                self._session_mode = "reused"
                self._session_evidence = "explicit-reuse"
            await self._exec_agent(
                environment,
                f"mkdir -p {shlex.quote(str(remote_log_dir / 'sessions'))}",
            )
            result = await self._exec_agent(
                environment,
                command,
                cwd=agent_cwd,
                env=remote_auth_env,
            )
            if getattr(result, "return_code", 0) != 0:
                raise RuntimeError(f"Single Pi failed with exit {result.return_code}")
        except BaseException as exc:
            primary_error = exc
            raise
        finally:
            try:
                await self._remove_pi_auth(environment)
            except HarnessCompatibilityError as cleanup_error:
                if primary_error is None:
                    raise
                raise HarnessCompatibilityError(
                    f"harness_incompatibility: primary run failure ({type(primary_error).__name__}) preserved; "
                    "Pi auth cleanup also failed"
                ) from cleanup_error

    def populate_context_post_run(self, context: AgentContext) -> None:
        output_file = self.logs_dir / "pi" / self._OUTPUT_FILENAME
        usage = self._read_pi_usage(output_file)
        self._write_pi_atif(usage)
        if usage is None:
            return
        context.n_input_tokens = usage["inputTokens"]
        context.n_cache_tokens = usage["cacheReadTokens"]
        context.n_output_tokens = usage["outputTokens"]
        context.cost_usd = usage["costUsd"]
        context.metadata = {
            "harness": self.name(),
            "artifactRefs": ["pi/pi.txt", "pi/trajectory.json", "pi/runtime-resolved.json"],
            "usageSource": "Pi message_end output",
            # Call identity is sourced once by the Harbor aggregator from the
            # allowlisted pi/pi.txt message_end records.  Do not duplicate
            # calls in result metadata: Harbor's lifecycle may serialize both
            # message_start/message_end/turn_end snapshots here.
            "usage": usage,
            "provider": "openai-codex",
            "adapter": "single-pi",
            "packageVersion": PI_VERSION,
            "cacheSemanticsKey": "openai-codex/single-pi/@earendil-works/pi-coding-agent@0.82.1",
            "session": {"mode": self._session_mode, "scope": "trial", "sessionId": None, "evidence": self._session_evidence, "evidenceRefs": ["pi/session-preflight"]},
            "providerPromptCache": {"configured": None, "observed": usage["cacheReadTokens"] > 0 or usage["cacheWriteTokens"] > 0, "scope": "provider", "cacheReadTokens": usage["cacheReadTokens"], "cacheWriteTokens": usage["cacheWriteTokens"], "semanticsRef": "openai-codex/single-pi/@earendil-works/pi-coding-agent@0.82.1", "evidenceRefs": ["pi/pi.txt"]},
        }

    @staticmethod
    def _read_pi_usage(path: Path) -> dict[str, int | float] | None:
        if not path.exists():
            return None
        totals: dict[str, Any] = {"inputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0, "outputTokens": 0, "costUsd": 0.0}
        found = False
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeError):
            return None
        for line in lines:
            try:
                event = json.loads(line)
                if not isinstance(event, dict) or event.get("type") != "message_end":
                    continue
                message = event.get("message") if isinstance(event, dict) else None
                usage = message.get("usage") if isinstance(message, dict) else None
                if event.get("type") != "message_end" or not isinstance(usage, dict) or message.get("role") != "assistant":
                    continue
                found = True
                for key, source in (
                    ("inputTokens", "input"),
                    ("cacheReadTokens", "cacheRead"),
                    ("cacheWriteTokens", "cacheWrite"),
                    ("outputTokens", "output"),
                ):
                    value = usage.get(source)
                    if isinstance(value, (int, float)) and not isinstance(value, bool):
                        totals[key] += value
                cost = usage.get("cost")
                total = cost.get("total") if isinstance(cost, dict) else None
                if isinstance(total, (int, float)) and not isinstance(total, bool):
                    totals["costUsd"] += total
            except (json.JSONDecodeError, AttributeError, TypeError):
                continue
        return totals if found else None

    def _write_pi_atif(self, usage: dict[str, int | float] | None) -> None:
        metrics: dict[str, int | float] = {}
        if usage is not None:
            metrics = {
                "prompt_tokens": usage["inputTokens"] + usage["cacheReadTokens"] + usage["cacheWriteTokens"],
                "uncached_input_tokens": usage["inputTokens"],
                "cached_tokens": usage["cacheReadTokens"],
                "cache_write_tokens": usage["cacheWriteTokens"],
                "completion_tokens": usage["outputTokens"],
                "cost": usage["costUsd"],
            }
        atif = {
            "schema_version": "ATIF-v1.0",
            "agent": {"name": self.name(), "version": self.version()},
            "steps": [],
            "final_metrics": metrics,
        }
        try:
            self._write_pi_json("trajectory.json", atif)
        except OSError:
            return

    def _write_pi_json(self, name: str, value: Any) -> Path:
        pi_logs_dir = self.logs_dir / "pi"
        pi_logs_dir.mkdir(parents=True, exist_ok=True)
        path = pi_logs_dir / name
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        path.chmod(0o600)
        return path


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _number_or_none(value: Any) -> int | float | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _string_list(value: Any, field: str, *, required: bool) -> list[str]:
    if not isinstance(value, list) or (required and not value) or not all(isinstance(item, str) and item.strip() for item in value):
        requirement = "a non-empty" if required else "a"
        raise HarnessCompatibilityError(f"harness_incompatibility: {field} must be {requirement} string list")
    return list(value)


def _safe_scope_list(value: Any, field: str, *, required: bool) -> list[str]:
    values = _string_list(value, field, required=required)
    for item in values:
        path = PurePosixPath(item)
        if path.is_absolute() or ".." in path.parts or "\\" in item or "\0" in item:
            raise HarnessCompatibilityError(f"harness_incompatibility: {field} contains an unsafe relative path")
    return values
