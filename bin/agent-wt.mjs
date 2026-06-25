#!/usr/bin/env node
// agent-wt: a generic git-worktree lifecycle manager for coding agents.
// Repo-agnostic. All project-specific logic lives in agent-workspace.json hooks.
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";

const CONFIG_FILES = ["agent-workspace.json", ".agent-workspace.json"];

const DEFAULT_CONFIG = {
  worktreeDir: ".worktrees",
  metaDir: ".agent-workspace",
  branchPrefix: "agent/",
  base: "HEAD",
  copyFiles: [],
  install: null,
  dev: { command: null, urlTemplate: null },
  hooks: { setup: null, seed: null, preCleanup: null },
};

// ── ANSI ────────────────────────────────────────────────────────────────────
const ANSI = {
  blink: "\x1b[5m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  reset: "\x1b[0m",
  yellow: "\x1b[33m",
};

function shouldColor() {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined) return true;
  return process.stdout.isTTY;
}
function color(value, code) {
  return shouldColor() ? `${code}${value}${ANSI.reset}` : value;
}
const bold = (v) => color(v, ANSI.bold);
const dim = (v) => color(v, ANSI.dim);
const green = (v) => color(v, ANSI.green);
const yellow = (v) => color(v, ANSI.yellow);
const red = (v) => color(v, ANSI.red);
const cyan = (v) => color(v, ANSI.cyan);
const runningStatus = (v) => `${color("●", `${ANSI.green}${ANSI.blink}`)} ${green(v)}`;

function terminalWidth() {
  return Math.max(80, process.stdout.columns ?? 120);
}
function printSection(title, detail = "") {
  const suffix = detail ? ` ${dim(detail)}` : "";
  console.log(`\n${bold(cyan(title))}${suffix}`);
  console.log(dim("─".repeat(Math.min(terminalWidth(), 96))));
}

function printHelp() {
  console.log(`agent-wt — generic git-worktree manager for coding agents

Usage:
  agent-wt create <issue-number|task> [--branch agent/name] [--base main] [--no-dev] [--no-install]
  agent-wt setup [worktree]
  agent-wt list
  agent-wt start [worktree]
  agent-wt stop [worktree|all]
  agent-wt seed [worktree]
  agent-wt cleanup <worktree> [--force]

Config: agent-workspace.json at the repo root (optional; sane defaults apply).
Hooks receive: WT_SLUG, WT_BRANCH, WT_PORT, WT_WORKTREE_PATH, WT_SOURCE_ROOT, WT_APP_URL.
`);
}

// ── arg parsing ───────────────────────────────────────────────────────────────
function parseCli(argv) {
  const [command = "help", ...rest] = argv;
  const positionals = [];
  const flags = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const [rawKey, rawValue] = token.slice(2).split("=", 2);
    if (rawValue !== undefined) {
      flags.set(rawKey, rawValue);
      continue;
    }
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(rawKey, next);
      index += 1;
    } else {
      flags.set(rawKey, true);
    }
  }
  return { command, flags, positionals };
}

// ── process helpers ────────────────────────────────────────────────────────────
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? result.stderr.trim() : "";
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return options.capture ? result.stdout.trim() : "";
}
function tryRun(command, args, options = {}) {
  try {
    return run(command, args, { ...options, capture: true });
  } catch {
    return null;
  }
}
function commandExists(command) {
  return tryRun("bash", ["-lc", `command -v ${command}`]) !== null;
}
// Run a shell hook/install command string in a worktree with WT_* env injected.
function runShell(commandString, cwd, env) {
  run("bash", ["-lc", commandString], { cwd, env: { ...process.env, ...env } });
}

function slugify(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^agent\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// ── config ─────────────────────────────────────────────────────────────────────
function validateConfig(raw, path) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error(`Config must be a JSON object: ${path}`);
  const config = {
    ...DEFAULT_CONFIG,
    ...raw,
    dev: { ...DEFAULT_CONFIG.dev, ...(raw.dev ?? {}) },
    hooks: { ...DEFAULT_CONFIG.hooks, ...(raw.hooks ?? {}) },
  };
  if (typeof config.worktreeDir !== "string" || !config.worktreeDir)
    throw new Error(`config.worktreeDir must be a non-empty string: ${path}`);
  if (typeof config.metaDir !== "string" || !config.metaDir)
    throw new Error(`config.metaDir must be a non-empty string: ${path}`);
  if (!Array.isArray(config.copyFiles))
    throw new Error(`config.copyFiles must be an array: ${path}`);
  return config;
}
function loadConfig(sourceRoot) {
  for (const name of CONFIG_FILES) {
    const path = join(sourceRoot, name);
    if (existsSync(path)) return validateConfig(JSON.parse(readFileSync(path, "utf8")), path);
  }
  return { ...DEFAULT_CONFIG };
}

// ── git repo discovery ───────────────────────────────────────────────────────────
function getRepo() {
  const root = run("git", ["rev-parse", "--show-toplevel"], { capture: true });
  const gitDir = resolve(root, run("git", ["rev-parse", "--git-dir"], { capture: true }));
  const gitCommon = resolve(root, run("git", ["rev-parse", "--git-common-dir"], { capture: true }));
  const sourceRoot = gitCommon.endsWith("/.git") ? dirname(gitCommon) : root;
  const config = loadConfig(sourceRoot);
  return {
    config,
    gitCommon,
    gitDir,
    inLinkedWorktree: gitDir !== gitCommon,
    root,
    sourceRoot,
    worktreeRoot: join(sourceRoot, config.worktreeDir),
  };
}

function ensureExclude(repoPath, line) {
  const gitCommon = run("git", ["-C", repoPath, "rev-parse", "--git-common-dir"], { capture: true });
  const commonPath = isAbsolute(gitCommon) ? gitCommon : resolve(repoPath, gitCommon);
  const excludePath = join(commonPath, "info", "exclude");
  mkdirSync(dirname(excludePath), { recursive: true });
  const text = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  if (!new Set(text.split("\n")).has(line))
    writeFileSync(
      excludePath,
      `${text}${text.endsWith("\n") || text.length === 0 ? "" : "\n"}${line}\n`,
    );
}

function parseWorktreeList(sourceRoot) {
  const output = run("git", ["-C", sourceRoot, "worktree", "list", "--porcelain"], {
    capture: true,
  });
  const entries = [];
  let current = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length), branch: "", head: "" };
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch refs/heads/".length);
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    }
  }
  if (current) entries.push(current);
  return entries;
}

// ── meta json ──────────────────────────────────────────────────────────────────
function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
const metaPath = (wt, meta) => join(wt, meta, "worktree.json");
const devPath = (wt, meta) => join(wt, meta, "dev.json");
function readMeta(wt, meta) {
  return readJson(metaPath(wt, meta));
}
function getSlug(repo, wt, branch = "") {
  return (
    readMeta(wt, repo.config.metaDir)?.slug ??
    slugify(branch || (wt.split("/").pop() ?? "worktree"))
  );
}

function isProcessRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function findWorktree(repo, identifier) {
  const currentPath = repo.inLinkedWorktree ? repo.root : null;
  if (!identifier && currentPath) return currentPath;
  if (!identifier)
    throw new Error("Specify a worktree (slug/path) or run inside a linked worktree.");
  const directPath = isAbsolute(identifier) ? identifier : resolve(process.cwd(), identifier);
  if (existsSync(directPath)) return directPath;
  const prefix = repo.config.branchPrefix;
  const match = parseWorktreeList(repo.sourceRoot).find((entry) => {
    const slug =
      readMeta(entry.path, repo.config.metaDir)?.slug ??
      slugify(entry.branch || (entry.path.split("/").pop() ?? ""));
    return (
      slug === identifier ||
      entry.branch === identifier ||
      entry.branch === `${prefix}${identifier}` ||
      entry.path.endsWith(`/${identifier}`)
    );
  });
  if (!match) throw new Error(`Worktree not found: ${identifier}`);
  return match.path;
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not allocate a free port."));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
    server.on("error", reject);
  });
}

// ── task / env ───────────────────────────────────────────────────────────────────
async function resolveTask(repo, input, flags) {
  const prefix = repo.config.branchPrefix;
  const explicitBranch = flags.get("branch");
  if (explicitBranch) {
    run("git", ["check-ref-format", "--branch", String(explicitBranch)]);
    return { branch: String(explicitBranch), issueNumber: null, slug: slugify(String(explicitBranch)) };
  }
  if (!input) throw new Error("A task name or issue number is required.");
  if (/^\d+$/.test(input) && commandExists("gh")) {
    const view = tryRun("gh", ["issue", "view", input, "--json", "number,title"]);
    if (view) {
      const issue = JSON.parse(view);
      const slug = slugify(`issue-${issue.number}-${issue.title}`);
      return { branch: `${prefix}${slug}`, issueNumber: issue.number, slug };
    }
  }
  const slug = /^\d+$/.test(input) ? `issue-${input}` : slugify(input);
  return {
    branch: `${prefix}${slug}`,
    issueNumber: /^\d+$/.test(input) ? Number(input) : null,
    slug,
  };
}

function copyConfiguredFiles(repo, worktreePath) {
  const copied = [];
  for (const file of repo.config.copyFiles) {
    const source = join(repo.sourceRoot, file);
    const target = join(worktreePath, file);
    if (existsSync(target) || !existsSync(source)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(source));
    copied.push(file);
  }
  return copied;
}

function hookEnv(repo, worktreePath, meta) {
  return {
    WT_SLUG: meta.slug,
    WT_BRANCH: meta.branch ?? "",
    WT_PORT: meta.port ? String(meta.port) : "",
    WT_WORKTREE_PATH: worktreePath,
    WT_SOURCE_ROOT: repo.sourceRoot,
    WT_APP_URL: meta.appUrl ?? "",
  };
}

function appUrl(repo, slug, port) {
  const template = repo.config.dev.urlTemplate;
  if (!template) return null;
  return template.replaceAll("{slug}", slug).replaceAll("{port}", String(port ?? ""));
}

async function setupWorktree(repo, worktreePath, task, flags) {
  const { metaDir } = repo.config;
  const slug = task.slug ?? getSlug(repo, worktreePath, task.branch);
  mkdirSync(join(worktreePath, metaDir), { recursive: true });
  ensureExclude(worktreePath, `${metaDir}/`);
  for (const file of repo.config.copyFiles) ensureExclude(worktreePath, file);

  const existing = readMeta(worktreePath, metaDir);
  const port = existing?.port ?? (repo.config.dev.urlTemplate ? await freePort() : null);
  const meta = {
    appUrl: appUrl(repo, slug, port),
    branch: task.branch,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    issueNumber: task.issueNumber ?? existing?.issueNumber ?? null,
    port,
    slug,
    sourceRoot: repo.sourceRoot,
  };
  writeJson(metaPath(worktreePath, metaDir), meta);

  const copied = copyConfiguredFiles(repo, worktreePath);
  const env = hookEnv(repo, worktreePath, meta);

  if (!flags.has("no-install") && repo.config.install && !existsSync(join(worktreePath, "node_modules")))
    runShell(repo.config.install, worktreePath, env);
  if (repo.config.hooks.setup) runShell(repo.config.hooks.setup, worktreePath, env);

  console.log(`\nWorktree ready: ${worktreePath}`);
  console.log(`Branch: ${task.branch}`);
  if (copied.length) console.log(`Copied: ${copied.join(", ")}`);
  if (meta.appUrl) console.log(`URL: ${meta.appUrl}`);

  if (!flags.has("no-dev")) startDev(repo, worktreePath);
}

function seed(repo, worktreePath) {
  const command = repo.config.hooks.seed;
  if (!command) {
    console.log("No seed hook configured.");
    return;
  }
  const meta = readMeta(worktreePath, repo.config.metaDir) ?? { slug: getSlug(repo, worktreePath) };
  runShell(command, worktreePath, hookEnv(repo, worktreePath, meta));
}

// ── dev process supervision ──────────────────────────────────────────────────────
function startDev(repo, worktreePath) {
  const { metaDir } = repo.config;
  const command = repo.config.dev.command;
  if (!command) {
    console.log("No dev command configured (config.dev.command).");
    return;
  }
  const existing = readJson(devPath(worktreePath, metaDir));
  if (existing?.pid && isProcessRunning(existing.pid)) {
    console.log(`Dev already running: pid ${existing.pid}`);
    return;
  }
  mkdirSync(join(worktreePath, metaDir), { recursive: true });
  const logPath = join(worktreePath, metaDir, "dev.log");
  const logFd = openSync(logPath, "a");
  const meta = readMeta(worktreePath, metaDir);
  const env = meta ? hookEnv(repo, worktreePath, meta) : {};
  const child = spawn("bash", ["-lc", command], {
    cwd: worktreePath,
    detached: true,
    env: { ...process.env, ...env },
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  writeJson(devPath(worktreePath, metaDir), {
    appUrl: meta?.appUrl ?? null,
    logPath,
    pid: child.pid,
    startedAt: new Date().toISOString(),
  });
  console.log(`Dev started: pid ${child.pid}`);
  console.log(`Log: ${logPath}`);
  if (meta?.appUrl) console.log(`URL: ${meta.appUrl}`);
}

function stopDev(repo, worktreePath) {
  const dev = readJson(devPath(worktreePath, repo.config.metaDir));
  if (!dev?.pid) {
    console.log(`No dev pid: ${worktreePath}`);
    return;
  }
  if (!isProcessRunning(dev.pid)) {
    console.log(`Dev already stopped: pid ${dev.pid}`);
    return;
  }
  // ponytail: POSIX process-group kill. Windows has no process groups — see README.
  try {
    process.kill(-dev.pid, "SIGTERM");
  } catch {
    process.kill(dev.pid, "SIGTERM");
  }
  console.log(`Dev stopped: pid ${dev.pid}`);
}

function formatDevStatus(dev) {
  if (!dev?.pid) return dim("not started");
  return isProcessRunning(dev.pid) ? runningStatus(`running ${dev.pid}`) : yellow(`stale ${dev.pid}`);
}

function listStatus(repo) {
  const entries = parseWorktreeList(repo.sourceRoot).filter(
    (entry) => entry.path === repo.sourceRoot || entry.path.startsWith(repo.worktreeRoot),
  );
  const rows = entries.map((entry) => {
    const meta = readMeta(entry.path, repo.config.metaDir);
    const dev = readJson(devPath(entry.path, repo.config.metaDir));
    const slug =
      meta?.slug ??
      (entry.path === repo.sourceRoot ? "source" : slugify(entry.path.split("/").pop() ?? ""));
    return {
      branch: entry.branch || dim("detached"),
      dev: formatDevStatus(dev),
      kind: entry.path === repo.sourceRoot ? cyan("source") : "worktree",
      slug,
      url: dev?.appUrl ?? meta?.appUrl ?? dim("-"),
    };
  });
  const runningCount = rows.filter((row) => row.dev.includes("running")).length;
  printSection("Worktrees", `${rows.length} total · ${runningCount} dev running`);
  console.log(dim(repo.sourceRoot));
  for (const [index, row] of rows.entries()) {
    if (index > 0) console.log("");
    console.log(`${row.kind}  ${bold(row.slug)}`);
    console.log(`  ${dim("branch")} ${row.branch}`);
    console.log(`  ${dim("dev")}    ${row.dev}`);
    console.log(`  ${dim("url")}    ${row.url}`);
  }
}

function isMerged(repo, branch) {
  if (!branch) return false;
  if (commandExists("gh")) {
    const merged = tryRun("gh", [
      "pr", "view", branch, "--json", "state,mergedAt",
      "--jq", '.state == "MERGED" or .mergedAt != null',
    ]);
    if (merged === "true") return true;
  }
  tryRun("git", ["-C", repo.sourceRoot, "fetch", "origin"]);
  for (const base of ["origin/main", "origin/master", "main", "master"]) {
    const merged = tryRun("git", [
      "-C", repo.sourceRoot, "branch", "--merged", base, "--format", "%(refname:short)",
    ]);
    if (merged?.split("\n").includes(branch)) return true;
  }
  return false;
}

function cleanup(repo, worktreePath, flags) {
  if (resolve(worktreePath) === resolve(repo.sourceRoot))
    throw new Error("Refusing to remove the source checkout.");
  const entry = parseWorktreeList(repo.sourceRoot).find(
    (item) => resolve(item.path) === resolve(worktreePath),
  );
  if (!entry) throw new Error(`Not in git worktree list: ${worktreePath}`);

  const dirty = run("git", ["-C", worktreePath, "status", "--short"], { capture: true });
  if (dirty) throw new Error(`Dirty worktree. Commit or stash first:\n${dirty}`);
  if (!flags.has("force") && !isMerged(repo, entry.branch))
    throw new Error("PR/branch does not look merged. Use --force to override.");

  const meta = readMeta(worktreePath, repo.config.metaDir);
  if (repo.config.hooks.preCleanup)
    runShell(repo.config.hooks.preCleanup, worktreePath, hookEnv(repo, worktreePath, meta ?? { slug: entry.branch }));

  stopDev(repo, worktreePath);
  run("git", ["-C", repo.sourceRoot, "worktree", "remove", worktreePath]);
  run("git", ["-C", repo.sourceRoot, "worktree", "prune"]);
  console.log(`Removed: ${worktreePath}`);
}

async function createWorktree(repo, input, flags) {
  const task = await resolveTask(repo, input, flags);
  const worktreePath = join(repo.worktreeRoot, task.slug);
  ensureExclude(repo.sourceRoot, `${repo.config.worktreeDir}/`);
  mkdirSync(repo.worktreeRoot, { recursive: true });

  if (!existsSync(worktreePath)) {
    const base = flags.get("base") ? String(flags.get("base")) : repo.config.base;
    const branchExists =
      tryRun("git", [
        "-C", repo.sourceRoot, "show-ref", "--verify", "--quiet", `refs/heads/${task.branch}`,
      ]) !== null;
    const args = ["-C", repo.sourceRoot, "worktree", "add", worktreePath];
    if (branchExists) args.push(task.branch);
    else args.push("-b", task.branch, base);
    run("git", args);
  }
  await setupWorktree(repo, worktreePath, task, flags);
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (["help", "-h", "--help"].includes(cli.command)) {
    printHelp();
    return;
  }
  const repo = getRepo();
  switch (cli.command) {
    case "create":
    case "new":
      await createWorktree(repo, cli.positionals.join(" "), cli.flags);
      break;
    case "setup": {
      const worktreePath = findWorktree(repo, cli.positionals[0]);
      const branch = run("git", ["-C", worktreePath, "branch", "--show-current"], { capture: true });
      await setupWorktree(
        repo, worktreePath,
        { branch, issueNumber: null, slug: getSlug(repo, worktreePath, branch) },
        cli.flags,
      );
      break;
    }
    case "list":
    case "ls":
    case "status":
      listStatus(repo);
      break;
    case "start":
    case "dev":
      startDev(repo, findWorktree(repo, cli.positionals[0]));
      break;
    case "stop":
      if (cli.positionals[0] === "all") {
        for (const entry of parseWorktreeList(repo.sourceRoot))
          if (entry.path.startsWith(repo.worktreeRoot)) stopDev(repo, entry.path);
      } else {
        stopDev(repo, findWorktree(repo, cli.positionals[0]));
      }
      break;
    case "seed":
      seed(repo, findWorktree(repo, cli.positionals[0]));
      break;
    case "cleanup":
    case "rm":
      cleanup(repo, findWorktree(repo, cli.positionals[0]), cli.flags);
      break;
    default:
      throw new Error(`Unknown command: ${cli.command}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
