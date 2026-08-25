"""Dependency-free data contracts shared by the wrapper and its fake tests."""

from __future__ import annotations

from typing import TypedDict


class CompatibilityManifest(TypedDict, total=False):
    schemaVersion: str
    taskId: str
    taskName: str
    datasetRef: str
    datasetRevision: str
    taskDigest: str
    workspaceKind: str
    requiresGitRepo: bool
    requiresCleanTree: bool
    agentWorkdir: str
    agentLogDir: str
    artifactRoot: str
    testsVisibleToAgent: bool
    verifierMode: str
    fullDevFlowCompatible: bool
    allowLocalCommit: bool
    incompatibilityReasons: list[str]
    deterministicTests: list[str]
    scopeInclude: list[str]
    scopeExclude: list[str]
    acceptanceCriteria: list[str]
    riskNotes: list[str]


class BridgeContext(TypedDict, total=False):
    taskId: str
    taskName: str
    datasetRef: str
    datasetRevision: str
    taskDigest: str
    agentWorkdir: str
    agentLogDir: str
    artifactDir: str
    maxTier: int
    requestedConfiguration: dict[str, object]
    effectiveConfiguration: dict[str, object]
    runtimeResolved: dict[str, object]
    compatibility: CompatibilityManifest
