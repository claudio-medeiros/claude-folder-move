#!/usr/bin/env node
/*
  Layer-1 oracle for consolidate: two REAL sessions created at two different
  paths (simulating old-gdrive and local eras), consolidated into a third
  target. Proves BOTH resume at the target with their distinct memories.

  Requires CFM_ORACLE_CFG (authenticated test config dir). Costs ~4 haiku calls.
*/

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "claude-folder-move.mjs");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cfm-consol-oracle-")));
const CFG = process.env.CFM_ORACLE_CFG;
if (!CFG || !fs.existsSync(CFG)) { console.error("Set CFM_ORACLE_CFG (authenticated test config dir)."); process.exit(1); }
let passed = 0, failed = 0;
const enc = (p) => p.replace(/[^a-zA-Z0-9-]/g, "-");
const check = (l, ok, d = "") => { if (ok) { passed++; console.log(`  ok: ${l}`); } else { failed++; console.log(`  FAIL: ${l}${d ? " — " + d : ""}`); } };
const claude = (cwd, args) =>
  execFileSync("claude", [...args, "--model", "haiku"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CLAUDE_CONFIG_DIR: CFG }, timeout: 120000 });

try {
  const oldEra = path.join(TMP, "Old Era", "notebook");
  const localEra = path.join(TMP, "Local Era", "notebook");
  const target = path.join(TMP, "New Drive", "notebook");
  fs.mkdirSync(oldEra, { recursive: true });
  fs.mkdirSync(localEra, { recursive: true });

  console.log("oracle: session in the 'old' era (haiku)...");
  const s1 = JSON.parse(claude(oldEra, ["-p", "The OLD codeword is MERIDIAN. Reply exactly: STORED", "--output-format", "json"]));
  console.log("oracle: session in the 'local' era (haiku)...");
  const s2 = JSON.parse(claude(localEra, ["-p", "The LOCAL codeword is TANGERINE. Reply exactly: STORED", "--output-format", "json"]));
  check("two sessions created", Boolean(s1.session_id) && Boolean(s2.session_id) && s1.session_id !== s2.session_id);

  // simulate the folder moves: both eras' folders no longer where they were;
  // the target folder is where work continues
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(localEra, target, { recursive: true });

  console.log("oracle: consolidating both eras into the target...");
  const out = execFileSync(
    "node",
    [TOOL, "--consolidate", "--target", target, "--sources", `${oldEra},${localEra}`, "--yes"],
    { encoding: "utf8", env: { ...process.env, CLAUDE_CONFIG_DIR: CFG, CLAUDE_FOLDER_MOVE_BACKUP_DIR: path.join(TMP, "backups") } },
  );
  check("consolidation completed", /Consolidation complete/.test(out));
  const targetDir = path.join(CFG, "projects", enc(target));
  check("both sessions now in target encoded dir", fs.existsSync(path.join(targetDir, `${s1.session_id}.jsonl`)) && fs.existsSync(path.join(targetDir, `${s2.session_id}.jsonl`)));

  console.log("oracle: resuming the OLD-era session at the target (haiku)...");
  const r1 = claude(target, ["--resume", s1.session_id, "-p", "What is the OLD codeword? Reply with only the codeword."]);
  check("old-era session recalls MERIDIAN at target", r1.includes("MERIDIAN"), r1.trim().slice(0, 80));

  console.log("oracle: resuming the LOCAL-era session at the target (haiku)...");
  const r2 = claude(target, ["--resume", s2.session_id, "-p", "What is the LOCAL codeword? Reply with only the codeword."]);
  check("local-era session recalls TANGERINE at target", r2.includes("TANGERINE"), r2.trim().slice(0, 80));
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
