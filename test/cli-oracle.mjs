#!/usr/bin/env node
/*
  Layer-1 oracle test: uses the REAL claude CLI against an isolated
  CLAUDE_CONFIG_DIR fixture. Proves the two things fixtures can't:
  1. The folder-name encoder matches the real CLI's encoding (spaces included).
  2. A migrated session actually RESUMES at the new path with its memory intact.

  Requirements: an authenticated TEST config dir, passed via CFM_ORACLE_CFG.
  One-time setup per machine (interactive, no credential copying):
      mkdir -p <dir> && CLAUDE_CONFIG_DIR=<dir> claude /login
  Costs a few haiku calls. Never touches the real ~/.claude.
*/

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "claude-folder-move.mjs");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cfm-oracle-")));
const CFG = process.env.CFM_ORACLE_CFG;
if (!CFG || !fs.existsSync(CFG)) {
  console.error("Set CFM_ORACLE_CFG to an authenticated test config dir (see header).");
  process.exit(1);
}
const CODEWORD = "ZANZIBAR42";
let passed = 0;
let failed = 0;

const enc = (p) => p.replace(/[^a-zA-Z0-9-]/g, "-");
const check = (label, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`  ok: ${label}`); }
  else { failed += 1; console.log(`  FAIL: ${label}${detail ? " — " + detail : ""}`); }
};

function claude(cwd, args) {
  return execFileSync("claude", [...args, "--model", "haiku"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CLAUDE_CONFIG_DIR: CFG },
    timeout: 120000,
  });
}

try {
  const origin = path.join(TMP, "Oracle Origin");
  const dest = path.join(TMP, "Oracle Dest Parent"); // spaces on both sides
  const oldProj = path.join(origin, "proj one");
  const newProj = path.join(dest, "proj one");
  fs.mkdirSync(oldProj, { recursive: true });
  fs.mkdirSync(dest, { recursive: true });

  // --- 1. real session at the origin, planted codeword -------------------
  console.log("oracle: creating a real session at the origin (haiku)...");
  const out1 = claude(oldProj, ["-p", `The codeword is ${CODEWORD}. Remember it. Reply with exactly: STORED`, "--output-format", "json"]);
  const result1 = JSON.parse(out1);
  const sessionId = result1.session_id;
  check("session created, id captured", Boolean(sessionId));
  check("model stored the codeword", /STORED/.test(result1.result || ""));

  // --- 2. encoder oracle ---------------------------------------------------
  const expectedDir = path.join(CFG, "projects", enc(oldProj));
  check("real CLI encoding matches tool encoder", fs.existsSync(expectedDir), `expected ${expectedDir}`);
  const jsonls = fs.readdirSync(expectedDir).filter((f) => f.endsWith(".jsonl"));
  check("transcript written", jsonls.length >= 1);

  // --- 3. physical folder move (the user's Finder move), then migrate ----
  fs.renameSync(oldProj, newProj);
  console.log("oracle: running claude-folder-move (metadata-only)...");
  const applyOut = execFileSync(
    "node",
    [TOOL, "--apply", "--origin", origin, "--dest", dest, "--projects", "proj one", "--yes"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: CFG,
        CLAUDE_FOLDER_MOVE_BACKUP_DIR: path.join(TMP, "backups"),
      },
    },
  );
  check("migration applied", /Migration complete/.test(applyOut));
  check("session dir renamed to new encoding", fs.existsSync(path.join(CFG, "projects", enc(newProj))));

  // --- 4. THE test: resume at the new path, recall the codeword ----------
  console.log("oracle: resuming the migrated session at the new path (haiku)...");
  const out2 = claude(newProj, ["--resume", sessionId, "-p", "What is the codeword? Reply with only the codeword, nothing else."]);
  check("resumed session recalls the codeword", out2.includes(CODEWORD), `got: ${out2.trim().slice(0, 120)}`);

  // --- 5. resumed continuation landed in the migrated transcript ----------
  const newDir = path.join(CFG, "projects", enc(newProj));
  const grew = fs.readdirSync(newDir).some((f) => f.endsWith(".jsonl") && fs.readFileSync(path.join(newDir, f), "utf8").includes(CODEWORD));
  check("continuation written under the NEW encoded dir", grew);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true }); // project dirs only; CFG persists
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
