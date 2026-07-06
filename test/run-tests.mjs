#!/usr/bin/env node
/*
  Fixture test suite for claude-folder-move. Builds fake CLAUDE_CONFIG_DIR
  trees in a temp dir — NEVER touches the real ~/.claude. Proves:
  happy-path migration, content preservation, collisions, merges, injected
  mid-apply failures with byte-identical restore, cancel paths as no-ops,
  folder copies, and standalone restore.
*/

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "claude-folder-move.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cfm-test-"));
let passed = 0;
let failed = 0;

// mirror of the tool's encoder — the CLI oracle test (layer 1) is what
// validates this against the real Claude; here it just builds fixtures
const enc = (p) => p.replace(/[^a-zA-Z0-9-]/g, "-");

function makeFixture(name) {
  const root = path.join(TMP, name);
  const cfg = path.join(root, "cfg");
  const origin = path.join(root, "Old Projects");
  const dest = path.join(root, "Meu Drive Test", "AI Projects");
  fs.mkdirSync(path.join(cfg, "projects"), { recursive: true });
  fs.mkdirSync(origin, { recursive: true });
  fs.mkdirSync(dest, { recursive: true });

  const alpha = path.join(origin, "alpha");
  const beta = path.join(origin, "beta project"); // spaces in project name
  fs.mkdirSync(alpha, { recursive: true });
  fs.mkdirSync(beta, { recursive: true });
  fs.writeFileSync(path.join(alpha, "file.txt"), "alpha content\n");
  fs.writeFileSync(path.join(beta, "file.txt"), "beta content\n");

  const mkSession = (projPath, dirName, sessionName, lines) => {
    const dir = path.join(cfg, "projects", dirName ?? enc(projPath));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, sessionName), lines.join("\n") + "\n");
    return dir;
  };

  const alphaLines = [
    JSON.stringify({ type: "user", cwd: alpha, message: { content: "hello" }, sessionId: "s-alpha" }),
    JSON.stringify({ type: "assistant", cwd: alpha, toolUseResult: { filePath: `${alpha}/file.txt`, stdout: `worked in ${alpha}` } }),
    "this is not json {{{",
    JSON.stringify({ type: "user", cwd: `${alpha}/subdir`, message: { content: "nested cwd" } }),
    "",
  ];
  mkSession(alpha, null, "session-a.jsonl", alphaLines);
  // worktree dir: separate encoded dir whose cwd is nested under alpha
  const wt = `${alpha}/.claude/worktrees/test-wt`;
  mkSession(wt, null, "session-wt.jsonl", [JSON.stringify({ type: "user", cwd: wt, message: {} })]);
  mkSession(beta, null, "session-b.jsonl", [
    JSON.stringify({ type: "user", cwd: beta, message: { content: "beta hi" } }),
  ]);

  const claudeJson = {
    numStartups: 5,
    projects: {
      [alpha]: { allowedTools: ["Bash(git *)"], hasTrustDialogAccepted: true },
      [beta]: { allowedTools: [], hasTrustDialogAccepted: true },
    },
  };
  fs.writeFileSync(path.join(cfg, ".claude.json"), JSON.stringify(claudeJson, null, 2));
  fs.writeFileSync(
    path.join(cfg, "history.jsonl"),
    [
      JSON.stringify({ display: "do stuff", project: alpha, sessionId: "s-alpha" }),
      JSON.stringify({ display: "beta stuff", project: beta, sessionId: "s-beta" }),
      "corrupt history line }{",
    ].join("\n") + "\n",
  );
  return { root, cfg, origin, dest, alpha, beta, wt };
}

function run(fx, args, { env = {}, stdin } = {}) {
  const result = spawnSync("node", [TOOL, ...args], {
    encoding: "utf8",
    input: stdin,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: fx.cfg,
      CLAUDE_FOLDER_MOVE_BACKUP_DIR: path.join(fx.root, "backups"),
      CLAUDE_DESKTOP_SESSIONS_DIR: path.join(fx.root, "desktop-none"), // hermetic: never the real one
      ...env,
    },
  });
  return result;
}

function treeHash(dir) {
  const items = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        items.push("D " + path.relative(dir, full));
        walk(full);
      } else {
        items.push("F " + path.relative(dir, full) + " " + crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex"));
      }
    }
  };
  walk(dir);
  return crypto.createHash("sha256").update(items.join("\n")).digest("hex");
}

function check(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}${detail ? " — " + detail : ""}`);
  }
}

function applyArgs(fx, projects, extra = []) {
  return ["--apply", "--origin", fx.origin, "--dest", fx.dest, "--projects", projects, "--yes", ...extra];
}

// --make-fixture: build one fixture (plus a bare no-metadata folder, so the
// checklist's hide/rename keys have something to act on) and print its paths
// as JSON, running no tests — used by the PTY smoke test.
if (process.argv.includes("--make-fixture")) {
  const fx = makeFixture("pty");
  fs.mkdirSync(path.join(fx.origin, "no-meta-folder"));
  console.log(JSON.stringify({ ...fx, backups: path.join(fx.root, "backups") }, null, 2));
  process.exit(0);
}

// ---------------------------------------------------------------------------
console.log("test: scan discovers fixture projects");
{
  const fx = makeFixture("scan");
  const result = run(fx, ["--scan", "--json"]);
  const projects = JSON.parse(result.stdout);
  const paths = projects.map((p) => p.path);
  check("alpha discovered", paths.includes(fx.alpha));
  check("beta (space in name) discovered", paths.includes(fx.beta));
  check("worktree discovered", paths.includes(fx.wt));
  check("exit 0", result.status === 0);
}

console.log("test: happy-path apply (metadata + folder copy)");
{
  const fx = makeFixture("happy");
  const result = run(fx, applyArgs(fx, "alpha,beta project", ["--copy-folders"]));
  check("exit 0", result.status === 0, result.stderr);
  const newAlpha = path.join(fx.dest, "alpha");
  const newBeta = path.join(fx.dest, "beta project");
  check("alpha folder copied", fs.existsSync(path.join(newAlpha, "file.txt")));
  check("beta folder copied", fs.existsSync(path.join(newBeta, "file.txt")));
  check("source folders untouched", fs.existsSync(path.join(fx.alpha, "file.txt")) && fs.existsSync(path.join(fx.beta, "file.txt")));
  const newAlphaDir = path.join(fx.cfg, "projects", enc(newAlpha));
  check("alpha session dir renamed", fs.existsSync(path.join(newAlphaDir, "session-a.jsonl")));
  check("old alpha session dir gone", !fs.existsSync(path.join(fx.cfg, "projects", enc(fx.alpha))));
  const text = fs.readFileSync(path.join(newAlphaDir, "session-a.jsonl"), "utf8");
  const lines = text.trim().split("\n");
  check("cwd rewritten", JSON.parse(lines[0]).cwd === newAlpha);
  check("nested cwd rewritten via prefix", JSON.parse(lines[3]).cwd === `${newAlpha}/subdir`);
  check("toolUseResult content NOT rewritten", JSON.parse(lines[1]).toolUseResult.filePath.startsWith(fx.alpha));
  check("corrupt session line byte-identical", lines[2] === "this is not json {{{");
  const wtNew = `${newAlpha}/.claude/worktrees/test-wt`;
  check("worktree dir renamed via prefix", fs.existsSync(path.join(fx.cfg, "projects", enc(wtNew))));
  const config = JSON.parse(fs.readFileSync(path.join(fx.cfg, ".claude.json"), "utf8"));
  check("claude.json key moved", Boolean(config.projects[newAlpha]) && !config.projects[fx.alpha]);
  check("claude.json values preserved", config.projects[newAlpha].allowedTools[0] === "Bash(git *)");
  const hist = fs.readFileSync(path.join(fx.cfg, "history.jsonl"), "utf8").trim().split("\n");
  check("history project rewritten", JSON.parse(hist[0]).project === newAlpha);
  check("corrupt history line intact", hist[2] === "corrupt history line }{");
}

console.log("test: collision blocks; bare config entry merges");
{
  const fx = makeFixture("collision");
  // destination project with real transcripts = hard collision
  const destAlpha = path.join(fx.dest, "alpha");
  const dir = path.join(fx.cfg, "projects", enc(destAlpha));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "existing.jsonl"), JSON.stringify({ type: "user", cwd: destAlpha }) + "\n");
  const result = run(fx, applyArgs(fx, "alpha"));
  check("collision apply refused", result.status !== 0);
  check("collision message names the blocker", /not eligible|history/i.test(result.stderr + result.stdout));

  // bare config entry at destination merges
  const fx2 = makeFixture("merge");
  const destBeta = path.join(fx2.dest, "beta project");
  const config = JSON.parse(fs.readFileSync(path.join(fx2.cfg, ".claude.json"), "utf8"));
  config.projects[destBeta] = { allowedTools: ["WebSearch"], hasTrustDialogAccepted: true };
  fs.writeFileSync(path.join(fx2.cfg, ".claude.json"), JSON.stringify(config, null, 2));
  const result2 = run(fx2, applyArgs(fx2, "beta project"));
  check("merge apply exit 0", result2.status === 0, result2.stderr);
  const after = JSON.parse(fs.readFileSync(path.join(fx2.cfg, ".claude.json"), "utf8"));
  check("merged entry exists once", Boolean(after.projects[destBeta]) && !after.projects[fx2.beta]);
  check("arrays union-deduped", after.projects[destBeta].allowedTools.includes("WebSearch"));
}

console.log("test: injected failures restore byte-identical state");
for (const point of ["after-renames", "after-config", "after-history", "after-sessions", "postflight"]) {
  const fx = makeFixture("fail-" + point.replace(/[^a-z-]/g, ""));
  const before = treeHash(fx.cfg);
  const result = run(fx, applyArgs(fx, "alpha"), { env: { CLAUDE_FOLDER_MOVE_INJECT_FAIL: point } });
  check(`${point}: apply failed as injected`, result.status !== 0);
  check(`${point}: config tree byte-identical after auto-restore`, treeHash(fx.cfg) === before);
}

console.log("test: standalone rollback script restores after successful apply");
{
  const fx = makeFixture("rollback");
  const before = treeHash(fx.cfg);
  const result = run(fx, applyArgs(fx, "alpha"));
  check("apply exit 0", result.status === 0, result.stderr);
  check("state changed", treeHash(fx.cfg) !== before);
  const backups = fs.readdirSync(path.join(fx.root, "backups"));
  const rollback = path.join(fx.root, "backups", backups[0], "rollback.mjs");
  execFileSync("node", [rollback], { encoding: "utf8" });
  check("rollback returns tree byte-identical", treeHash(fx.cfg) === before);
}

console.log("test: --restore latest restores via the tool");
{
  const fx = makeFixture("restorecmd");
  const before = treeHash(fx.cfg);
  run(fx, applyArgs(fx, "alpha"));
  const result = run(fx, ["--restore", "latest"]);
  check("restore exit 0", result.status === 0, result.stderr);
  check("tree byte-identical", treeHash(fx.cfg) === before);
}

console.log("test: interactive cancel paths are byte-identical no-ops");
{
  const fx = makeFixture("cancel");
  const before = treeHash(fx.cfg);
  for (const stdin of ["5\n", "1\nq\n5\n", "1\n1\nq\n5\n"]) {
    const result = run(fx, [], { stdin });
    check(`cancel [${JSON.stringify(stdin)}] exit 0`, result.status === 0, result.stderr);
  }
  // full flow but decline the final confirm
  const origins = run(fx, [], { stdin: "1\nc\n" + fx.origin + "\nc\n" + fx.dest + "\na\nd\nn\nno\n5\n" });
  check("declined confirm exit 0", origins.status === 0, origins.stderr);
  check("tree unchanged after all cancels", treeHash(fx.cfg) === before);
}

console.log("test: interactive happy path via piped stdin");
{
  const fx = makeFixture("interactive");
  const stdin = "1\nc\n" + fx.origin + "\nc\n" + fx.dest + "\na\nd\ny\nmigrate\n5\n";
  const result = run(fx, [], { stdin });
  check("exit 0", result.status === 0, result.stderr);
  const newAlpha = path.join(fx.dest, "alpha");
  check("migration applied", fs.existsSync(path.join(fx.cfg, "projects", enc(newAlpha), "session-a.jsonl")));
  check("folder copied", fs.existsSync(path.join(newAlpha, "file.txt")));
}

console.log("test: --rename changes destination folder name end-to-end");
{
  const fx = makeFixture("rename");
  const result = run(fx, applyArgs(fx, "alpha", ["--copy-folders", "--rename", "alpha=alpha-two"]));
  check("exit 0", result.status === 0, result.stderr);
  const renamed = path.join(fx.dest, "alpha-two");
  check("folder copied under NEW name", fs.existsSync(path.join(renamed, "file.txt")));
  check("session dir uses NEW name encoding", fs.existsSync(path.join(fx.cfg, "projects", enc(renamed), "session-a.jsonl")));
  check(
    "cwd rewritten to renamed path",
    fs.readFileSync(path.join(fx.cfg, "projects", enc(renamed), "session-a.jsonl"), "utf8").includes(renamed),
  );
  const config = JSON.parse(fs.readFileSync(path.join(fx.cfg, ".claude.json"), "utf8"));
  check("claude.json key uses renamed path", Boolean(config.projects[renamed]) && !config.projects[fx.alpha]);
}

console.log("test: bare folders collapse behind h in the checklist");
{
  const fx = makeFixture("hidden");
  fs.mkdirSync(path.join(fx.origin, "no-meta-folder"));
  // enter checklist, then quit — capture the listing
  const result = run(fx, [], { stdin: "1\nc\n" + fx.origin + "\nc\n" + fx.dest + "\nq\n5\n" });
  check("hidden summary shown", /folder\(s\) without Claude metadata hidden/.test(result.stdout));
  check("bare folder not listed by default", !/no-meta-folder/.test(result.stdout));
  // with h, it appears
  const result2 = run(fx, [], { stdin: "1\nc\n" + fx.origin + "\nc\n" + fx.dest + "\nh\nq\n5\n" });
  check("bare folder listed after h", /no-meta-folder/.test(result2.stdout));
}

console.log("test: interactive rename via r N");
{
  const fx = makeFixture("irename");
  const stdin = "1\nc\n" + fx.origin + "\nc\n" + fx.dest + "\nr 1\nalpha-x\n1\nd\ny\nmigrate\n5\n";
  const result = run(fx, [], { stdin });
  check("exit 0", result.status === 0, result.stderr);
  const renamed = path.join(fx.dest, "alpha-x");
  check("interactive rename applied", fs.existsSync(path.join(fx.cfg, "projects", enc(renamed), "session-a.jsonl")));
}

console.log("test: ineligible folder without metadata is not silently migrated");
{
  const fx = makeFixture("nometa");
  fs.mkdirSync(path.join(fx.origin, "empty-folder"));
  const result = run(fx, applyArgs(fx, "empty-folder"));
  check("refused", result.status !== 0);
  check("names the blocker", /no Claude metadata/i.test(result.stderr + result.stdout));
}

console.log(`\n${passed} passed, ${failed} failed  (fixtures in ${TMP})`);
if (failed) process.exit(1);
fs.rmSync(TMP, { recursive: true, force: true });
