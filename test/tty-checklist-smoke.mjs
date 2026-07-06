#!/usr/bin/env node
/*
  Real-terminal (PTY) smoke test for claude-folder-move.mjs's OWN interactive
  checklist/picker UI (the rich alternate-screen redesign). Complements the
  existing test/tty-smoke.sh, which only checks the downstream `claude
  --resume` picker after a migration — this one drives claude-folder-move.mjs
  itself through a real PTY: raw keystrokes, arrows, the hide-bare-folder 'h'
  toggle, select-all, and the folder-copy/migrate confirmations.

  Run: node test/tty-checklist-smoke.mjs
*/

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(TEST_DIR, "..", "claude-folder-move.mjs");

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}

if (spawnSync("expect", ["-v"], { encoding: "utf8" }).status !== 0) {
  fail("expect(1) not found — it ships with macOS; install it to run the PTY test");
}

console.log("Building fixture (alpha, beta project, + a bare no-meta folder)...");
const made = spawnSync(process.execPath, [path.join(TEST_DIR, "run-tests.mjs"), "--make-fixture"], {
  encoding: "utf8",
});
if (made.status !== 0) fail(`fixture build failed: ${made.stderr}`);
const fx = JSON.parse(made.stdout);
const desktopNone = path.join(fx.root, "desktop-none");

const enc = (p) => p.replace(/[^a-zA-Z0-9-]/g, "-");

console.log("PTY session: interactive migration via the rich checklist (expect drives a real terminal)...");
const migrate = spawnSync(
  "expect",
  [path.join(TEST_DIR, "tty-migrate.exp"), TOOL, fx.cfg, path.join(fx.root, "backups"), desktopNone, fx.origin, fx.dest],
  { encoding: "utf8" },
);
process.stdout.write(migrate.stdout);
if (migrate.status !== 0) fail(`PTY session exited ${migrate.status}`);
if (!migrate.stdout.includes("Migration complete.")) fail("no completion message in PTY transcript");
if (!migrate.stdout.includes("no-meta-folder")) fail("'h' toggle never revealed the bare folder — hide/show mechanism didn't work");

const newAlpha = path.join(fx.dest, "alpha");
const newBeta = path.join(fx.dest, "beta project");
const alphaSessionDir = path.join(fx.cfg, "projects", enc(newAlpha));
const betaSessionDir = path.join(fx.cfg, "projects", enc(newBeta));

if (!fs.existsSync(path.join(alphaSessionDir, "session-a.jsonl"))) fail("alpha session dir not migrated");
if (!fs.existsSync(path.join(betaSessionDir, "session-b.jsonl"))) fail("beta session dir not migrated");
const alphaSession = fs.readFileSync(path.join(alphaSessionDir, "session-a.jsonl"), "utf8");
if (!alphaSession.includes(`"cwd":"${newAlpha}"`)) fail("alpha session cwd not rewritten");
const claudeJson = JSON.parse(fs.readFileSync(path.join(fx.cfg, ".claude.json"), "utf8"));
if (!claudeJson.projects[newAlpha]) fail("claude.json missing new alpha project key");
if (!claudeJson.projects[newBeta]) fail("claude.json missing new beta project key");
if (claudeJson.projects[fx.alpha] || claudeJson.projects[fx.beta]) fail("claude.json still has an old project key");
if (!fs.existsSync(path.join(newAlpha, "file.txt"))) fail("alpha folder not copied to destination");
if (!fs.existsSync(path.join(fx.alpha, "file.txt"))) fail("SOURCE FOLDER WAS TOUCHED");
if (fs.existsSync(path.join(fx.dest, "no-meta-folder"))) fail("bare folder was migrated even though it was never selected");

console.log("PASS  real-PTY checklist: hide/show toggle, select-all, folder copy, and migration all verified");
console.log(`Fixture kept under: ${fx.root}`);
