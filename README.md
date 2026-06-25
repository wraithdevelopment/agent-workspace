# agent-workspace

Generic `git worktree` CLI for coding-agent workspaces. It is the repo-agnostic version of Worp's `pnpm wt`: create isolated worktrees, run optional setup hooks, start/stop dev commands, list status, and clean up safely.

No runtime deps. POSIX shell required.

## Install

```bash
pnpm --package github:wraithdevelopment/agent-workspace dlx agent-wt help
```

As a Pi skill package:

```bash
pi install git:github.com/wraithdevelopment/agent-workspace
```

Or after npm publish:

```bash
pnpm add -D @wraithdevelopment/agent-workspace
pnpm exec agent-wt help
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

Defaults work without config:

- worktrees: `.worktrees/<slug>`
- metadata: `.agent-workspace/` inside each worktree
- branch prefix: `agent/`
- no install, no dev command, no hooks

The CLI writes `.worktrees/` and metadata ignores to local `.git/info/exclude`; it does not edit your tracked `.gitignore`.

## Config

Optional `agent-workspace.json` or `.agent-workspace.json` at repo root:

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

Hooks run in the worktree with:

- `WT_SLUG`
- `WT_BRANCH`
- `WT_PORT`
- `WT_WORKTREE_PATH`
- `WT_SOURCE_ROOT`
- `WT_APP_URL`

Project-specific DBs, seed data, env rewrites, Docker, migrations: put them in hooks. The core stays generic.

## Example

```bash
agent-wt create "fix auth callback" --base main
agent-wt list
agent-wt start fix-auth-callback
agent-wt cleanup fix-auth-callback --force
```

## Agent Skill

This repo ships an Agent Skills-compatible skill at `skills/agent-workspace/SKILL.md`, and exposes it via the `pi.skills` package manifest. Pi, Claude/Codex-style harnesses, or any Agent Skills-compatible coding agent can load it to learn the CLI workflow.

## Limits

- POSIX-only process supervision (`bash`, process-group kill).
- PID checks are simple; no daemon.
- No plugin system. Shell hooks are enough until they are not.
