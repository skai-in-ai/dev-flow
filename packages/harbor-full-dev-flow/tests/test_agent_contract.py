from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import types
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PACKAGE_ROOT.parents[1]
sys.path.insert(0, str(PACKAGE_ROOT / "src"))

# The production package must import the real Harbor API.  Unit tests inject a
# deliberately tiny stand-in before import; this is not a production fallback.
base_module = types.ModuleType("harbor.agents.installed.base")
class FakeCliFlag:
    def __init__(self, kwarg, **kwargs):
        self.kwarg = kwarg

class FakeBaseInstalledAgent:
    def __init__(self, logs_dir, model_name=None, extra_env=None, **kwargs):
        self.logs_dir = Path(logs_dir)
        self.model_name = model_name
        self.extra_env = extra_env or {}
        self._resolved_flags = {"thinking": kwargs.get("thinking")} if "thinking" in kwargs else {}

    def build_cli_flags(self):
        value = self._resolved_flags.get("thinking")
        return f"--thinking {value}" if value else ""

    async def exec_as_root(self, environment, command, **kwargs):
        return await environment.exec(command, user="root", **kwargs)

    async def exec_as_agent(self, environment, command, **kwargs):
        return await environment.exec(command, **kwargs)

base_module.BaseInstalledAgent = FakeBaseInstalledAgent
base_module.CliFlag = FakeCliFlag
base_module.with_prompt_template = lambda function: function
environment_module = types.ModuleType("harbor.environments.base")
environment_module.BaseEnvironment = object
context_module = types.ModuleType("harbor.models.agent.context")
context_module.AgentContext = object
sys.modules.update({
    "harbor": types.ModuleType("harbor"),
    "harbor.agents": types.ModuleType("harbor.agents"),
    "harbor.agents.installed": types.ModuleType("harbor.agents.installed"),
    "harbor.agents.installed.base": base_module,
    "harbor.environments": types.ModuleType("harbor.environments"),
    "harbor.environments.base": environment_module,
    "harbor.models": types.ModuleType("harbor.models"),
    "harbor.models.agent": types.ModuleType("harbor.models.agent"),
    "harbor.models.agent.context": context_module,
})
from harbor_full_dev_flow.agent import (  # noqa: E402
    FullDevFlowAgent,
    HarnessCompatibilityError,
    SinglePiSubscriptionAgent,
)


class FakeEnvironment:
    def __init__(
        self,
        pi_version: str = "0.82.1",
        bundle_root: Path | None = None,
        git_top_level: str = "/solution",
        workdir: str | None = None,
    ):
        self.commands: list[str] = []
        self.events: list[str] = []
        self.exec_kwargs: list[dict[str, object]] = []
        self.uploads: list[tuple[Path, str]] = []
        self.pi_version = pi_version
        self.bundle_root = bundle_root
        self.git_top_level = git_top_level
        self.task_env_config = SimpleNamespace(workdir=workdir)

    async def upload_dir(self, source_dir: Path, target_dir: str):
        self.events.append(f"upload_dir:{target_dir}")
        self.uploads.append((Path(source_dir), target_dir))

    async def upload_file(self, source_path: Path, target_path: str):
        self.events.append(f"upload_file:{target_path}")
        self.uploads.append((Path(source_path), target_path))

    async def exec(self, command: str, **kwargs):
        self.commands.append(command)
        self.events.append(f"exec:{command}")
        self.exec_kwargs.append(kwargs)
        if "sha256sum dist/harbor-bridge.js" in command:
            if self.bundle_root is None:
                raise AssertionError("fake environment requires bundle_root")
            digest = hashlib.sha256((self.bundle_root / "dist" / "harbor-bridge.js").read_bytes()).hexdigest()
            return SimpleNamespace(return_code=0, stdout=f"{digest}  dist/harbor-bridge.js\n", stderr="")
        if "npm install -g" in command:
            return SimpleNamespace(return_code=0, stdout=f"{self.pi_version}\n", stderr="")
        if "node --version; npm --version" in command:
            return SimpleNamespace(return_code=0, stdout="v22.14.0\n10.9.2\n", stderr="")
        if "rev-parse --show-toplevel" in command:
            return SimpleNamespace(return_code=0, stdout=f"{self.git_top_level}\n", stderr="")
        if command == "id -u; id -g":
            return SimpleNamespace(return_code=0, stdout="1000\n1000\n", stderr="")
        if "stat -c %a" in command:
            return SimpleNamespace(return_code=0, stdout="", stderr="")
        return SimpleNamespace(return_code=0, stdout="", stderr="")


class CleanupEnvironment(FakeEnvironment):
    def __init__(self, *, remove_succeeds: bool):
        super().__init__()
        self.auth_present = True
        self.remove_succeeds = remove_succeeds

    async def exec(self, command: str, **kwargs):
        result = await super().exec(command, **kwargs)
        if command.startswith("rm -f /opt/agent-orchestrator/pi-auth/auth.json"):
            if self.remove_succeeds:
                self.auth_present = False
            if self.auth_present and "test ! -e /opt/agent-orchestrator/pi-auth/auth.json" in command:
                result.return_code = 1
        return result


def make_bundle(root: Path) -> Path:
    dist = root / "dist"
    dist.mkdir(parents=True)
    bridge = dist / "harbor-bridge.js"
    bridge.write_text("fake bridge\n", encoding="utf-8")
    digest = hashlib.sha256(bridge.read_bytes()).hexdigest()
    entries = [{"path": "dist/harbor-bridge.js", "sha256": digest}]
    bundle_sha = hashlib.sha256("\n".join(f"{entry['path']}\0{entry['sha256']}" for entry in entries).encode()).hexdigest()
    (root / "manifest.json").write_text(json.dumps({
        "schemaVersion": "harbor-runtime-bundle-1",
        "bundleSha256": bundle_sha,
        "files": entries,
    }), encoding="utf-8")
    return root


def make_auth(root: Path) -> Path:
    path = root / "operator-pi-auth.json"
    path.write_text("{\"fixture\":\"AUTH_SECRET_SENTINEL\"}\n", encoding="utf-8")
    path.chmod(0o600)
    return path


def make_compatibility(root: Path, **overrides: object) -> Path:
    data = {
        "schemaVersion": "task-compatibility-1",
        "taskId": "terminal-bench/fix-git",
        "taskName": "fix-git",
        "datasetRef": "terminal-bench/terminal-bench-2-1",
        "datasetRevision": "2026-08-20-lock",
        "taskDigest": "a" * 64,
        "workspaceKind": "git-repo",
        "requiresGitRepo": True,
        "requiresCleanTree": True,
        "agentWorkdir": "/solution",
        "testsVisibleToAgent": True,
        "verifierMode": "shared",
        "fullDevFlowCompatible": True,
        "allowLocalCommit": False,
        "incompatibilityReasons": [],
        "deterministicTests": ["test -d ."],
        "scopeInclude": ["."],
        "scopeExclude": [],
        "acceptanceCriteria": ["The deterministic test contract passes."],
        "riskNotes": [],
    }
    data.update(overrides)
    path = root / "full-dev-flow" / "task-compatibility.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


class AgentContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_install_pins_runtime_and_uploads_embedded_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            root = make_bundle(Path(directory) / "bundle")
            logs = Path(directory) / "logs"
            agent = FullDevFlowAgent(logs_dir=logs, bundle_root=str(root))
            environment = FakeEnvironment(bundle_root=root)
            await agent.install(environment)
            self.assertEqual(environment.uploads[0][1], "/opt/agent-orchestrator/harbor-runtime")
            self.assertIn("v0.40.2", " ".join(environment.commands))
            self.assertIn("npm install -g @earendil-works/pi-coding-agent@0.82.1", " ".join(environment.commands))
            self.assertNotIn("@mariozechner/pi-coding-agent", " ".join(environment.commands))
            self.assertNotIn("ldd", " ".join(environment.commands))
            destination_index = next(
                index for index, event in enumerate(environment.events)
                if event.startswith("exec:mkdir -p /opt/agent-orchestrator")
            )
            upload_index = environment.events.index("upload_dir:/opt/agent-orchestrator/harbor-runtime")
            self.assertLess(destination_index, upload_index)
            self.assertIn("chown 1000:1000 /opt/agent-orchestrator /opt/agent-orchestrator/harbor-runtime", environment.commands[destination_index])
            resolved = json.loads((logs / "full-dev-flow" / "runtime-resolved.json").read_text())
            self.assertEqual(resolved["nodeVersion"], "v22.14.0")
            self.assertEqual(resolved["piPackage"], "@earendil-works/pi-coding-agent")
            self.assertEqual(resolved["piVersion"], "0.82.1")

    async def test_install_fails_closed_for_wrong_pi_version(self):
        with tempfile.TemporaryDirectory() as directory:
            root = make_bundle(Path(directory) / "bundle")
            agent = FullDevFlowAgent(logs_dir=Path(directory) / "logs", bundle_root=str(root))
            with self.assertRaises(HarnessCompatibilityError):
                await agent.install(FakeEnvironment(pi_version="0.82.0", bundle_root=root))

    async def test_single_pi_install_pins_fork_and_runtime_without_model(self):
        with tempfile.TemporaryDirectory() as directory:
            logs = Path(directory) / "logs"
            agent = SinglePiSubscriptionAgent(
                logs_dir=logs,
                model_name="openai-codex/gpt-5.6-luna",
                thinking="medium",
            )
            environment = FakeEnvironment()
            await agent.install(environment)
            commands = " ".join(environment.commands)
            self.assertIn("npm install -g @earendil-works/pi-coding-agent@0.82.1", commands)
            self.assertNotIn("@mariozechner/pi-coding-agent", commands)
            self.assertNotIn("pi --print", commands)
            resolved = json.loads((logs / "pi" / "runtime-resolved.json").read_text())
            self.assertEqual(resolved["agent"], "single-pi-subscription")
            self.assertEqual(resolved["piPackage"], "@earendil-works/pi-coding-agent")

    async def test_single_pi_runs_one_provider_qualified_invocation_and_cleans_auth(self):
        with tempfile.TemporaryDirectory() as directory:
            logs = Path(directory) / "logs"
            auth = make_auth(Path(directory))
            agent = SinglePiSubscriptionAgent(
                logs_dir=logs,
                model_name="openai-codex/gpt-5.6-luna",
                thinking="medium",
                pi_auth_json_path=str(auth),
            )
            environment = FakeEnvironment(workdir="/app")
            await agent.run("complete the proof", environment, SimpleNamespace())
            pi_commands = [command for command in environment.commands if "pi --print" in command]
            self.assertEqual(len(pi_commands), 1)
            self.assertIn("--provider openai-codex --model gpt-5.6-luna --thinking medium", pi_commands[0])
            self.assertIn(
                {"PI_CODING_AGENT_DIR": "/opt/agent-orchestrator/pi-auth"},
                [kwargs.get("env") for kwargs in environment.exec_kwargs],
            )
            self.assertTrue(any("chmod 600 /opt/agent-orchestrator/pi-auth/auth.json" in command for command in environment.commands))
            self.assertTrue(any("rm -f /opt/agent-orchestrator/pi-auth/auth.json" in command for command in environment.commands))
            self.assertIn("/opt/agent-orchestrator/pi-auth/auth.json", [target for _, target in environment.uploads])
            self.assertNotIn(str(auth), " ".join(environment.commands))
            host_artifacts = "\n".join(path.read_text(encoding="utf-8") for path in logs.rglob("*") if path.is_file())
            self.assertNotIn(str(auth), host_artifacts)
            self.assertNotIn("AUTH_SECRET_SENTINEL", host_artifacts)
            self.assertNotIn("AUTH_SECRET_SENTINEL", " ".join(environment.commands))
            pi_index = next(index for index, command in enumerate(environment.commands) if "pi --print" in command)
            self.assertEqual(environment.exec_kwargs[pi_index].get("cwd"), "/app")

    async def test_single_pi_uses_each_explicit_harbor_task_workdir_without_guessing(self):
        for workdir in ("/app", "/workspace"):
            with self.subTest(workdir=workdir), tempfile.TemporaryDirectory() as directory:
                logs = Path(directory) / "logs"
                auth = make_auth(Path(directory))
                agent = SinglePiSubscriptionAgent(
                    logs_dir=logs,
                    model_name="openai-codex/gpt-5.6-luna",
                    thinking="medium",
                    pi_auth_json_path=str(auth),
                    agent_workdir=workdir,
                )
                environment = FakeEnvironment(workdir="/unexpected")
                await agent.run("complete the task", environment, SimpleNamespace())
                pi_index = next(index for index, command in enumerate(environment.commands) if "pi --print" in command)
                self.assertEqual(environment.exec_kwargs[pi_index].get("cwd"), workdir)

    async def test_single_pi_explicit_agent_workdir_kwarg_overrides_task_config(self):
        with tempfile.TemporaryDirectory() as directory:
            auth = make_auth(Path(directory))
            agent = SinglePiSubscriptionAgent(
                logs_dir=Path(directory) / "logs",
                model_name="openai-codex/gpt-5.6-luna",
                thinking="medium",
                pi_auth_json_path=str(auth),
                agent_workdir="/workspace",
            )
            environment = FakeEnvironment(workdir="/app")
            await agent.run("complete the task", environment, SimpleNamespace())
            pi_index = next(index for index, command in enumerate(environment.commands) if "pi --print" in command)
            self.assertEqual(environment.exec_kwargs[pi_index].get("cwd"), "/workspace")

    async def test_single_pi_lets_harbor_provider_apply_image_workdir_when_task_config_omits_it(self):
        with tempfile.TemporaryDirectory() as directory:
            auth = make_auth(Path(directory))
            agent = SinglePiSubscriptionAgent(
                logs_dir=Path(directory) / "logs",
                model_name="openai-codex/gpt-5.6-luna",
                thinking="medium",
                pi_auth_json_path=str(auth),
            )
            environment = FakeEnvironment()
            await agent.run("complete the task", environment, SimpleNamespace())
            pi_index = next(index for index, command in enumerate(environment.commands) if "pi --print" in command)
            self.assertIsNone(environment.exec_kwargs[pi_index].get("cwd"))

    async def test_single_pi_rejects_non_absolute_harbor_task_workdir_before_auth(self):
        with tempfile.TemporaryDirectory() as directory:
            auth = make_auth(Path(directory))
            agent = SinglePiSubscriptionAgent(
                logs_dir=Path(directory) / "logs",
                model_name="openai-codex/gpt-5.6-luna",
                thinking="medium",
                pi_auth_json_path=str(auth),
            )
            environment = FakeEnvironment(workdir="relative")
            with self.assertRaisesRegex(HarnessCompatibilityError, "absolute task path"):
                await agent.run("complete the task", environment, SimpleNamespace())
            self.assertNotIn("/opt/agent-orchestrator/pi-auth/auth.json", [target for _, target in environment.uploads])

    async def test_single_pi_rejects_wrong_model_or_thinking_before_auth(self):
        with tempfile.TemporaryDirectory() as directory:
            auth = make_auth(Path(directory))
            for model, thinking in (("gpt-5.6-luna", "medium"), ("openai-codex/gpt-5.6-luna", "high")):
                agent = SinglePiSubscriptionAgent(
                    logs_dir=Path(directory) / model.replace("/", "-"),
                    model_name=model,
                    thinking=thinking,
                    pi_auth_json_path=str(auth),
                )
                environment = FakeEnvironment()
                with self.assertRaises(HarnessCompatibilityError):
                    await agent.run("complete the proof", environment, SimpleNamespace())
                self.assertNotIn("/opt/agent-orchestrator/pi-auth/auth.json", [target for _, target in environment.uploads])

    async def test_single_pi_usage_populates_context_and_atif(self):
        with tempfile.TemporaryDirectory() as directory:
            logs = Path(directory) / "logs"
            (logs / "pi").mkdir(parents=True)
            (logs / "pi" / "pi.txt").write_text(
                "\n".join(
                    json.dumps({"type": event_type, "id": "call-1", "message": {"role": "assistant", "usage": {"input": 12, "cacheRead": 3, "cacheWrite": 2, "output": 7, "cost": {"total": 0.0}}}})
                    for event_type in ("message_start", "message_end", "turn_end")
                ) + "\n",
                encoding="utf-8",
            )
            context = SimpleNamespace()
            SinglePiSubscriptionAgent(logs_dir=logs).populate_context_post_run(context)
            self.assertEqual(context.n_input_tokens, 12)
            self.assertEqual(context.n_cache_tokens, 3)
            self.assertEqual(context.n_output_tokens, 7)
            self.assertEqual(context.cost_usd, 0.0)
            self.assertEqual(context.metadata["provider"], "openai-codex")
            self.assertEqual(context.metadata["packageVersion"], "0.82.1")
            self.assertEqual(context.metadata["usage"]["cacheWriteTokens"], 2)
            self.assertIsNone(context.metadata["session"]["sessionId"])
            self.assertNotIn("calls", context.metadata)
            self.assertNotIn("refresh_token", json.dumps(context.metadata))
            self.assertEqual(
                context.metadata["artifactRefs"],
                ["pi/pi.txt", "pi/trajectory.json", "pi/runtime-resolved.json"],
            )
            atif = json.loads((logs / "pi" / "trajectory.json").read_text())
            self.assertEqual(atif["schema_version"], "ATIF-v1.0")
            self.assertEqual(atif["final_metrics"]["cached_tokens"], 3)
            self.assertEqual(atif["final_metrics"]["prompt_tokens"], 17)
            self.assertEqual(atif["final_metrics"]["cache_write_tokens"], 2)

    async def test_run_maps_instruction_and_only_locked_tests(self):
        with tempfile.TemporaryDirectory() as directory:
            logs = Path(directory) / "logs"
            compatibility_path = make_compatibility(logs)
            agent = FullDevFlowAgent(logs_dir=logs)
            metadata = json.loads(compatibility_path.read_text())
            handoff = agent._build_handoff("repair the repository", metadata, "/solution")
            self.assertEqual(handoff["objective"], "repair the repository")
            self.assertEqual(handoff["tests"], ["test -d ."])
            self.assertEqual(handoff["scope"], {"include": ["."], "exclude": []})

    async def test_full_cycle_cap_requires_explicit_non_negative_integer_and_is_carried_to_bridge_context(self):
        with tempfile.TemporaryDirectory() as directory:
            logs = Path(directory) / "logs"
            path = make_compatibility(logs)
            metadata = json.loads(path.read_text())
            for value in (True, False, 1.5, "0", -1):
                with self.subTest(value=value):
                    with self.assertRaisesRegex(HarnessCompatibilityError, "max_fix_cycles must be a non-negative integer"):
                        FullDevFlowAgent(logs_dir=logs, max_fix_cycles=value)
            for value, expected_cap in ((0, 1), (2, 3)):
                agent = FullDevFlowAgent(logs_dir=logs, max_fix_cycles=value)
                context = agent._build_bridge_context(metadata, "/solution")
                self.assertEqual(context["maxCycles"], expected_cap)
                self.assertEqual(context["legacyMaxFixCycles"], value)
                self.assertEqual(context["requestedConfiguration"]["maxCycles"], expected_cap)
                self.assertEqual(context["requestedConfiguration"]["legacyMaxFixCycles"], value)
                self.assertIsNone(context["effectiveConfiguration"]["maxCycles"])
                self.assertEqual(value + 1, expected_cap)

    async def test_canonical_max_cycles_is_direct_and_alias_conflicts_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            logs = Path(directory) / "logs"
            path = make_compatibility(logs)
            metadata = json.loads(path.read_text())
            for value in (0, -1, 1.5, True, "1"):
                with self.subTest(value=value):
                    with self.assertRaisesRegex(HarnessCompatibilityError, "max_cycles must be a positive integer"):
                        FullDevFlowAgent(logs_dir=logs, max_cycles=value)
            agent = FullDevFlowAgent(logs_dir=logs, max_cycles=3)
            context = agent._build_bridge_context(metadata, "/solution")
            self.assertEqual(context["maxCycles"], 3)
            self.assertEqual(context["requestedConfiguration"]["maxCycles"], 3)
            self.assertNotIn("maxFixCycles", context)
            with self.assertRaisesRegex(HarnessCompatibilityError, "cannot both"):
                FullDevFlowAgent(logs_dir=logs, max_cycles=3, max_fix_cycles=2)

    async def test_single_pi_rejects_cycle_cap_kwarg_instead_of_silently_ignoring_it(self):
        with self.assertRaisesRegex(HarnessCompatibilityError, "applies only to FullDevFlowAgent"):
            SinglePiSubscriptionAgent(logs_dir=Path("/tmp/unused-harbor-logs"), max_fix_cycles=0)

    async def test_run_rejects_latest_revision_but_preserves_instruction_verbatim(self):
        with tempfile.TemporaryDirectory() as directory:
            logs = Path(directory) / "logs"
            make_compatibility(logs, datasetRevision="latest")
            agent = FullDevFlowAgent(logs_dir=logs)
            with self.assertRaises(HarnessCompatibilityError):
                await agent.run("repair", FakeEnvironment(), SimpleNamespace())
            make_compatibility(logs, datasetRevision="2026-08-20-lock")
            metadata = json.loads((logs / "full-dev-flow" / "task-compatibility.json").read_text())
            handoff = agent._build_handoff("password token api_key=literal", metadata, "/solution")
            self.assertEqual(handoff["objective"], "password token api_key=literal")

    async def test_git_root_mismatch_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            logs = Path(directory) / "logs"
            make_compatibility(logs)
            agent = FullDevFlowAgent(logs_dir=logs)
            with self.assertRaisesRegex(HarnessCompatibilityError, "Git root"):
                await agent.run("repair", FakeEnvironment(git_top_level="/real/solution"), SimpleNamespace())

    async def test_scope_and_context_arrays_are_locked(self):
        with tempfile.TemporaryDirectory() as directory:
            logs = Path(directory) / "logs"
            path = make_compatibility(logs, scopeInclude=["src/foo.ts"], scopeExclude=["vendor"])
            agent = FullDevFlowAgent(logs_dir=logs)
            metadata = json.loads(path.read_text())
            handoff = agent._build_handoff("repair", metadata, "/solution")
            self.assertEqual(handoff["scope"], {"include": ["src/foo.ts"], "exclude": ["vendor"]})
            path = make_compatibility(logs, scopeInclude=["../escape"])
            metadata = json.loads(path.read_text())
            with self.assertRaises(HarnessCompatibilityError):
                agent._build_handoff("repair", metadata, "/solution")
            path = make_compatibility(logs, acceptanceCriteria=["ok", 1])
            metadata = json.loads(path.read_text())
            with self.assertRaises(HarnessCompatibilityError):
                agent._build_handoff("repair", metadata, "/solution")

    async def test_local_commit_policy_is_explicit_and_mapped_without_enabling_unsafe_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            logs = Path(directory) / "logs"
            path = make_compatibility(logs)
            agent = FullDevFlowAgent(logs_dir=logs)
            metadata = json.loads(path.read_text())
            handoff = agent._build_handoff("repair", metadata, "/solution")
            self.assertEqual(handoff["policy"], {"allowLocalCommit": False})
            self.assertTrue(any("Do not commit" in item for item in handoff["invariantsAndNonGoals"]))
            metadata["allowLocalCommit"] = True
            handoff = agent._build_handoff("repair", metadata, "/solution")
            self.assertEqual(handoff["policy"], {"allowLocalCommit": True})
            self.assertTrue(any("Local commits are permitted" in item for item in handoff["invariantsAndNonGoals"]))
            del metadata["allowLocalCommit"]
            with self.assertRaisesRegex(HarnessCompatibilityError, "allowLocalCommit"):
                agent._build_handoff("repair", metadata, "/solution")

    async def test_commit_capable_runtime_mode_fails_closed_before_auth(self):
        with tempfile.TemporaryDirectory() as directory:
            logs = Path(directory) / "logs"
            make_compatibility(logs, allowLocalCommit=True)
            auth = make_auth(Path(directory))
            agent = FullDevFlowAgent(logs_dir=logs, pi_auth_json_path=str(auth))
            environment = FakeEnvironment()
            with self.assertRaisesRegex(HarnessCompatibilityError, "baseline-aware"):
                await agent.run("repair", environment, SimpleNamespace())
            self.assertNotIn("/opt/agent-orchestrator/pi-auth/auth.json", [target for _, target in environment.uploads])

    async def test_auth_bridge_absence_is_deterministic(self):
        with tempfile.TemporaryDirectory() as directory:
            logs = Path(directory) / "logs"
            make_compatibility(logs)
            agent = FullDevFlowAgent(logs_dir=logs)
            with self.assertRaisesRegex(HarnessCompatibilityError, "explicit Pi auth file"):
                await agent.run("repair", FakeEnvironment(), SimpleNamespace())

    async def test_remote_agent_log_directory_is_created_before_upload(self):
        with tempfile.TemporaryDirectory() as directory:
            logs = Path(directory) / "logs"
            make_compatibility(logs)
            auth = make_auth(Path(directory))
            agent = FullDevFlowAgent(logs_dir=logs, pi_auth_json_path=str(auth))
            async def approved_workspace(metadata, environment):
                return "/solution"
            agent._validate_compatibility = approved_workspace
            environment = FakeEnvironment()
            await agent.run("repair", environment, SimpleNamespace())
            self.assertTrue(any(command.startswith("mkdir -p /logs/agent/full-dev-flow") for command in environment.commands))
            bridge_commands = [command for command in environment.commands if "harbor-bridge.js" in command]
            self.assertEqual(len(bridge_commands), 1)
            self.assertTrue(bridge_commands[0].startswith('set -euo pipefail; export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; node '))
            self.assertIn("/logs/agent/full-dev-flow/handoff.json", [target for _, target in environment.uploads])
            self.assertIn("/opt/agent-orchestrator/pi-auth/auth.json", [target for _, target in environment.uploads])
            self.assertNotIn(str(auth), " ".join(environment.commands))
            host_artifacts = "\n".join(path.read_text(encoding="utf-8") for path in logs.rglob("*") if path.is_file())
            self.assertNotIn(str(auth), host_artifacts)
            self.assertNotIn("AUTH_SECRET_SENTINEL", host_artifacts)
            self.assertNotIn("AUTH_SECRET_SENTINEL", " ".join(environment.commands))
            self.assertIn(
                {"PI_CODING_AGENT_DIR": "/opt/agent-orchestrator/pi-auth"},
                [kwargs.get("env") for kwargs in environment.exec_kwargs],
            )
            directory_setup = next(
                index for index, command in enumerate(environment.commands)
                if "chown 1000:1000 /opt/agent-orchestrator/pi-auth" in command and "test -d" in command
            )
            file_setup = next(
                index for index, command in enumerate(environment.commands)
                if "chown 1000:1000 /opt/agent-orchestrator/pi-auth/auth.json" in command
            )
            self.assertLess(directory_setup, file_setup)

    async def test_invalid_scope_or_acceptance_never_uploads_auth(self):
        for invalid in ({"scopeInclude": ["../escape"]}, {"acceptanceCriteria": ["ok", 1]}):
            with self.subTest(invalid=invalid), tempfile.TemporaryDirectory() as directory:
                logs = Path(directory) / "logs"
                make_compatibility(logs, **invalid)
                auth = make_auth(Path(directory))
                agent = FullDevFlowAgent(logs_dir=logs, pi_auth_json_path=str(auth))
                environment = FakeEnvironment()
                with self.assertRaises(HarnessCompatibilityError):
                    await agent.run("repair", environment, SimpleNamespace())
                self.assertNotIn(
                    "/opt/agent-orchestrator/pi-auth/auth.json",
                    [target for _, target in environment.uploads],
                )
                self.assertFalse(any("id -u; id -g" in command for command in environment.commands))

    async def test_bridge_failure_after_auth_install_still_cleans_up(self):
        with tempfile.TemporaryDirectory() as directory:
            logs = Path(directory) / "logs"
            make_compatibility(logs)
            auth = make_auth(Path(directory))
            agent = FullDevFlowAgent(logs_dir=logs, pi_auth_json_path=str(auth))
            original_exec_agent = agent._exec_agent

            async def fail_bridge(environment, command, **kwargs):
                if "harbor-bridge.js" in command:
                    raise RuntimeError("bridge fixture failure")
                return await original_exec_agent(environment, command, **kwargs)

            agent._exec_agent = fail_bridge
            environment = FakeEnvironment()
            with self.assertRaisesRegex(RuntimeError, "bridge fixture failure"):
                await agent.run("repair", environment, SimpleNamespace())
            self.assertIn("/opt/agent-orchestrator/pi-auth/auth.json", [target for _, target in environment.uploads])
            self.assertTrue(any("rm -f /opt/agent-orchestrator/pi-auth/auth.json" in command for command in environment.commands))

    async def test_cleanup_failure_keeps_primary_failure_visible(self):
        with tempfile.TemporaryDirectory() as directory:
            logs = Path(directory) / "logs"
            make_compatibility(logs)
            auth = make_auth(Path(directory))
            agent = FullDevFlowAgent(logs_dir=logs, pi_auth_json_path=str(auth))
            original_exec_agent = agent._exec_agent

            async def fail_bridge(environment, command, **kwargs):
                if "harbor-bridge.js" in command:
                    raise RuntimeError("bridge fixture failure")
                return await original_exec_agent(environment, command, **kwargs)

            async def fail_cleanup(environment):
                raise HarnessCompatibilityError("cleanup fixture failure")

            agent._exec_agent = fail_bridge
            agent._remove_pi_auth = fail_cleanup
            with self.assertRaisesRegex(
                HarnessCompatibilityError,
                r"primary run failure \(RuntimeError\).*cleanup also failed",
            ):
                await agent.run("repair", FakeEnvironment(), SimpleNamespace())

    async def test_auth_cleanup_succeeds_when_controlled_directory_remains(self):
        agent = FullDevFlowAgent(logs_dir=Path("/tmp/unused-harbor-logs"))
        environment = CleanupEnvironment(remove_succeeds=True)
        await agent._remove_pi_auth(environment)
        cleanup = environment.commands[-1]
        self.assertIn("test ! -e /opt/agent-orchestrator/pi-auth/auth.json", cleanup)
        self.assertIn("rmdir /opt/agent-orchestrator/pi-auth", cleanup)
        self.assertFalse(environment.auth_present)

    async def test_auth_cleanup_fails_if_auth_file_remains(self):
        agent = FullDevFlowAgent(logs_dir=Path("/tmp/unused-harbor-logs"))
        environment = CleanupEnvironment(remove_succeeds=False)
        with self.assertRaisesRegex(HarnessCompatibilityError, "cleanup failed"):
            await agent._remove_pi_auth(environment)

    async def test_auth_source_requires_restrictive_regular_file_without_leaking_path(self):
        with tempfile.TemporaryDirectory() as directory:
            logs = Path(directory) / "logs"
            make_compatibility(logs)
            broad = Path(directory) / "broad.json"
            broad.write_text("{\"fixture\":true}\n", encoding="utf-8")
            broad.chmod(0o644)
            agent = FullDevFlowAgent(logs_dir=logs, pi_auth_json_path=str(broad))
            with self.assertRaisesRegex(HarnessCompatibilityError, "permissions"):
                agent._validate_pi_auth_source()
            self.assertNotIn(str(broad), (logs / "full-dev-flow").read_text() if (logs / "full-dev-flow").is_file() else "")

    async def test_actual_zero_cost_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            logs = Path(directory) / "logs"
            telemetry_dir = logs / "full-dev-flow"
            telemetry_dir.mkdir(parents=True)
            (telemetry_dir / "telemetry.json").write_text(json.dumps({"usage": {"actualCostUsd": 0, "estimatedCostUsd": 2}}))
            context = SimpleNamespace()
            FullDevFlowAgent(logs_dir=logs).populate_context_post_run(context)
            self.assertEqual(context.cost_usd, 0)


class WheelBuilderTests(unittest.TestCase):
    def test_missing_harbor_api_fails_import_instead_of_masking_it(self):
        code = "import sys, types; sys.path.insert(0, %r); sys.modules['harbor'] = types.ModuleType('harbor'); import harbor_full_dev_flow.agent" % str(PACKAGE_ROOT / "src")
        result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ModuleNotFoundError", result.stderr)

    def test_import_path_works_with_a_fake_harbor_runtime(self):
        code = """
import sys, types
base = types.ModuleType('harbor.agents.installed.base')
class BaseInstalledAgent: pass
base.BaseInstalledAgent = BaseInstalledAgent
base.CliFlag = lambda *args, **kwargs: object()
base.with_prompt_template = lambda fn: fn
env = types.ModuleType('harbor.environments.base'); env.BaseEnvironment = object
ctx = types.ModuleType('harbor.models.agent.context'); ctx.AgentContext = object
sys.modules.update({
  'harbor': types.ModuleType('harbor'),
  'harbor.agents': types.ModuleType('harbor.agents'),
  'harbor.agents.installed': types.ModuleType('harbor.agents.installed'),
  'harbor.agents.installed.base': base,
  'harbor.environments': types.ModuleType('harbor.environments'),
  'harbor.environments.base': env,
  'harbor.models': types.ModuleType('harbor.models'),
  'harbor.models.agent': types.ModuleType('harbor.models.agent'),
  'harbor.models.agent.context': ctx,
})
from harbor_full_dev_flow.agent import FullDevFlowAgent
assert issubclass(FullDevFlowAgent, BaseInstalledAgent)
assert FullDevFlowAgent.__module__ == 'harbor_full_dev_flow.agent'
"""
        subprocess.run([sys.executable, "-c", code], env={"PYTHONPATH": str(PACKAGE_ROOT / "src")}, check=True)

    def test_wheel_builder_embeds_dist_without_external_build_dependency(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "wheelhouse"
            subprocess.run([sys.executable, str(PACKAGE_ROOT / "build-wheel.py"), "--repo-root", str(REPO_ROOT), "--output", str(output)], check=True)
            wheels = list(output.glob("*.whl"))
            self.assertEqual(len(wheels), 1)
            with zipfile.ZipFile(wheels[0]) as archive:
                names = archive.namelist()
                self.assertIn("harbor_full_dev_flow/assets/runtime_bundle/manifest.json", names)
                self.assertIn("harbor_full_dev_flow/assets/runtime_bundle/dist/harbor-bridge.js", names)
                self.assertFalse(any("runtime_bundle/dist/test/" in name or name.endswith(".test.js") for name in names))
                self.assertIn("agent_orchestrator_harbor_full_dev_flow-0.1.0.dist-info/METADATA", names)


if __name__ == "__main__":
    unittest.main()
