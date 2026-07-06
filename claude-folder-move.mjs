#!/usr/bin/env node
/*
  claude-folder-move — retarget Claude Code state when project folders move.

  Sibling of codex-folder-move (same UX and safety engine), adapted to
  Claude Code's stores. Sessions stay under the Claude config dir — only
  encoded folder names and path references are rewritten.

  Design rules:
  - Planning may scan Claude state; apply only touches files listed in the plan.
  - One batch backup (sha256 manifest + standalone rollback script) before any write.
  - Any error during apply/postflight triggers an automatic checksum-verified restore.
  - Project folders are only ever COPIED to the destination, never deleted.
  - Encoded project-dir names are never decoded (encoding is lossy); each
    project's real path is derived from cwd fields inside its own transcripts.

  Stores patched (see claude-state-stores memory):
  - <config>/projects/<encoded-path>/   directory renamed to the new encoding
  - session *.jsonl inside it           top-level "cwd" fields rewritten (prefix-aware)
  - claude.json                         "projects" map entry moved to the new path key
  - <config>/history.jsonl              per-line "project" field rewritten

  Deliberately NOT patched: toolUseResult/message content (historical text),
  plans/, tasks/, file-history/ (content snapshots), backups/, transient stores
  (sessions/, session-env/, daemon/, shell-snapshots/, ide/).

  Requirements: Node 18+. Claude Code (desktop app and CLI sessions) closed while applying.
*/

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

// ---------------------------------------------------------------------------
// Environment & CLI
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), ".claude");
const argv = process.argv.slice(2);

const CONFIG_DIR = path.resolve(
  getArgValue("--config-dir") || process.env.CLAUDE_CONFIG_DIR || DEFAULT_CONFIG_DIR,
);
// legacy layout keeps claude.json as a sibling of ~/.claude; CLAUDE_CONFIG_DIR
// layouts keep it inside the config dir — prefer whichever actually exists
const CLAUDE_JSON = (() => {
  const inside = path.join(CONFIG_DIR, ".claude.json");
  const sibling = path.join(path.dirname(CONFIG_DIR), ".claude.json");
  if (getArgValue("--claude-json")) return path.resolve(getArgValue("--claude-json"));
  if (CONFIG_DIR === DEFAULT_CONFIG_DIR && fs.existsSync(sibling)) return sibling;
  return inside;
})();
const BACKUP_ROOT = path.resolve(
  getArgValue("--backup-dir") ||
    process.env.CLAUDE_FOLDER_MOVE_BACKUP_DIR ||
    path.join(os.homedir(), "claude-folder-move-backups"),
);

// The desktop app keeps its own per-session index (feeds its Recents list and
// project filter): local_<id>.json files with cwd/originCwd fields. Absent on
// CLI-only machines; overridable for tests.
const DESKTOP_SESSIONS_ROOT = path.resolve(
  getArgValue("--desktop-sessions-dir") ||
    process.env.CLAUDE_DESKTOP_SESSIONS_DIR ||
    path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code-sessions"),
);

const FILES = {
  projectsRoot: path.join(CONFIG_DIR, "projects"),
  historyJsonl: path.join(CONFIG_DIR, "history.jsonl"),
  liveSessionsDir: path.join(CONFIG_DIR, "sessions"),
  claudeJson: CLAUDE_JSON,
};

function desktopIndexFiles(oldPath) {
  const out = [];
  for (const file of walkFiles(DESKTOP_SESSIONS_ROOT, ".json")) {
    if (!path.basename(file).startsWith("local_")) continue;
    const json = safeReadJson(file);
    if (!json) continue;
    if (pathMatches(json.cwd, oldPath) || pathMatches(json.originCwd, oldPath)) out.push(file);
  }
  return out;
}

function patchDesktopIndex(files, pairs) {
  for (const file of files) {
    const json = safeReadJson(file);
    if (!json) continue;
    let changed = false;
    for (const key of ["cwd", "originCwd"]) {
      if (typeof json[key] === "string") {
        const replaced = replacePathAny(json[key], pairs);
        if (replaced !== json[key]) {
          json[key] = replaced;
          changed = true;
        }
      }
    }
    if (changed) fs.writeFileSync(file, JSON.stringify(json));
  }
}

main().catch((error) => {
  console.error(String(error?.stack || error));
  process.exit(1);
});

async function main() {
  ensureRuntime();

  if (argv.includes("--help") || argv.includes("-h")) return printHelp();
  if (argv.includes("--scan")) return cmdScan();
  if (argv.includes("--consolidate")) return cmdConsolidate(); // may combine with --plan
  if (argv.includes("--fix-desktop")) return cmdFixDesktop();
  if (argv.includes("--plan")) return cmdPlan();
  if (argv.includes("--apply")) return cmdApply();
  if (argv.includes("--restore")) return cmdRestore();

  await interactiveMain();
}

function printHelp() {
  console.log(`claude-folder-move — retarget Claude Code state when project folders move

Interactive (default):   node claude-folder-move.mjs

Non-interactive:
  --scan [--json]                          discover projects grouped by parent folder
  --plan --origin <dir> --dest <dir> [--projects a,b] [--json]
                                           show the migration plan without changing anything
  --apply --origin <dir> --dest <dir> --projects a,b [--copy-folders] --yes
                                           run the migration (requires --yes)
  --consolidate --target <dir> --sources <p1,p2,...> --yes
                                           merge scattered history from several
                                           path-eras into one target (requires --yes)
  --fix-desktop --old <path> --new <path> --yes
                                           repair the desktop app's session index
                                           alone (cwd/originCwd path rewrite)
  --restore [latest|<backup-dir>]          restore a backup (checksum-verified)

Options:
  --config-dir <dir>    Claude config dir (default ~/.claude, or $CLAUDE_CONFIG_DIR)
  --claude-json <file>  main config JSON (default: auto-detected)
  --backup-dir <dir>    where backups go (default ~/claude-folder-move-backups)
  --projects <list>     comma-separated project folder names (or full paths)
  --rename <a=b,...>    rename project folder(s) at the destination
  --copy-folders        copy source folders to destination when missing there
                        (verified copy, source never deleted; NO exclude filters
                        yet — junk like node_modules copies too)
  --yes                 skip the confirmation prompt (apply only)
`);
}

function ensureRuntime() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 18) fail(`Node 18+ required. Current: ${process.version}`);
  if (!fs.existsSync(CONFIG_DIR)) fail(`Claude config dir not found: ${CONFIG_DIR}`);
  if (!fs.existsSync(FILES.projectsRoot)) fail(`No projects dir found: ${FILES.projectsRoot}`);
}

// ---------------------------------------------------------------------------
// Path helpers — exact-or-prefix matching, and the lossy folder-name encoder
// ---------------------------------------------------------------------------

function pathMatches(value, base) {
  return typeof value === "string" && (value === base || value.startsWith(base + "/"));
}

function replacePath(value, oldPath, newPath) {
  return pathMatches(value, oldPath) ? newPath + value.slice(oldPath.length) : value;
}

function replacePathAny(value, pairs) {
  for (const pair of pairs) {
    if (pathMatches(value, pair.oldPath)) return pair.newPath + value.slice(pair.oldPath.length);
  }
  return value;
}

// Claude Code's encoding of a project path into a folder name. Verified against
// the real-CLI oracle in the test suite; if a Claude update changes this, the
// oracle test fails loudly before anything real is touched.
function encodeProjectPath(projectPath) {
  return projectPath.replace(/[^a-zA-Z0-9-]/g, "-");
}

function normalizePath(value) {
  let cleaned = String(value || "").trim();
  cleaned = cleaned.replace(/\\ /g, " ");
  while (
    cleaned.length >= 2 &&
    ((cleaned.startsWith("'") && cleaned.endsWith("'")) || (cleaned.startsWith('"') && cleaned.endsWith('"')))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  cleaned = cleaned.replace(/^~(?=$|\/)/, os.homedir());
  const resolved = path.resolve(cleaned);
  return resolved === "/" ? resolved : resolved.replace(/\/+$/, "");
}

function isUsableProjectPath(projectPath) {
  return (
    typeof projectPath === "string" &&
    projectPath.startsWith("/") &&
    projectPath !== "/" &&
    !projectPath.includes("\\") &&
    !projectPath.includes("\0")
  );
}

// ---------------------------------------------------------------------------
// Discovery
//
// The encoded folder names are lossy, so we never decode them. Each project
// dir's real path comes from the cwd fields inside its own session files;
// claude.json keys and history.jsonl provide the rest.
// ---------------------------------------------------------------------------

function discoverProjects() {
  const projects = new Map();
  const entryFor = (projectPath) => {
    const key = normalizePath(projectPath);
    if (!projects.has(key)) {
      projects.set(key, {
        path: key,
        basename: path.basename(key),
        counts: { configEntry: 0, historyLines: 0, cwdLines: 0, sessionFiles: new Set() },
        projectDirs: new Set(),
      });
    }
    return projects.get(key);
  };

  const config = safeReadJson(FILES.claudeJson) || {};
  for (const projectPath of Object.keys(config.projects || {})) {
    if (isUsableProjectPath(projectPath)) entryFor(projectPath).counts.configEntry += 1;
  }
  for (const line of safeReadText(FILES.historyJsonl).split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // tolerate corrupt lines everywhere
    }
    if (isUsableProjectPath(obj.project)) entryFor(obj.project).counts.historyLines += 1;
  }
  for (const dir of listProjectDirs()) {
    const derived = deriveDirPath(dir);
    if (!derived.path) continue;
    const entry = entryFor(derived.path);
    entry.projectDirs.add(dir);
    entry.counts.cwdLines += derived.cwdLines;
    for (const file of derived.sessionFiles) entry.counts.sessionFiles.add(file);
  }

  return [...projects.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function listProjectDirs() {
  try {
    return fs
      .readdirSync(FILES.projectsRoot, { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .map((item) => path.join(FILES.projectsRoot, item.name))
      .sort();
  } catch {
    return [];
  }
}

// Derive a project dir's real path from cwd fields in its transcripts.
// The most common usable cwd wins (subagent/worktree lines can differ).
function deriveDirPath(dir) {
  const votes = new Map();
  let cwdLines = 0;
  const sessionFiles = [];
  for (const file of walkFiles(dir, ".jsonl")) {
    let sawCwd = false;
    for (const line of safeReadText(file).split("\n")) {
      if (!line.includes('"cwd"')) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isUsableProjectPath(obj.cwd)) continue;
      votes.set(obj.cwd, (votes.get(obj.cwd) || 0) + 1);
      cwdLines += 1;
      sawCwd = true;
    }
    if (sawCwd) sessionFiles.push(file);
  }
  let best = null;
  for (const [cwd, count] of votes) {
    if (!best || count > best.count) best = { cwd, count };
  }
  // prefer the cwd whose encoding matches the dir name (sessions can visit
  // other directories; the encoding tie-break resolves that)
  for (const [cwd] of votes) {
    if (encodeProjectPath(cwd) === path.basename(dir)) {
      best = { cwd, count: votes.get(cwd) };
      break;
    }
  }
  return { path: best?.cwd || null, cwdLines, sessionFiles };
}

// Filter only DEEPLY nested projects (worktrees like <proj>/.claude/worktrees/x)
// from the parent pickers. Direct children stay visible: unlike Codex, the
// parent folder itself (e.g. ~/Projects) is often a Claude project too, and
// filtering its children would empty the origin picker.
function nonNestedProjects(projects) {
  return projects.filter(
    (project) =>
      !projects.some((other) => {
        if (other === project || !pathMatches(project.path, other.path)) return false;
        const depth = project.path.slice(other.path.length).split("/").filter(Boolean).length;
        return depth >= 2;
      }),
  );
}

function groupByParent(projects) {
  const groups = new Map();
  for (const project of projects) {
    const parent = path.dirname(project.path);
    if (!groups.has(parent)) groups.set(parent, []);
    groups.get(parent).push(project);
  }
  return [...groups.entries()]
    .map(([parent, items]) => ({ parent, projects: items }))
    .sort((a, b) => b.projects.length - a.projects.length || a.parent.localeCompare(b.parent));
}

// ---------------------------------------------------------------------------
// Per-project reference counting (prefix-aware) and plan building
// ---------------------------------------------------------------------------

function countProjectRefs(oldPath, newPath) {
  const config = safeReadJson(FILES.claudeJson) || {};
  const projectKeys = Object.keys(config.projects || {});

  const oldDirs = [];
  const sessionFiles = [];
  for (const dir of listProjectDirs()) {
    const derived = deriveDirPath(dir);
    if (!derived.path) continue;
    if (pathMatches(derived.path, oldPath)) {
      oldDirs.push({ dir, derivedPath: derived.path });
      for (const file of derived.sessionFiles) {
        const summary = summarizeSessionFile(file, oldPath);
        if (summary.actionable > 0) {
          sessionFiles.push({ file, actionable: summary.actionable, parseErrors: summary.parseErrors });
        }
      }
    }
  }

  let historyOld = 0;
  for (const line of safeReadText(FILES.historyJsonl).split("\n")) {
    if (!line.includes(oldPath)) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (pathMatches(obj.project, oldPath)) historyOld += 1;
  }

  return {
    configKeysOld: projectKeys.filter((p) => pathMatches(p, oldPath)).length,
    configKeysNew: projectKeys.filter((p) => pathMatches(p, newPath)).length,
    historyOld,
    oldDirs,
    sessionFiles,
    desktopFiles: desktopIndexFiles(oldPath),
  };
}

function summarizeSessionFile(file, oldPath) {
  let actionable = 0;
  let parseErrors = 0;
  const text = safeReadText(file);
  if (!text.includes(oldPath)) return { actionable: 0, parseErrors: 0 };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      parseErrors += 1;
      continue;
    }
    if (pathMatches(obj.cwd, oldPath)) actionable += 1;
  }
  return { actionable, parseErrors };
}

function buildProjectEntries(projects, originParent, destinationParent) {
  const byPath = new Map(projects.map((project) => [project.path, project]));
  for (const folder of listImmediateFolders(originParent)) {
    if (!byPath.has(folder)) byPath.set(folder, null); // folder with no Claude metadata
  }

  const entries = [];
  for (const [projectPath, project] of byPath) {
    if (path.dirname(projectPath) !== originParent) continue;
    entries.push(makeEntry(projects, project, projectPath, destinationParent));
  }
  // eligible projects first, then blocked-with-metadata, then bare folders
  return entries.sort(
    (a, b) =>
      Number(b.eligible) - Number(a.eligible) ||
      Number(b.hasMetadata) - Number(a.hasMetadata) ||
      a.oldPath.localeCompare(b.oldPath),
  );
}

// destName lets the user rename the project folder at the destination
function makeEntry(projects, project, oldPath, destinationParent, destName) {
  {
    const newPath = path.join(destinationParent, destName || path.basename(oldPath));
    const refs = project ? countProjectRefs(oldPath, newPath) : null;
    const hasMetadata = Boolean(
      refs && (refs.configKeysOld || refs.historyOld || refs.oldDirs.length || refs.sessionFiles.length),
    );
    const oldExists = fs.existsSync(oldPath);
    const destExists = fs.existsSync(newPath);
    const oldReal = realpathOrNull(oldPath);
    const destReal = realpathOrNull(newPath);
    const samePhysicalFolder = Boolean(oldReal && destReal && oldReal === destReal);
    // a destination project with real transcripts is a hard collision; a bare
    // claude.json entry (already re-trusted after moving) merges safely
    const destProject = projects.find((item) => item.path === newPath && item.path !== oldPath);
    const collision = Boolean(destProject && (destProject.counts.cwdLines > 0 || destProject.projectDirs.size > 0));
    // renaming the encoded dir must not overwrite an existing dir with content
    const encodedCollisions = (refs?.oldDirs || []).filter((item) => {
      const target = renamedDirTarget(item, oldPath, newPath);
      return fs.existsSync(target) && fs.readdirSync(target).length > 0 && target !== item.dir;
    });

    const blockers = [];
    if (!hasMetadata) blockers.push("no Claude metadata");
    if (collision) blockers.push("destination path already has its own Claude history");
    if (encodedCollisions.length) blockers.push("destination session folder already exists with content");
    if (samePhysicalFolder) blockers.push("source and destination are the same folder");
    if (oldPath === newPath) blockers.push("destination equals source");

    const warnings = [];
    if (destProject && !collision) warnings.push("destination already known to Claude; config entries will merge");
    let folderAction = "none";
    if (oldExists && !destExists) {
      folderAction = "copy";
    } else if (!oldExists && destExists) {
      warnings.push("source folder already gone; metadata-only migration");
    } else if (oldExists && destExists) {
      warnings.push("both folders exist; Claude will point at the destination copy");
    } else {
      warnings.push("neither folder exists on disk");
    }

    return {
      oldPath,
      newPath,
      project,
      refs,
      hasMetadata,
      oldExists,
      destExists,
      folderAction,
      blockers,
      warnings,
      eligible: blockers.length === 0,
    };
  }
}

// nested dirs (worktrees) derive paths deeper than the project root; their
// renamed dir target swaps the prefix on the *derived* path, then re-encodes
function renamedDirTarget(dirItem, oldPath, newPath) {
  const newDerived = replacePath(dirItem.derivedPath, oldPath, newPath);
  return path.join(FILES.projectsRoot, encodeProjectPath(newDerived));
}

function listImmediateFolders(parent) {
  try {
    return fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((item) => item.isDirectory() && !item.name.startsWith("."))
      .map((item) => normalizePath(path.join(parent, item.name)));
  } catch {
    return [];
  }
}

function buildPlan(originParent, destinationParent, selectedEntries, copyFolders) {
  const pairs = selectedEntries.map((entry) => ({ oldPath: entry.oldPath, newPath: entry.newPath }));
  const touched = new Set();
  if (fs.existsSync(FILES.claudeJson)) touched.add(FILES.claudeJson);
  if (fs.existsSync(FILES.historyJsonl)) touched.add(FILES.historyJsonl);
  const dirRenames = [];
  for (const entry of selectedEntries) {
    for (const item of entry.refs.sessionFiles) touched.add(item.file);
    for (const file of entry.refs.desktopFiles) touched.add(file);
    for (const dirItem of entry.refs.oldDirs) {
      const to = renamedDirTarget(dirItem, entry.oldPath, entry.newPath);
      if (to !== dirItem.dir) dirRenames.push({ from: dirItem.dir, to });
    }
  }
  const folderCopies = copyFolders
    ? selectedEntries
        .filter((entry) => entry.folderAction === "copy")
        .map((entry) => ({ from: entry.oldPath, to: entry.newPath }))
    : [];
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    configDir: CONFIG_DIR,
    claudeJson: FILES.claudeJson,
    originParent,
    destinationParent,
    copyFolders: Boolean(copyFolders),
    projects: selectedEntries.map((entry) => ({
      oldPath: entry.oldPath,
      newPath: entry.newPath,
      folderAction: copyFolders && entry.folderAction === "copy" ? "copy" : "metadata-only",
      warnings: entry.warnings,
      expected: {
        configKeysOld: entry.refs.configKeysOld,
        historyOld: entry.refs.historyOld,
        projectDirs: entry.refs.oldDirs.length,
        sessionFiles: entry.refs.sessionFiles.length,
      },
    })),
    pairs,
    dirRenames,
    folderCopies,
    touchedFiles: [...touched].sort(),
  };
}

// ---------------------------------------------------------------------------
// Apply pipeline: preflight → folder copies → batch backup → rename dirs →
// patch files → postflight. Any error after the backup: automatic restore.
// ---------------------------------------------------------------------------

function applyPlan(plan) {
  preflight(plan);

  for (const copy of plan.folderCopies) copyFolder(copy.from, copy.to);

  const backup = createBackup(plan);
  console.log(`\nBackup written: ${backup.dir}`);

  try {
    renameProjectDirs(plan.dirRenames);
    injectFail("after-renames");
    patchClaudeJson(plan.pairs);
    injectFail("after-config");
    patchHistoryJsonl(plan.pairs);
    injectFail("after-history");
    patchSessionFiles(plan);
    injectFail("after-sessions");
    patchDesktopIndex(plan.touchedFiles.filter((f) => f.startsWith(DESKTOP_SESSIONS_ROOT + "/")), plan.pairs);
    injectFail("after-desktop");
    postflight(plan);
  } catch (error) {
    console.error(`\nAPPLY FAILED: ${error?.message || error}`);
    console.error("Starting automatic restore from backup...");
    restoreBackup(backup.dir);
    console.error("Automatic restore complete. Claude state is back to its pre-migration bytes.");
    console.error(`Backup kept at: ${backup.dir}`);
    throw new Error("Migration failed and was rolled back. No changes remain applied.");
  }

  console.log("\nMigration complete.");
  console.log(`Backup: ${backup.dir}`);
  console.log(`Standalone rollback: node ${JSON.stringify(path.join(backup.dir, "rollback.mjs"))}`);
  if (plan.folderCopies.length) {
    console.log("\nCopied folders (sources left untouched — trash them yourself once you're happy):");
    for (const copy of plan.folderCopies) console.log(`  ${copy.from}  ->  ${copy.to}`);
  }
}

function preflight(plan) {
  ensureClaudeClosed();
  for (const project of plan.projects) {
    const refs = countProjectRefs(project.oldPath, project.newPath);
    if (refs.oldDirs.length < project.expected.projectDirs || refs.configKeysOld < project.expected.configKeysOld) {
      fail(`Claude state changed since planning for ${project.oldPath}. Re-run the plan.`);
    }
  }
  for (const file of plan.touchedFiles) {
    if (!fs.existsSync(file)) fail(`Planned file is missing: ${file}`);
  }
  for (const rename of plan.dirRenames) {
    if (!fs.existsSync(rename.from)) fail(`Planned session folder is missing: ${rename.from}`);
    if (fs.existsSync(rename.to) && fs.readdirSync(rename.to).length > 0) {
      fail(`Destination session folder appeared since planning: ${rename.to}`);
    }
  }
  for (const copy of plan.folderCopies) {
    if (!fs.existsSync(copy.from)) fail(`Folder to copy is missing: ${copy.from}`);
    if (fs.existsSync(copy.to)) fail(`Destination folder appeared since planning: ${copy.to}`);
  }
}

function postflight(plan) {
  injectFail("postflight");
  for (const project of plan.projects) {
    const refs = countProjectRefs(project.oldPath, project.newPath);
    const leftovers = [];
    if (refs.configKeysOld) leftovers.push(`claude.json keys=${refs.configKeysOld}`);
    if (refs.historyOld) leftovers.push(`history lines=${refs.historyOld}`);
    if (refs.oldDirs.length) leftovers.push(`session folders=${refs.oldDirs.length}`);
    if (refs.sessionFiles.length) leftovers.push(`session files=${refs.sessionFiles.length}`);
    if (refs.desktopFiles.length) leftovers.push(`desktop index files=${refs.desktopFiles.length}`);
    if (leftovers.length) {
      throw new Error(`Postflight found old references for ${project.oldPath}: ${leftovers.join(", ")}`);
    }
    const newRefs = countProjectRefs(project.newPath, project.newPath);
    if (project.expected.configKeysOld > 0 && newRefs.configKeysOld === 0) {
      throw new Error(`Postflight: no claude.json entry exists for ${project.newPath}`);
    }
    if (newRefs.oldDirs.length < project.expected.projectDirs) {
      throw new Error(
        `Postflight: session folders for ${project.newPath} (${newRefs.oldDirs.length}) below expected (${project.expected.projectDirs})`,
      );
    }
  }
  const config = safeReadJson(FILES.claudeJson);
  if (!config || typeof config !== "object") throw new Error("Postflight: claude.json is no longer valid JSON");
}

function injectFail(point) {
  if (process.env.CLAUDE_FOLDER_MOVE_INJECT_FAIL === point) throw new Error(`Injected test failure at ${point}`);
}

// ---------------------------------------------------------------------------
// Patchers
// ---------------------------------------------------------------------------

function renameProjectDirs(renames) {
  for (const rename of renames) {
    // an empty leftover dir at the target (created by a stray `claude` launch)
    // is removed so the rename can land
    if (fs.existsSync(rename.to)) {
      if (fs.readdirSync(rename.to).length > 0) throw new Error(`Refusing to overwrite ${rename.to}`);
      fs.rmdirSync(rename.to);
    }
    fs.renameSync(rename.from, rename.to);
  }
}

function patchClaudeJson(pairs) {
  const config = safeReadJson(FILES.claudeJson);
  if (!config || typeof config !== "object") throw new Error(`Cannot parse ${FILES.claudeJson}`);
  const projects = config.projects || {};
  const keys = Object.keys(projects);
  for (const key of keys) {
    const newKey = replacePathAny(key, pairs);
    if (newKey === key) continue;
    if (projects[newKey] && projects[newKey] !== projects[key]) {
      // destination entry exists (bare re-trust) — merge: destination values
      // win, arrays union-deduped, so neither side's config is lost
      projects[newKey] = mergeProjectEntries(projects[key], projects[newKey]);
    } else {
      projects[newKey] = projects[key];
    }
    delete projects[key];
  }
  config.projects = projects;
  fs.writeFileSync(FILES.claudeJson, JSON.stringify(config, null, 2));
}

function mergeProjectEntries(oldEntry, destEntry) {
  const merged = { ...oldEntry, ...destEntry };
  for (const key of Object.keys(merged)) {
    if (Array.isArray(oldEntry?.[key]) && Array.isArray(destEntry?.[key])) {
      merged[key] = dedupe([...oldEntry[key], ...destEntry[key]]);
    }
  }
  return merged;
}

function patchHistoryJsonl(pairs) {
  if (!fs.existsSync(FILES.historyJsonl)) return;
  const lines = safeReadText(FILES.historyJsonl).split("\n");
  const patched = lines.map((line) => {
    if (!line.trim()) return line;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return line; // corrupt line: leave byte-identical
    }
    if (typeof obj.project !== "string") return line;
    const replaced = replacePathAny(obj.project, pairs);
    if (replaced === obj.project) return line;
    obj.project = replaced;
    return JSON.stringify(obj);
  });
  fs.writeFileSync(FILES.historyJsonl, patched.join("\n"));
}

function patchSessionFiles(plan) {
  // session files were backed up at their pre-rename locations; by the time we
  // patch, their dirs may have been renamed — resolve each file's live path
  const liveSessionPath = (file) => {
    if (fs.existsSync(file)) return file;
    for (const rename of plan.dirRenames) {
      if (pathMatches(file, rename.from)) {
        const moved = rename.to + file.slice(rename.from.length);
        if (fs.existsSync(moved)) return moved;
      }
    }
    throw new Error(`Session file disappeared during apply: ${file}`);
  };
  const files = new Set();
  for (const file of plan.touchedFiles) {
    if (file.endsWith(".jsonl") && file.startsWith(FILES.projectsRoot + "/")) files.add(file);
  }
  for (const file of files) {
    const live = liveSessionPath(file);
    const lines = safeReadText(live).split("\n");
    const patched = lines.map((line) => {
      if (!line.trim() || !line.includes('"cwd"')) return line;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        return line; // corrupt line: leave byte-identical
      }
      if (typeof obj.cwd !== "string") return line;
      const replaced = replacePathAny(obj.cwd, plan.pairs);
      if (replaced === obj.cwd) return line;
      obj.cwd = replaced;
      return JSON.stringify(obj);
    });
    fs.writeFileSync(live, patched.join("\n"));
  }
}

// ---------------------------------------------------------------------------
// Consolidate — merge one logical project's history from several path-eras
// into a single target. Session files are copied into the target's encoded
// dir(s) with cwd rewritten; claude.json entries and history lines fold into
// the target; source encoded dirs are removed only after a verified copy.
// ---------------------------------------------------------------------------

// The "logical project" a path belongs to: a worktree session
// (<proj>/.claude/worktrees/<name>) is really history OF <proj>, so it should
// group and consolidate under <proj>, not under the random worktree name.
function logicalProjectPath(projectPath) {
  const marker = "/.claude/worktrees/";
  const index = projectPath.indexOf(marker);
  return index === -1 ? projectPath : projectPath.slice(0, index);
}

function groupByBasename(projects) {
  const groups = new Map();
  for (const project of projects) {
    const name = path.basename(logicalProjectPath(project.path));
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(project);
  }
  return [...groups.entries()]
    .map(([name, items]) => ({ name, projects: items.sort((a, b) => a.path.localeCompare(b.path)) }))
    .sort((a, b) => b.projects.length - a.projects.length || a.name.localeCompare(b.name));
}

function buildConsolidatePlan(sourcePaths, targetPath) {
  const pairs = sourcePaths.map((sourcePath) => ({ oldPath: sourcePath, newPath: targetPath }));
  const fileCopies = [];
  const removeDirsAfter = new Set();
  const createdDirs = new Set();
  const touched = new Set();
  const uuidCollisions = [];
  if (fs.existsSync(FILES.claudeJson)) touched.add(FILES.claudeJson);
  if (fs.existsSync(FILES.historyJsonl)) touched.add(FILES.historyJsonl);

  const sources = [];
  for (const sourcePath of sourcePaths) {
    const refs = countProjectRefs(sourcePath, targetPath);
    for (const file of refs.desktopFiles) touched.add(file);
    let fileCount = 0;
    for (const { dir, derivedPath } of refs.oldDirs) {
      const targetDerived = replacePath(derivedPath, sourcePath, targetPath);
      const targetDir = path.join(FILES.projectsRoot, encodeProjectPath(targetDerived));
      if (!fs.existsSync(targetDir)) createdDirs.add(targetDir);
      for (const file of walkFiles(dir, ".jsonl")) {
        const to = path.join(targetDir, path.basename(file));
        if (fs.existsSync(to)) {
          uuidCollisions.push({ from: file, to });
          continue;
        }
        fileCopies.push({ from: file, to, targetDir });
        touched.add(file); // backed up so phase-2 removal is reversible
        fileCount += 1;
      }
      removeDirsAfter.add(dir);
    }
    // also back up any loose session files under this source (non-.jsonl kept as-is)
    sources.push({
      sourcePath,
      configKeys: refs.configKeysOld,
      historyLines: refs.historyOld,
      dirs: refs.oldDirs.length,
      files: fileCount,
    });
  }

  return {
    version: 1,
    mode: "consolidate",
    createdAt: new Date().toISOString(),
    configDir: CONFIG_DIR,
    claudeJson: FILES.claudeJson,
    targetPath,
    sources,
    pairs,
    fileCopies,
    createdFiles: fileCopies.map((c) => c.to),
    createdDirs: [...createdDirs],
    removeDirsAfter: [...removeDirsAfter],
    uuidCollisions,
    touchedFiles: [...touched].sort(),
  };
}

function applyConsolidate(plan) {
  if (plan.uuidCollisions.length) {
    fail(
      `Session-id collisions at the target (refusing to overwrite):\n  ` +
        plan.uuidCollisions.map((c) => c.to).join("\n  "),
    );
  }
  consolidatePreflight(plan);

  const backup = createBackup(plan);
  console.log(`\nBackup written: ${backup.dir}`);

  try {
    for (const dir of plan.createdDirs) fs.mkdirSync(dir, { recursive: true });
    injectFail("after-mkdir");
    for (const copy of plan.fileCopies) {
      fs.copyFileSync(copy.from, copy.to);
      rewriteSessionCwd(copy.to, plan.pairs);
    }
    injectFail("after-copies");
    patchClaudeJson(plan.pairs);
    injectFail("after-config");
    patchHistoryJsonl(plan.pairs);
    injectFail("after-history");
    patchDesktopIndex(plan.touchedFiles.filter((f) => f.startsWith(DESKTOP_SESSIONS_ROOT + "/")), plan.pairs);
    injectFail("after-desktop");
    consolidatePostflight(plan);
  } catch (error) {
    console.error(`\nCONSOLIDATE FAILED: ${error?.message || error}`);
    console.error("Starting automatic restore from backup...");
    restoreBackup(backup.dir);
    console.error("Automatic restore complete. Claude state is back to its pre-merge bytes.");
    console.error(`Backup kept at: ${backup.dir}`);
    throw new Error("Consolidation failed and was rolled back. No changes remain applied.");
  }

  // phase 2: remove the now-copied source dirs (fully captured in the backup)
  for (const dir of plan.removeDirsAfter) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log("\nConsolidation complete.");
  console.log(`  ${plan.fileCopies.length} session file(s) merged into ${plan.targetPath}`);
  console.log(`Backup: ${backup.dir}`);
  console.log(`Standalone rollback: node ${JSON.stringify(path.join(backup.dir, "rollback.mjs"))}`);
}

function rewriteSessionCwd(file, pairs) {
  const lines = safeReadText(file).split("\n");
  const patched = lines.map((line) => {
    if (!line.trim() || !line.includes('"cwd"')) return line;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return line;
    }
    if (typeof obj.cwd !== "string") return line;
    const replaced = replacePathAny(obj.cwd, pairs);
    if (replaced === obj.cwd) return line;
    obj.cwd = replaced;
    return JSON.stringify(obj);
  });
  fs.writeFileSync(file, patched.join("\n"));
}

function consolidatePreflight(plan) {
  ensureClaudeClosed();
  for (const copy of plan.fileCopies) {
    if (!fs.existsSync(copy.from)) fail(`Source session file vanished since planning: ${copy.from}`);
    if (fs.existsSync(copy.to)) fail(`Target session file appeared since planning: ${copy.to}`);
  }
  for (const file of plan.touchedFiles) {
    if (!fs.existsSync(file)) fail(`Planned file is missing: ${file}`);
  }
}

function consolidatePostflight(plan) {
  injectFail("postflight");
  for (const source of plan.sources) {
    const refs = countProjectRefs(source.sourcePath, plan.targetPath);
    const leftovers = [];
    if (refs.configKeysOld) leftovers.push(`claude.json keys=${refs.configKeysOld}`);
    if (refs.historyOld) leftovers.push(`history lines=${refs.historyOld}`);
    if (refs.desktopFiles.length) leftovers.push(`desktop index files=${refs.desktopFiles.length}`);
    if (leftovers.length) {
      throw new Error(`Postflight: source ${source.sourcePath} still referenced: ${leftovers.join(", ")}`);
    }
  }
  for (const copy of plan.fileCopies) {
    if (!fs.existsSync(copy.to)) throw new Error(`Postflight: merged file missing: ${copy.to}`);
  }
  const config = safeReadJson(FILES.claudeJson);
  if (!config || typeof config !== "object") throw new Error("Postflight: claude.json is no longer valid JSON");
  if (plan.sources.some((s) => s.configKeys > 0) && !(config.projects || {})[plan.targetPath]) {
    throw new Error(`Postflight: no claude.json entry for target ${plan.targetPath}`);
  }
}

// ---------------------------------------------------------------------------
// Folder copy — copy + verify, never delete the source
// ---------------------------------------------------------------------------

function copyFolder(from, to) {
  console.log(`Copying folder: ${from} -> ${to}`);
  const existedBefore = fs.existsSync(to);
  try {
    fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    verifyFolderCopy(from, to);
  } catch (error) {
    if (!existedBefore && fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true });
    fail(`Folder copy failed (source untouched, partial copy removed): ${error?.message || error}`);
  }
}

function verifyFolderCopy(from, to) {
  const sourceItems = walkTree(from);
  for (const item of sourceItems) {
    const target = path.join(to, item.rel);
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch {
      throw new Error(`copy verification: missing ${target}`);
    }
    if (item.type === "dir" && !stat.isDirectory()) throw new Error(`copy verification: not a directory: ${target}`);
    if (item.type === "file" && (!stat.isFile() || stat.size !== item.size)) {
      throw new Error(`copy verification: size mismatch: ${target}`);
    }
    if (item.type === "link" && fs.readlinkSync(target) !== item.linkTarget) {
      throw new Error(`copy verification: symlink mismatch: ${target}`);
    }
  }
  console.log(`  verified ${sourceItems.filter((item) => item.type === "file").length} files`);
}

function walkTree(root, base = root) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    const rel = path.relative(base, full);
    if (entry.isSymbolicLink()) {
      out.push({ rel, type: "link", linkTarget: fs.readlinkSync(full) });
    } else if (entry.isDirectory()) {
      out.push({ rel, type: "dir" });
      out.push(...walkTree(full, base));
    } else if (entry.isFile()) {
      out.push({ rel, type: "file", size: fs.lstatSync(full).size });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Backup & restore — files by sha256 manifest, dir renames recorded and reversed
// ---------------------------------------------------------------------------

function createBackup(plan) {
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(BACKUP_ROOT, `migration-${stamp}`);
  fs.mkdirSync(path.join(dir, "files"), { recursive: true });

  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    configDir: CONFIG_DIR,
    plan,
    files: [],
    dirRenames: plan.dirRenames || [],
    // consolidate-only: files this run will newly create (rollback deletes them)
    // and dirs it will newly create (rollback removes them, deepest-first).
    // Source files that get removed are captured in `files` (sha256) so restore
    // recreates them at their original paths.
    createdFiles: plan.createdFiles || [],
    createdDirs: plan.createdDirs || [],
  };

  for (const file of plan.touchedFiles) {
    if (!fs.existsSync(file)) continue;
    const backupPath = path.join(dir, "files", file.replace(/^\//, ""));
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(file, backupPath);
    const sha = fileSha256(backupPath);
    if (sha !== fileSha256(file)) fail(`Backup copy mismatch for ${file}`);
    manifest.files.push({ original: file, backup: backupPath, sha256: sha, bytes: fs.statSync(backupPath).size });
  }

  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeRollbackScript(dir, manifest);
  return { dir, manifest };
}

function restoreBackup(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const backupPathFor = (item) => path.join(dir, "files", item.original.replace(/^\//, ""));
  for (const item of manifest.files) {
    if (fileSha256(backupPathFor(item)) !== item.sha256) {
      throw new Error(`CRITICAL: backup file corrupted, aborting restore: ${backupPathFor(item)}`);
    }
  }
  // remove files this run created (merge copies into target dirs) so the target
  // returns to its pre-merge contents; pre-existing target files are untouched
  for (const created of manifest.createdFiles || []) {
    if (fs.existsSync(created)) fs.rmSync(created);
  }
  // remove created dirs deepest-first (now empty)
  for (const created of [...(manifest.createdDirs || [])].sort((a, b) => b.length - a.length)) {
    try {
      if (fs.existsSync(created) && fs.readdirSync(created).length === 0) fs.rmdirSync(created);
    } catch {
      /* not empty (unexpected content) — leave it */
    }
  }
  // reverse dir renames so file restore paths are valid again
  for (const rename of [...(manifest.dirRenames || [])].reverse()) {
    if (fs.existsSync(rename.to) && !fs.existsSync(rename.from)) {
      fs.renameSync(rename.to, rename.from);
    }
  }
  // restore modified + removed-source files (recreates removed source dirs)
  for (const item of manifest.files) {
    fs.mkdirSync(path.dirname(item.original), { recursive: true });
    fs.copyFileSync(backupPathFor(item), item.original);
  }
  const failures = manifest.files.filter((item) => fileSha256(item.original) !== item.sha256);
  if (failures.length) {
    throw new Error(`CRITICAL: restore verification failed for: ${failures.map((item) => item.original).join(", ")}`);
  }
  console.log(
    `Restored ${manifest.files.length} file(s), ${manifest.dirRenames?.length || 0} rename(s), removed ${(manifest.createdFiles || []).length} merge copy/ies — byte-identical to backup.`,
  );
}

function writeRollbackScript(dir, manifest) {
  const script = `#!/usr/bin/env node
// Standalone rollback for the claude-folder-move backup in this directory.
// Reverses session-folder renames, verifies backup checksums, restores every
// file, then re-verifies.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
const backupPathFor = (item) => path.join(dir, "files", item.original.replace(/^\\//, ""));
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
for (const item of manifest.files) {
  if (sha256(backupPathFor(item)) !== item.sha256) {
    console.error("CRITICAL: backup file corrupted: " + backupPathFor(item));
    process.exit(1);
  }
}
for (const created of manifest.createdFiles || []) {
  if (fs.existsSync(created)) fs.rmSync(created);
}
for (const created of [...(manifest.createdDirs || [])].sort((a, b) => b.length - a.length)) {
  try { if (fs.existsSync(created) && fs.readdirSync(created).length === 0) fs.rmdirSync(created); } catch {}
}
for (const rename of [...(manifest.dirRenames || [])].reverse()) {
  if (fs.existsSync(rename.to) && !fs.existsSync(rename.from)) fs.renameSync(rename.to, rename.from);
}
for (const item of manifest.files) {
  fs.mkdirSync(path.dirname(item.original), { recursive: true });
  fs.copyFileSync(backupPathFor(item), item.original);
}
const bad = manifest.files.filter((item) => sha256(item.original) !== item.sha256);
if (bad.length) {
  console.error("CRITICAL: restore verification failed: " + bad.map((item) => item.original).join(", "));
  process.exit(1);
}
console.log("Restored " + manifest.files.length + " file(s), byte-identical to backup.");
`;
  fs.writeFileSync(path.join(dir, "rollback.mjs"), script, { mode: 0o755 });
}

function listBackups() {
  if (!fs.existsSync(BACKUP_ROOT)) return [];
  return fs
    .readdirSync(BACKUP_ROOT, { withFileTypes: true })
    .filter((item) => item.isDirectory() && item.name.startsWith("migration-"))
    .map((item) => ({ name: item.name, dir: path.join(BACKUP_ROOT, item.name) }))
    .filter((item) => fs.existsSync(path.join(item.dir, "manifest.json")))
    .sort((a, b) => b.name.localeCompare(a.name));
}

// ---------------------------------------------------------------------------
// Running-instance guard
// ---------------------------------------------------------------------------

function ensureClaudeClosed() {
  if (process.env.CLAUDE_FOLDER_MOVE_SKIP_RUNNING_CHECK === "1") return;
  // only guard the real config dir; fixtures under a custom dir are inert
  if (CONFIG_DIR !== DEFAULT_CONFIG_DIR) return;
  const live = [];
  try {
    for (const file of fs.readdirSync(FILES.liveSessionsDir)) {
      if (!file.endsWith(".json")) continue;
      const info = safeReadJson(path.join(FILES.liveSessionsDir, file));
      if (!info?.pid) continue;
      try {
        process.kill(info.pid, 0); // liveness probe, sends no signal
        live.push(`${info.name || info.sessionId || file} (pid ${info.pid}, ${info.cwd || "?"})`);
      } catch {
        /* stale registry entry */
      }
    }
  } catch {
    /* no sessions dir */
  }
  try {
    const ps = execFileSync("ps", ["-axo", "pid=,comm="], { encoding: "utf8" });
    if (ps.split("\n").some((line) => line.includes("/Applications/Claude.app/"))) {
      live.push("Claude desktop app");
    }
  } catch {
    /* ps unavailable */
  }
  if (live.length) {
    fail(
      `Claude Code is running — close it before applying (it holds state in memory and would overwrite the migration):\n  ` +
        live.join("\n  "),
    );
  }
}

// ---------------------------------------------------------------------------
// Non-interactive commands
// ---------------------------------------------------------------------------

function cmdScan() {
  const projects = discoverProjects();
  if (argv.includes("--json")) {
    console.log(JSON.stringify(projects.map(projectSummary), null, 2));
    return;
  }
  console.log(`Claude config dir: ${CONFIG_DIR}`);
  console.log(`claude.json:       ${FILES.claudeJson}`);
  const groups = groupByParent(nonNestedProjects(projects));
  for (const group of groups) {
    console.log(`\n${group.parent}  (${group.projects.length} project${group.projects.length === 1 ? "" : "s"})`);
    for (const project of group.projects) {
      const c = project.counts;
      console.log(
        `  ${project.basename}  dirs=${project.projectDirs.size} sessions=${c.sessionFiles.size} cwdLines=${c.cwdLines} config=${c.configEntry} history=${c.historyLines}`,
      );
    }
  }
}

function projectSummary(project) {
  return {
    path: project.path,
    projectDirs: [...project.projectDirs],
    sessionFiles: project.counts.sessionFiles.size,
    cwdLines: project.counts.cwdLines,
    configEntry: project.counts.configEntry,
    historyLines: project.counts.historyLines,
  };
}

function resolveNonInteractiveSelection() {
  const origin = getArgValue("--origin");
  const dest = getArgValue("--dest");
  if (!origin || !dest) fail("--origin and --dest are required");
  const originParent = normalizePath(origin);
  const destinationParent = normalizePath(dest);
  if (originParent === destinationParent) fail("Origin and destination must differ");
  const projects = discoverProjects();
  let entries = buildProjectEntries(projects, originParent, destinationParent);
  // --rename "oldName=newName,other=renamed" applies destination folder renames
  const renameArg = getArgValue("--rename");
  if (renameArg) {
    const renames = new Map(
      renameArg.split(",").map((pair) => pair.split("=").map((s) => s.trim())).filter((p) => p.length === 2 && p[0] && p[1]),
    );
    entries = entries.map((entry) => {
      const newName = renames.get(path.basename(entry.oldPath));
      if (!newName) return entry;
      return makeEntry(projects, entry.project, entry.oldPath, destinationParent, newName);
    });
  }
  const wanted = getArgValue("--projects");
  let selected;
  if (wanted) {
    const names = wanted.split(",").map((item) => item.trim()).filter(Boolean);
    selected = [];
    for (const name of names) {
      const target = name.startsWith("/") ? normalizePath(name) : path.join(originParent, name);
      const entry = entries.find((item) => item.oldPath === target);
      if (!entry) fail(`Project not found under origin: ${name}`);
      if (!entry.eligible) fail(`Project not eligible: ${name} (${entry.blockers.join("; ")})`);
      selected.push(entry);
    }
  } else {
    selected = entries.filter((entry) => entry.eligible);
  }
  return { originParent, destinationParent, entries, selected };
}

function cmdPlan() {
  const { originParent, destinationParent, entries, selected } = resolveNonInteractiveSelection();
  const plan = buildPlan(originParent, destinationParent, selected, argv.includes("--copy-folders"));
  if (argv.includes("--json")) return console.log(JSON.stringify(plan, null, 2));
  printPlanSummary(plan, entries.filter((entry) => !entry.eligible));
}

function cmdApply() {
  const { originParent, destinationParent, selected } = resolveNonInteractiveSelection();
  if (!selected.length) fail("Nothing to migrate.");
  if (!argv.includes("--yes")) fail("--apply requires --yes (or run interactively without flags)");
  const plan = buildPlan(originParent, destinationParent, selected, argv.includes("--copy-folders"));
  if (!fs.existsSync(destinationParent)) fs.mkdirSync(destinationParent, { recursive: true });
  applyPlan(plan);
}

function cmdConsolidate() {
  const target = getArgValue("--target");
  const sourcesArg = getArgValue("--sources");
  if (!target || !sourcesArg) fail("--consolidate requires --target <dir> and --sources <p1,p2,...>");
  const targetPath = normalizePath(target);
  const projects = discoverProjects();
  const byPath = new Map(projects.map((p) => [p.path, p]));
  const sources = [];
  for (const raw of sourcesArg.split(",").map((s) => s.trim()).filter(Boolean)) {
    const sourcePath = normalizePath(raw);
    if (sourcePath === targetPath) fail(`A source equals the target: ${sourcePath}`);
    // accept an exact discovered project, or a parent path that has discovered
    // descendants (e.g. a project folder whose only history is a worktree)
    const hasDescendants = projects.some((p) => pathMatches(p.path, sourcePath));
    if (!byPath.has(sourcePath) && !hasDescendants) fail(`Source not found in Claude state: ${sourcePath}`);
    sources.push(sourcePath);
  }
  if (!sources.length) fail("No sources given.");
  const plan = buildConsolidatePlan(sources, targetPath);
  if (argv.includes("--plan") || (!argv.includes("--yes") && argv.includes("--dry-run"))) {
    if (argv.includes("--json")) return console.log(JSON.stringify(plan, null, 2));
    return printConsolidatePlan(plan);
  }
  if (!argv.includes("--yes")) {
    printConsolidatePlan(plan);
    fail("--consolidate requires --yes to apply (or run interactively).");
  }
  applyConsolidate(plan);
}

// Repairs the desktop app's session index alone: rewrites cwd/originCwd for a
// path pair. For fixing entries left stale by pre-desktop-index versions of
// this tool, or cleaning dead-era ghosts (old machines) out of the app UI.
function cmdFixDesktop() {
  const oldPath = getArgValue("--old");
  const newPath = getArgValue("--new");
  if (!oldPath || !newPath) fail("--fix-desktop requires --old <path> and --new <path>");
  const pairs = [{ oldPath: normalizePath(oldPath), newPath: normalizePath(newPath) }];
  const files = desktopIndexFiles(pairs[0].oldPath);
  if (!files.length) return console.log("No desktop index entries reference that path. Nothing to do.");
  console.log(`Desktop index entries to rewrite: ${files.length}`);
  for (const file of files) console.log(`  ${file}`);
  if (!argv.includes("--yes")) fail("--fix-desktop requires --yes to apply");
  ensureClaudeClosed();
  const plan = {
    version: 1,
    mode: "fix-desktop",
    createdAt: new Date().toISOString(),
    configDir: CONFIG_DIR,
    pairs,
    touchedFiles: files,
  };
  const backup = createBackup(plan);
  console.log(`Backup written: ${backup.dir}`);
  try {
    patchDesktopIndex(files, pairs);
    if (desktopIndexFiles(pairs[0].oldPath).length) throw new Error("Postflight: old path still present in desktop index");
  } catch (error) {
    console.error(`FIX FAILED: ${error?.message || error} — restoring...`);
    restoreBackup(backup.dir);
    throw new Error("Fix failed and was rolled back.");
  }
  console.log("Desktop index repaired.");
}

function cmdRestore() {
  const which = argv[argv.indexOf("--restore") + 1];
  const backups = listBackups();
  if (!backups.length) fail(`No backups found under ${BACKUP_ROOT}`);
  let dir;
  if (!which || which === "latest" || which.startsWith("--")) dir = backups[0].dir;
  else dir = path.resolve(which);
  if (!fs.existsSync(path.join(dir, "manifest.json"))) fail(`Not a backup dir: ${dir}`);
  ensureClaudeClosed();
  restoreBackup(dir);
}

// ---------------------------------------------------------------------------
// Interactive flow (prompter and menus proven in codex-folder-move)
// ---------------------------------------------------------------------------

function makePrompter() {
  const rl = createInterface({ input, output });
  const queue = [];
  const waiters = [];
  let closed = false;
  rl.on("line", (line) => {
    if (waiters.length) waiters.shift()({ line });
    else queue.push(line);
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length) waiters.shift()({ eof: true });
  });
  return {
    async question(promptText) {
      if (queue.length) {
        output.write(promptText);
        return queue.shift();
      }
      if (closed) throw new Error("Input closed before the prompt was answered. Nothing was applied.");
      rl.setPrompt(promptText);
      rl.prompt();
      const result = await new Promise((resolve) => waiters.push(resolve));
      if (result.eof) throw new Error("Input closed before the prompt was answered. Nothing was applied.");
      return result.line;
    },
    close() {
      rl.close();
    },
  };
}

async function interactiveMain() {
  const rl = makePrompter();
  try {
    console.log(`claude-folder-move — Claude config dir: ${CONFIG_DIR}`);
    while (true) {
      console.log("\nMain menu");
      console.log("  1. Migrate projects (retarget a folder move)");
      console.log("  2. Consolidate a project's scattered history");
      console.log("  3. Scan Claude state");
      console.log("  4. Restore from backup");
      console.log("  5. Quit");
      const answer = (await rl.question("Choose 1-5: ")).trim();
      if (answer === "1") await migrateFlow(rl);
      else if (answer === "2") await consolidateFlow(rl);
      else if (answer === "3") cmdScan();
      else if (answer === "4") await restoreFlow(rl);
      else if (answer === "5" || answer.toLowerCase() === "q") return console.log("No action taken. Bye.");
      else console.log("Invalid choice.");
    }
  } finally {
    rl.close();
  }
}

async function migrateFlow(rl) {
  console.log("\nScanning Claude state...");
  const projects = discoverProjects();
  if (!projects.length) return console.log("No Claude projects found.");
  const groups = groupByParent(nonNestedProjects(projects));

  const originParent = await pickParent(rl, groups, "origin", null);
  if (!originParent) return;
  const destinationParent = await pickParent(rl, groups, "destination", originParent);
  if (!destinationParent) return;
  if (!fs.existsSync(destinationParent)) {
    const create = (await rl.question(`Destination parent does not exist. Create ${destinationParent}? (y/n): `)).trim().toLowerCase();
    if (create !== "y") return console.log("Cancelled.");
    fs.mkdirSync(destinationParent, { recursive: true });
  }

  console.log("\nAnalyzing projects (counting references in every store)...");
  const entries = buildProjectEntries(projects, originParent, destinationParent);
  if (!entries.length) return console.log(`Nothing found under ${originParent}.`);

  const selected = await checklist(rl, entries, destinationParent);
  if (!selected || !selected.length) return console.log("Nothing selected. Cancelled.");

  let copyFolders = false;
  const needCopy = selected.filter((entry) => entry.folderAction === "copy");
  if (needCopy.length) {
    console.log(`\n${needCopy.length} selected project(s) have no folder at the destination yet:`);
    for (const entry of needCopy) console.log(`  ${entry.oldPath}`);
    const answer = (await rl.question("Copy these folders to the destination? Sources are never deleted. (y/n): "))
      .trim()
      .toLowerCase();
    copyFolders = answer === "y";
    if (!copyFolders) console.log("OK — metadata only; Claude will point at folders that don't exist yet.");
  }

  const plan = buildPlan(originParent, destinationParent, selected, copyFolders);
  printPlanSummary(plan, []);
  console.log(`\nA full backup of all ${plan.touchedFiles.length} touched files is taken first.`);
  console.log("Any error triggers an automatic checksum-verified restore.");
  const confirm = (await rl.question('Type "migrate" to proceed, anything else to cancel: ')).trim();
  if (confirm !== "migrate") return console.log("Cancelled. Nothing was changed.");

  applyPlan(plan);
}

async function consolidateFlow(rl) {
  console.log("\nScanning Claude state...");
  const projects = discoverProjects();
  const groups = groupByBasename(projects).filter((group) => group.projects.length > 1);
  if (!groups.length) return console.log("No projects with history split across multiple paths were found.");

  console.log("\nProjects that exist under more than one path (candidates to consolidate):");
  groups.forEach((group, index) => {
    console.log(`  ${index + 1}. ${group.name}  (${group.projects.length} locations)`);
  });
  const pick = (await rl.question("Consolidate which? (number, q to cancel): ")).trim();
  if (pick.toLowerCase() === "q") return;
  const groupIndex = Number(pick);
  if (!Number.isInteger(groupIndex) || groupIndex < 1 || groupIndex > groups.length) return console.log("Invalid choice.");
  const group = groups[groupIndex - 1];

  console.log(`\n"${group.name}" history exists at:`);
  group.projects.forEach((project, index) => {
    const c = project.counts;
    const isWorktree = logicalProjectPath(project.path) !== project.path;
    const tag = isWorktree ? "  [worktree session — will flatten into the target]" : "";
    console.log(`  ${index + 1}. ${project.path}${tag}`);
    console.log(`        dirs=${project.projectDirs.size} sessions=${c.sessionFiles.size} cwdLines=${c.cwdLines} config=${c.configEntry} history=${c.historyLines}`);
  });
  const targetAnswer = (await rl.question("\nWhich is the TARGET (everything merges INTO it)? (number, or c for custom path, q to cancel): ")).trim();
  if (targetAnswer.toLowerCase() === "q") return;
  let targetPath;
  if (targetAnswer.toLowerCase() === "c") {
    const custom = (await rl.question("Target path: ")).trim();
    if (!custom) return console.log("Cancelled.");
    targetPath = normalizePath(custom);
  } else {
    const targetIndex = Number(targetAnswer);
    if (!Number.isInteger(targetIndex) || targetIndex < 1 || targetIndex > group.projects.length) return console.log("Invalid choice.");
    targetPath = group.projects[targetIndex - 1].path;
  }

  const sources = group.projects.map((project) => project.path).filter((p) => p !== targetPath);
  if (!sources.length) return console.log("Nothing to merge (target is the only location).");

  const plan = buildConsolidatePlan(sources, targetPath);
  printConsolidatePlan(plan);
  if (plan.uuidCollisions.length) {
    return console.log("\nCannot proceed: session-id collisions listed above. Nothing was changed.");
  }
  console.log(`\nA full backup of all ${plan.touchedFiles.length} touched files is taken first.`);
  console.log("Source session folders are removed only after a verified copy. Any error auto-restores.");
  const confirm = (await rl.question('Type "consolidate" to proceed, anything else to cancel: ')).trim();
  if (confirm !== "consolidate") return console.log("Cancelled. Nothing was changed.");

  applyConsolidate(plan);
}

function printConsolidatePlan(plan) {
  console.log("\nConsolidation plan");
  console.log(`  Target:  ${plan.targetPath}`);
  console.log(`  Sources: ${plan.sources.length}`);
  for (const source of plan.sources) {
    console.log(`    ${source.sourcePath}`);
    console.log(`      dirs=${source.dirs} files=${source.files} config=${source.configKeys} history=${source.historyLines}`);
  }
  console.log(`  Session files to merge: ${plan.fileCopies.length}`);
  console.log(`  New target folders:     ${plan.createdDirs.length}`);
  console.log(`  Source folders removed after verified copy: ${plan.removeDirsAfter.length}`);
  console.log(`  Files backed up:        ${plan.touchedFiles.length}`);
  console.log(`  Backup location:        ${BACKUP_ROOT}`);
  for (const collision of plan.uuidCollisions) {
    console.log(`  SESSION-ID COLLISION (would overwrite): ${collision.to}`);
  }
}

async function pickParent(rl, groups, label, exclude) {
  const options = groups.filter((group) => group.parent !== exclude);
  console.log(`\nSelect the ${label} parent folder (the folder that contains your projects):`);
  options.forEach((group, index) => {
    console.log(`  ${index + 1}. ${group.parent}  (${group.projects.length} Claude project${group.projects.length === 1 ? "" : "s"})`);
  });
  console.log(`  c. Enter a custom path`);
  console.log(`  q. Cancel`);
  while (true) {
    const answer = (await rl.question(`${capitalize(label)} parent: `)).trim();
    if (answer.toLowerCase() === "q") return null;
    if (answer.toLowerCase() === "c") {
      const custom = (await rl.question("Path: ")).trim();
      if (!custom) continue;
      const normalized = normalizePath(custom);
      if (normalized === exclude) {
        console.log("Origin and destination must differ.");
        continue;
      }
      return normalized;
    }
    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= options.length) return options[index - 1].parent;
    console.log("Invalid choice.");
  }
}

async function checklist(rl, entries, destinationParent) {
  const pageSize = 10;
  let page = 0;
  let showHidden = false;
  const checked = new Set(); // entry objects, stable across renames/filtering

  while (true) {
    // bare folders with no Claude metadata are collapsed behind `h` — they can
    // never be selected and drown the real projects when origin is e.g. $HOME
    const view = showHidden ? entries : entries.filter((entry) => entry.hasMetadata);
    const hiddenCount = entries.length - entries.filter((entry) => entry.hasMetadata).length;
    const totalPages = Math.max(1, Math.ceil(view.length / pageSize));
    page = Math.min(Math.max(page, 0), totalPages - 1);
    const start = page * pageSize;
    const visible = view.slice(start, start + pageSize);

    console.log(`\nProjects (page ${page + 1}/${totalPages}, ${checked.size} selected)`);
    if (!view.length) console.log("  (no projects with Claude metadata under this origin)");
    visible.forEach((entry, offset) => {
      const index = start + offset;
      const mark = entry.eligible ? (checked.has(entry) ? "[x]" : "[ ]") : " ✗ ";
      const folder =
        entry.folderAction === "copy"
          ? "folder: needs copy to destination"
          : entry.oldExists && entry.destExists
            ? "folder: exists on both sides"
            : entry.destExists
              ? "folder: already at destination"
              : "folder: missing on both sides";
      const renamed = path.basename(entry.newPath) !== path.basename(entry.oldPath) ? `  ->  renamed: ${path.basename(entry.newPath)}` : "";
      console.log(`${mark} ${index + 1}. ${path.basename(entry.oldPath)}${renamed}`);
      console.log(`      ${entry.oldPath} -> ${entry.newPath}`);
      if (entry.refs) {
        const refs = entry.refs;
        console.log(
          `      sessionFolders=${refs.oldDirs.length} sessionFiles=${refs.sessionFiles.length} config=${refs.configKeysOld} history=${refs.historyOld} | ${folder}`,
        );
      }
      if (entry.blockers.length) console.log(`      BLOCKED: ${entry.blockers.join("; ")}`);
      for (const warning of entry.warnings) console.log(`      note: ${warning}`);
    });
    if (!showHidden && hiddenCount > 0) {
      console.log(`  … ${hiddenCount} folder(s) without Claude metadata hidden (h to show)`);
    }

    const answer = (
      await rl.question(
        "\nToggle: number(s) e.g. 1,3 or 2-5 | a=all eligible | n=none | r N=rename dest | h=show/hide bare folders | > next | < prev | d=done | q=cancel: ",
      )
    ).trim();
    const lower = answer.toLowerCase();
    if (lower === "q") return null;
    if (lower === "d") return entries.filter((entry) => checked.has(entry));
    if (lower === "a") {
      for (const entry of entries) if (entry.eligible) checked.add(entry);
      continue;
    }
    if (lower === "n") {
      checked.clear();
      continue;
    }
    if (lower === "h") {
      showHidden = !showHidden;
      page = 0;
      continue;
    }
    if (lower === ">" || lower === "next") {
      page += 1;
      continue;
    }
    if (lower === "<" || lower === "prev") {
      page -= 1;
      continue;
    }
    const renameMatch = lower.match(/^r\s+(\d+)$/);
    if (renameMatch) {
      const index = Number(renameMatch[1]) - 1;
      if (index < 0 || index >= view.length) {
        console.log("Invalid number.");
        continue;
      }
      const entry = view[index];
      const name = (await rl.question(`New destination folder name for "${path.basename(entry.oldPath)}": `)).trim();
      if (!name || name.includes("/")) {
        console.log("Invalid name (must be a plain folder name).");
        continue;
      }
      const rebuilt = makeEntry(
        entries.map((item) => item.project).filter(Boolean),
        entry.project,
        entry.oldPath,
        destinationParent,
        name,
      );
      const wasChecked = checked.has(entry);
      checked.delete(entry);
      entries[entries.indexOf(entry)] = rebuilt;
      if (wasChecked && rebuilt.eligible) checked.add(rebuilt);
      if (!rebuilt.eligible) console.log(`Note: renamed entry is now blocked: ${rebuilt.blockers.join("; ")}`);
      continue;
    }
    const indexes = parseSelection(lower, view.length);
    if (!indexes) {
      console.log("Invalid input.");
      continue;
    }
    for (const index of indexes) {
      const entry = view[index];
      if (!entry.eligible) {
        console.log(`Cannot select ${index + 1}: ${entry.blockers.join("; ")}`);
        continue;
      }
      if (checked.has(entry)) checked.delete(entry);
      else checked.add(entry);
    }
  }
}

function parseSelection(text, max) {
  const out = new Set();
  for (const part of text.split(",").map((item) => item.trim()).filter(Boolean)) {
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from < 1 || to > max || from > to) return null;
      for (let i = from; i <= to; i++) out.add(i - 1);
    } else if (/^\d+$/.test(part)) {
      const index = Number(part);
      if (index < 1 || index > max) return null;
      out.add(index - 1);
    } else {
      return null;
    }
  }
  return out.size ? [...out] : null;
}

function printPlanSummary(plan, notEligible) {
  console.log("\nMigration plan");
  console.log(`  Origin parent:      ${plan.originParent}`);
  console.log(`  Destination parent: ${plan.destinationParent}`);
  console.log(`  Projects:           ${plan.projects.length}`);
  for (const project of plan.projects) {
    const e = project.expected;
    console.log(`    ${path.basename(project.oldPath)}  [${project.folderAction}]`);
    console.log(`      ${project.oldPath} -> ${project.newPath}`);
    console.log(`      sessionFolders=${e.projectDirs} sessionFiles=${e.sessionFiles} config=${e.configKeysOld} history=${e.historyOld}`);
    for (const warning of project.warnings) console.log(`      note: ${warning}`);
  }
  console.log(`  Session-folder renames: ${plan.dirRenames.length}`);
  if (plan.folderCopies.length) {
    console.log(`  Folder copies (source never deleted): ${plan.folderCopies.length}`);
  }
  console.log(`  Files to modify: ${plan.touchedFiles.length}`);
  console.log(`  Backup location: ${BACKUP_ROOT}`);
  for (const entry of notEligible || []) {
    console.log(`  NOT ELIGIBLE: ${entry.oldPath} (${entry.blockers.join("; ")})`);
  }
}

async function restoreFlow(rl) {
  const backups = listBackups();
  if (!backups.length) return console.log(`No backups found under ${BACKUP_ROOT}`);
  console.log("\nBackups (newest first):");
  backups.slice(0, 15).forEach((backup, index) => {
    console.log(`  ${index + 1}. ${backup.name}`);
  });
  const answer = (await rl.question("Restore which backup? (number, q to cancel): ")).trim();
  if (answer.toLowerCase() === "q") return;
  const index = Number(answer);
  if (!Number.isInteger(index) || index < 1 || index > Math.min(backups.length, 15)) {
    return console.log("Invalid choice.");
  }
  const dir = backups[index - 1].dir;
  const confirm = (await rl.question(`Type "restore" to overwrite current Claude state from ${backups[index - 1].name}: `)).trim();
  if (confirm !== "restore") return console.log("Cancelled.");
  ensureClaudeClosed();
  restoreBackup(dir);
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function getArgValue(flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) return null;
  return value;
}

function walkFiles(root, suffix) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(file, suffix));
    else if (entry.isFile() && file.endsWith(suffix)) out.push(file);
  }
  return out.sort();
}

function dedupe(array) {
  return [...new Set(array)];
}

function realpathOrNull(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return null;
  }
}

function safeReadText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function fileSha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}
