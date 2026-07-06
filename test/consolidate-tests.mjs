#!/usr/bin/env node
/*
  Fixture tests for consolidate mode: merge a project's history from several
  path-eras into one target. Builds fake CLAUDE_CONFIG_DIR trees in temp —
  never touches real ~/.claude.
*/

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "claude-folder-move.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cfm-consol-"));
let passed = 0;
let failed = 0;
const enc = (p) => p.replace(/[^a-zA-Z0-9-]/g, "-");
const check = (label, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`  ok: ${label}`); }
  else { failed += 1; console.log(`  FAIL: ${label}${detail ? " — " + detail : ""}`); }
};

// A logical "diary" scattered across old-gdrive, local, new-gdrive (target).
function makeFixture(name, { collisionUuid = false } = {}) {
  const root = path.join(TMP, name);
  const cfg = path.join(root, "cfg");
  fs.mkdirSync(path.join(cfg, "projects"), { recursive: true });

  const oldG = path.join(root, "Old GDrive", "diary");
  const local = path.join(root, "Local", "diary");
  const newG = path.join(root, "New GDrive", "diary"); // target
  const paths = { oldG, local, newG };

  const mkSession = (projPath, sessionName, extraLines = []) => {
    const dir = path.join(cfg, "projects", enc(projPath));
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: "user", cwd: projPath, sessionId: sessionName.replace(".jsonl", ""), message: { content: `work in ${sessionName}` } }),
      JSON.stringify({ type: "assistant", cwd: projPath, toolUseResult: { filePath: `${projPath}/x.txt` } }),
      ...extraLines,
    ];
    fs.writeFileSync(path.join(dir, sessionName), lines.join("\n") + "\n");
    return path.join(dir, sessionName);
  };

  // old-gdrive: main session + a worktree session (nested cwd)
  mkSession(oldG, "old-main.jsonl");
  const wt = `${oldG}/.claude/worktrees/wt-x`;
  fs.mkdirSync(path.join(cfg, "projects", enc(wt)), { recursive: true });
  fs.writeFileSync(
    path.join(cfg, "projects", enc(wt), "old-wt.jsonl"),
    JSON.stringify({ type: "user", cwd: wt, sessionId: "old-wt", message: {} }) + "\n",
  );
  // local: new work
  mkSession(local, "local-1.jsonl");
  // target already has one live session
  mkSession(newG, "new-live.jsonl");
  if (collisionUuid) {
    // give local a session file with the SAME name as one already at target
    mkSession(local, "new-live.jsonl");
  }

  // desktop app session index (fed via CLAUDE_DESKTOP_SESSIONS_DIR in tests)
  const desktop = path.join(root, "desktop", "win-a", "cfg-b");
  fs.mkdirSync(desktop, { recursive: true });
  fs.writeFileSync(
    path.join(desktop, "local_old-main.json"),
    JSON.stringify({ sessionId: "old-main", cwd: oldG, originCwd: oldG, title: "old work" }),
  );
  fs.writeFileSync(
    path.join(desktop, "local_local-1.json"),
    JSON.stringify({ sessionId: "local-1", cwd: local, originCwd: local, title: "local work" }),
  );

  const claudeJson = {
    projects: {
      [oldG]: { allowedTools: ["Bash(git *)"], hasTrustDialogAccepted: true, mcpServers: {} },
      [local]: { allowedTools: ["WebSearch"], hasTrustDialogAccepted: true },
      [newG]: { allowedTools: ["Read"], hasTrustDialogAccepted: true },
    },
  };
  fs.writeFileSync(path.join(cfg, ".claude.json"), JSON.stringify(claudeJson, null, 2));
  fs.writeFileSync(
    path.join(cfg, "history.jsonl"),
    [
      JSON.stringify({ display: "old cmd", project: oldG, sessionId: "old-main" }),
      JSON.stringify({ display: "local cmd", project: local, sessionId: "local-1" }),
      JSON.stringify({ display: "new cmd", project: newG, sessionId: "new-live" }),
    ].join("\n") + "\n",
  );
  return { root, cfg, desktopRoot: path.join(root, "desktop"), desktopDir: desktop, ...paths, wt };
}

function run(fx, args, { env = {}, stdin } = {}) {
  return spawnSync("node", [TOOL, ...args], {
    encoding: "utf8",
    input: stdin,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: fx.cfg,
      CLAUDE_FOLDER_MOVE_BACKUP_DIR: path.join(fx.root, "backups"),
      CLAUDE_DESKTOP_SESSIONS_DIR: fx.desktopRoot,
      ...env,
    },
  });
}

function treeHash(dir) {
  const items = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { items.push("D " + path.relative(dir, full)); walk(full); }
      else items.push("F " + path.relative(dir, full) + " " + crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex"));
    }
  };
  walk(dir);
  return crypto.createHash("sha256").update(items.join("\n")).digest("hex");
}

const consolidateArgs = (fx) => ["--consolidate", "--target", fx.newG, "--sources", `${fx.oldG},${fx.local}`, "--yes"];

// ---------------------------------------------------------------------------
console.log("test: happy-path consolidate (old-gdrive + local -> new-gdrive)");
{
  const fx = makeFixture("happy");
  const result = run(fx, consolidateArgs(fx));
  check("exit 0", result.status === 0, result.stderr);
  const targetDir = path.join(fx.cfg, "projects", enc(fx.newG));
  const files = fs.readdirSync(targetDir).sort();
  check("target keeps its own live session", files.includes("new-live.jsonl"));
  check("old-gdrive main session merged in", files.includes("old-main.jsonl"));
  check("local session merged in", files.includes("local-1.jsonl"));
  check("all three histories now in target dir", files.filter((f) => f.endsWith(".jsonl")).length === 3);
  // worktree session lands in the target's worktree encoded dir
  const wtTarget = `${fx.newG}/.claude/worktrees/wt-x`;
  const wtDir = path.join(fx.cfg, "projects", enc(wtTarget));
  check("worktree session merged under rewritten path", fs.existsSync(path.join(wtDir, "old-wt.jsonl")));
  // cwd rewritten in merged copies
  check("merged old-main cwd rewritten to target", JSON.parse(fs.readFileSync(path.join(targetDir, "old-main.jsonl"), "utf8").trim().split("\n")[0]).cwd === fx.newG);
  check("merged worktree cwd rewritten via prefix", JSON.parse(fs.readFileSync(path.join(wtDir, "old-wt.jsonl"), "utf8").trim().split("\n")[0]).cwd === wtTarget);
  // source dirs removed
  check("old-gdrive source dir removed", !fs.existsSync(path.join(fx.cfg, "projects", enc(fx.oldG))));
  check("local source dir removed", !fs.existsSync(path.join(fx.cfg, "projects", enc(fx.local))));
  check("old worktree source dir removed", !fs.existsSync(path.join(fx.cfg, "projects", enc(fx.wt))));
  // claude.json: sources folded into target, config unioned
  const config = JSON.parse(fs.readFileSync(path.join(fx.cfg, ".claude.json"), "utf8"));
  check("source claude.json keys gone", !config.projects[fx.oldG] && !config.projects[fx.local]);
  check("target claude.json key remains", Boolean(config.projects[fx.newG]));
  check("config arrays unioned", ["Read", "Bash(git *)", "WebSearch"].every((t) => config.projects[fx.newG].allowedTools.includes(t)));
  // history rewritten
  const hist = fs.readFileSync(path.join(fx.cfg, "history.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  check("all history lines now point at target", hist.every((h) => h.project === fx.newG));
  // desktop app index rewritten
  const dOld = JSON.parse(fs.readFileSync(path.join(fx.desktopDir, "local_old-main.json"), "utf8"));
  const dLocal = JSON.parse(fs.readFileSync(path.join(fx.desktopDir, "local_local-1.json"), "utf8"));
  check("desktop index cwd rewritten (old era)", dOld.cwd === fx.newG && dOld.originCwd === fx.newG);
  check("desktop index cwd rewritten (local era)", dLocal.cwd === fx.newG);
  check("desktop index title untouched", dOld.title === "old work");
}

console.log("test: UUID collision refuses (no overwrite)");
{
  const fx = makeFixture("uuid", { collisionUuid: true });
  const before = treeHash(fx.cfg);
  const result = run(fx, consolidateArgs(fx));
  check("apply refused", result.status !== 0);
  check("names session-id collision", /session-id collision/i.test(result.stderr + result.stdout));
  check("state byte-identical (nothing changed)", treeHash(fx.cfg) === before);
}

console.log("test: injected failures restore byte-identical (incl. source dirs + desktop index)");
for (const point of ["after-mkdir", "after-copies", "after-config", "after-history", "after-desktop", "postflight"]) {
  const fx = makeFixture("fail-" + point.replace(/[^a-z]/g, ""));
  const before = treeHash(fx.cfg);
  const beforeDesktop = treeHash(fx.desktopRoot);
  const result = run(fx, consolidateArgs(fx), { env: { CLAUDE_FOLDER_MOVE_INJECT_FAIL: point } });
  check(`${point}: failed as injected`, result.status !== 0);
  check(`${point}: config tree byte-identical after auto-restore`, treeHash(fx.cfg) === before, "sources+target must be fully restored");
  check(`${point}: desktop index byte-identical after auto-restore`, treeHash(fx.desktopRoot) === beforeDesktop);
}

console.log("test: standalone rollback restores after successful consolidate");
{
  const fx = makeFixture("rollback");
  const before = treeHash(fx.cfg);
  check("apply exit 0", run(fx, consolidateArgs(fx)).status === 0);
  check("state changed", treeHash(fx.cfg) !== before);
  const backupDir = fs.readdirSync(path.join(fx.root, "backups"))[0];
  execFileSync("node", [path.join(fx.root, "backups", backupDir, "rollback.mjs")], { encoding: "utf8" });
  check("rollback returns byte-identical tree", treeHash(fx.cfg) === before);
}

console.log("test: worktree era groups under parent project in the picker");
{
  const fx = makeFixture("wtgroup");
  // scan --json to confirm the worktree is discovered as its own path...
  const scan = JSON.parse(run(fx, ["--scan", "--json"]).stdout);
  const wtDiscovered = scan.some((p) => p.path === fx.wt);
  check("worktree discovered as a project", wtDiscovered);
  // ...and the interactive picker lists a "diary" group that includes it.
  // menu 2 -> the diary group should include oldG, its worktree, local, newG.
  // Pick group 1 (diary), target=custom newG, confirm.
  const stdin = "2\n1\nc\n" + fx.newG + "\nconsolidate\n5\n";
  const result = run(fx, [], { stdin });
  check("interactive consolidate incl. worktree exit 0", result.status === 0, result.stderr);
  const wtTargetDir = path.join(fx.cfg, "projects", enc(`${fx.newG}/.claude/worktrees/wt-x`));
  check("worktree session flattened/merged under target", fs.existsSync(path.join(wtTargetDir, "old-wt.jsonl")));
  check("group listing showed the worktree tag", /worktree session/.test(result.stdout));
}

console.log("test: parent path as source pulls its worktree descendants");
{
  const fx = makeFixture("parentsrc");
  // pass the PARENT diary path (not itself a discovered project — only its
  // worktree is) and confirm the worktree still merges
  const result = run(fx, ["--consolidate", "--target", fx.newG, "--sources", fx.oldG, "--yes"]);
  check("parent-source consolidate exit 0", result.status === 0, result.stderr);
  const wtTargetDir = path.join(fx.cfg, "projects", enc(`${fx.newG}/.claude/worktrees/wt-x`));
  check("worktree under parent source merged", fs.existsSync(path.join(wtTargetDir, "old-wt.jsonl")));
}

console.log("test: interactive consolidate via piped stdin");
{
  const fx = makeFixture("interactive");
  // menu 2 -> pick group 'diary' (1) -> target = new gdrive (custom path) -> confirm
  const stdin = "2\n1\nc\n" + fx.newG + "\nconsolidate\n5\n";
  const result = run(fx, [], { stdin });
  check("exit 0", result.status === 0, result.stderr);
  const targetDir = path.join(fx.cfg, "projects", enc(fx.newG));
  check("merged via interactive flow", fs.existsSync(path.join(targetDir, "old-main.jsonl")) && fs.existsSync(path.join(targetDir, "local-1.jsonl")));
}

console.log(`\n${passed} passed, ${failed} failed  (fixtures in ${TMP})`);
if (failed) process.exit(1);
fs.rmSync(TMP, { recursive: true, force: true });
