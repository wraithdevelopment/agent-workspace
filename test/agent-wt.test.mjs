import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve("bin/agent-wt.mjs");

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8" });
}

function git(args, cwd) {
  return run("git", args, cwd);
}

test("creates, lists, and force-cleans a generic worktree", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-wt-"));
  try {
    git(["init", "-b", "main"], dir);
    git(["config", "user.email", "test@example.com"], dir);
    git(["config", "user.name", "Test User"], dir);
    writeFileSync(join(dir, "README.md"), "# fixture\n");
    git(["add", "README.md"], dir);
    git(["commit", "-m", "init"], dir);

    run(process.execPath, [cli, "create", "test task", "--no-dev", "--no-install"], dir);

    const worktreePath = join(dir, ".worktrees", "test-task");
    assert.equal(existsSync(worktreePath), true);
    assert.equal(existsSync(join(worktreePath, ".agent-workspace", "worktree.json")), true);
    assert.match(git(["worktree", "list"], dir), /test-task/);
    assert.match(readFileSync(join(dir, ".git", "info", "exclude"), "utf8"), /\.worktrees\//);
    assert.match(run(process.execPath, [cli, "list"], dir), /test-task/);

    run(process.execPath, [cli, "cleanup", "test-task", "--force"], dir);
    assert.equal(existsSync(worktreePath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
