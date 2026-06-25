---
name: agent-workspace
description: Use this when a user wants isolated coding-agent workspaces, git worktrees, repo-local task branches, parallel agent work, cleanup of agent worktrees, or asks for agent-wt / wt / workspace CLI setup. Provides the minimal workflow for installing and using wraithdevelopment/agent-workspace in any git repo.
license: MIT
compatibility: POSIX shell, git, Node.js >=20. Optional gh CLI for GitHub issue/PR lookup.
---

# Agent Workspace

Use `agent-wt` to manage per-task git worktrees for coding agents.

## Install or run

Prefer repo-local dev dependency when changing a project:

```bash
pnpm add -D github:wraithdevelopment/agent-workspace
pnpm exec agent-wt help
```

For one-off use:

```bash
pnpm --package github:wraithdevelopment/agent-workspace dlx agent-wt help
```

If the package is already installed globally or in the repo, use `agent-wt` or `wt` directly.

## Default workflow

```bash
agent-wt create "task name" --base main --no-dev
agent-wt list
# work in .worktrees/task-name
agent-wt cleanup task-name --force
```

Do not start dev servers unless the user asks. If needed:

```bash
agent-wt start task-name
agent-wt stop task-name
```

## Commands

```bash
agent-wt create <issue-number|task> [--branch agent/name] [--base main] [--no-dev] [--no-install]
agent-wt setup [worktree]
agent-wt list
agent-wt start [worktree]
agent-wt stop [worktree|all]
agent-wt seed [worktree]
agent-wt cleanup <worktree> [--force]
```

## Optional repo config

Create `agent-workspace.json` at repo root only when defaults are not enough:

```json
{
  "worktreeDir": ".worktrees",
  "metaDir": ".agent-workspace",
  "branchPrefix": "agent/",
  "base": "main",
  "copyFiles": [".env"],
  "install": "pnpm install --frozen-lockfile",
  "dev": {
    "command": "pnpm dev",
    "urlTemplate": "http://{slug}.localhost:{port}"
  },
  "hooks": {
    "setup": "node scripts/workspace-setup.mjs",
    "seed": "node scripts/workspace-seed.mjs",
    "preCleanup": "node scripts/workspace-cleanup.mjs"
  }
}
```

Hooks run in the worktree and receive:

- `WT_SLUG`
- `WT_BRANCH`
- `WT_PORT`
- `WT_WORKTREE_PATH`
- `WT_SOURCE_ROOT`
- `WT_APP_URL`

Keep project-specific DB setup, seed data, env rewrites, Docker, and migrations in hooks. Do not add them to the generic CLI.

## Safety

- Check `agent-wt list` before cleanup.
- Refuse dirty worktrees unless the user explicitly handles changes.
- Use `--force` only when the user accepts unmerged cleanup.
- The CLI writes ignores to local `.git/info/exclude`, not tracked `.gitignore`.
- POSIX-only process supervision; no Windows guarantee.
