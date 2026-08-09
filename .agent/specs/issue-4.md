---
status: approved
max_tier: 2
---

# Add pull request CI for dev-flow

## Objective
Add a minimal, reliable GitHub Actions CI workflow for the public dev-flow repository so every pull request and push to main verifies the locked dependency install, TypeScript build, and full test suite.

## Background and decisions
- This supersedes Issue #2, whose isolated-worktree preflight correctly failed before model execution because its test command did not bootstrap dependencies.
- The repository is public at skai-in-ai/dev-flow.
- package.json has no lint script; CI must not pretend lint exists.
- npm test already runs npm run build before the Node test runner, so it is the canonical verification command after npm ci.
- Use Node.js 24 to match the current Node type dependency and current LTS generation.
- Use least-privilege GitHub token permissions and cancel obsolete runs for the same workflow/ref.
- GitHub workflow paths are treated as high risk by the router, so this approved spec permits Tier 2 review.
- Keep this task independent from README and documentation updates, which are queued separately.

## Scope include
- .github/workflows/ci.yml

## Scope exclude
- README.md
- docs/
- package.json scripts or dependencies
- Release, publishing, deployment, merge automation, CodeQL, coverage upload, and third-party CI services

## Acceptance criteria
- CI runs for pull_request events and pushes to main.
- Workflow permissions are read-only contents.
- Concurrency groups supersede obsolete runs for the same workflow and ref without cancelling unrelated branches.
- Job runs on a current Ubuntu runner with Node.js 24 and npm cache support.
- Job uses npm ci followed by npm test.
- Job has a finite timeout and no secrets or write permissions.
- Workflow remains small and understandable for outside contributors.

## Tests
- npm ci && npm test

## Risks
- GitHub Actions workflow files can affect repository automation and require the high-risk review route.
- GitHub Actions YAML cannot be fully exercised locally; final validation requires observing the workflow on its Draft PR.

## Unresolved items
none
