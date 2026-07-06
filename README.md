# claude-folder-move

Retarget Claude Code sessions when your project folders move.

This tool handles the fiddly migration of Claude Code state — session transcripts, project indices, and configuration — when you reorganize folders on disk. The companion tool [codex-folder-move](https://github.com/claudio-medeiros/codex-folder-move) does the same for OpenAI's Codex desktop app.

![Tests](https://github.com/claudio-medeiros/claude-folder-move/actions/workflows/test.yml/badge.svg)
![Node 18+](https://img.shields.io/badge/node-18%2B-brightgreen)
![License MIT](https://img.shields.io/badge/license-MIT-blue)

## What it does

Claude Code stores session transcripts and project metadata in `~/.claude/projects/` using encoded folder names. When you move a project folder, the stored paths become stale — Claude can't find your sessions. This tool safely rewrites all those path references.

**Five main operations:**

1. **Migrate projects** — Retarget state when a folder moves (single or batch)
2. **Consolidate history** — Merge scattered session history from multiple folder eras into one project
3. **Scan Claude state** — Discover all projects and their session counts
4. **Restore from backup** — Roll back if anything went wrong (checksum-verified)
5. **Quit**

## Installation

Clone this repo:

```bash
git clone https://github.com/claudio-medeiros/claude-folder-move.git
cd claude-folder-move
```

**Requirements:** Node 18+

## Usage

### Interactive mode (default)

```bash
node claude-folder-move.mjs
```

This opens a menu-driven TUI. Navigate with arrow keys or type shortcuts (1–5 for menu options, 'a' to select all, 'd' to deselect, 'h' to toggle bare folders, 'c' for custom paths). You'll be guided through origin/destination pickers and a confirmation checklist.

**Important:** Close all Claude Code instances (desktop app and CLI sessions) before running.

### Non-interactive mode

Scan projects:
```bash
node claude-folder-move.mjs --scan [--json]
```

Plan a migration (no changes):
```bash
node claude-folder-move.mjs --plan --origin <dir> --dest <dir> [--projects a,b] [--json]
```

Apply the migration:
```bash
node claude-folder-move.mjs --apply --origin <dir> --dest <dir> --projects a,b [--copy-folders] --yes
```

Consolidate scattered history:
```bash
node claude-folder-move.mjs --consolidate --target <dir> --sources <p1,p2,...> --yes
```

Restore a backup:
```bash
node claude-folder-move.mjs --restore [latest|<backup-dir>]
```

### Options

- `--config-dir <dir>` — Claude config dir (default `~/.claude`, or `$CLAUDE_CONFIG_DIR`)
- `--claude-json <file>` — Main config JSON (auto-detected if not specified)
- `--backup-dir <dir>` — Where backups go (default `~/claude-folder-move-backups`)
- `--projects <list>` — Comma-separated project folder names or full paths
- `--rename <a=b,...>` — Rename project folder(s) at the destination
- `--copy-folders` — Copy source folders to destination when missing there
- `--yes` — Skip the confirmation prompt (apply/consolidate/restore only)

## Interactive flow

```
Step 1: Main Menu
────────────────────────────────────────────────────────
claude-folder-move — Claude config dir: /Users/you/.claude

 ● Main menu
   1. Migrate projects (retarget a folder move)
   2. Consolidate a project's scattered history
   3. Scan Claude state
   4. Restore from backup
   5. Quit


Step 2: Origin Picker (Rich TUI)
────────────────────────────────────────────────────────
Select the origin parent folder
 ● /Users/you/old-projects
   /Users/you/archive/projects
   [c] enter custom path


Step 3: Destination Picker
────────────────────────────────────────────────────────
Select the destination parent folder
 ● /Users/you/projects
   /Volumes/backup/projects
   [c] enter custom path


Step 4: Project Checklist (Rich TUI with toggles)
────────────────────────────────────────────────────────
claude-folder-move — Migrate: /old → /new

Eligible projects (bare folder(s) hidden)
 ✓ my-app              dirs=1 sessions=5 cwdLines=2841
 ✓ website             dirs=1 sessions=12 cwdLines=8104
 ✓ research            dirs=1 sessions=2 cwdLines=634

Shortcuts: [a] select all  [d] deselect  [h] show bare  [↑↓] navigate


Step 5: Confirmation
────────────────────────────────────────────────────────
Ready to migrate 3 projects?

Backup: ~/claude-folder-move-backups/2024-07-06T19-00-00Z/
  - Projects: /old → /new
  - Copy folders: yes
  
Type "migrate" to proceed, or ctrl+c to cancel
```

## How it works

### State stores patched

**Before migration:**
```
~/.claude/
├── projects/
│   ├── Users-old-path-my-app/
│   │   ├── 2024-01-15.jsonl  (cwd: /old/path/my-app)
│   │   └── 2024-02-20.jsonl  (cwd: /old/path/my-app)
│   └── Users-old-path-website/
│       └── 2024-03-01.jsonl  (cwd: /old/path/website)
├── claude.json               (projects: {"/old/path/my-app": ...})
└── history.jsonl             (project: /old/path/my-app)
```

**After migration:**
```
~/.claude/
├── projects/
│   ├── Users-new-path-my-app/
│   │   ├── 2024-01-15.jsonl  (cwd: /new/path/my-app) ← REWRITTEN
│   │   └── 2024-02-20.jsonl  (cwd: /new/path/my-app) ← REWRITTEN
│   └── Users-new-path-website/
│       └── 2024-03-01.jsonl  (cwd: /new/path/website) ← REWRITTEN
├── claude.json               (projects: {"/new/path/my-app": ...}) ← KEY MOVED
└── history.jsonl             (project: /new/path/my-app) ← REWRITTEN
```

**What's rewritten:**
- `~/.claude/projects/<encoded-path>/` — directory renamed to match new encoding
- Session `*.jsonl` files — top-level `cwd` fields (prefix-aware matching)
- `~/.claude/claude.json` — projects map keys and path values
- `~/.claude/history.jsonl` — per-line `project` field

### What stays untouched

- Historical transcript content (toolUseResult/message text)
- `plans/`, `tasks/`, `file-history/` (snapshots)
- `backups/`, `sessions/`, `daemon/`, `ide/` (transient stores)

## Safety & Backups

**Before any migration:**
1. ✅ Creates full backup in `~/claude-folder-move-backups/`
2. ✅ Writes SHA256 manifest for verification
3. ✅ Generates standalone rollback script
4. ✅ Plan phase validates all path rewrites

**During migration:**
- Path rewrites use prefix-aware matching (handles nested projects)
- Session indices updated atomically
- Desktop app session index (local_*.json) patched if present

**On error:**
- ✅ Automatic checksum-verified restore
- ✅ All files rollback to pre-migration state
- ✅ Zero data loss guaranteed

**Key guarantees:**
- Project folders only **copied** to destination, never deleted
- Source folders always preserved as backup
- Encoded path names never decoded (encoding is lossy)
- Sessions stay indexed even if paths diverge

## Testing

Comprehensive test suite with 59 tests covering:

```bash
npm test
```

Tests verify:
- ✅ Project discovery and grouping
- ✅ Path rewriting (simple and nested)
- ✅ Session index updates
- ✅ Desktop app index patching
- ✅ Backup creation & verification
- ✅ Automatic rollback on failure
- ✅ Interactive TUI navigation
- ✅ Collision detection & merge
- ✅ Folder copy operations
- ✅ Edge cases (corrupted lines, bare folders, renames)

All tests run against real file fixtures in temp directories, with byte-level verification of state before/after.

## Examples

### Interactive: Move a single project

```bash
node claude-folder-move.mjs
```

Menu appears:
```
claude-folder-move — Claude config dir: /Users/you/.claude

Main menu
  1. Migrate projects (retarget a folder move)
  2. Consolidate a project's scattered history
  3. Scan Claude state
  4. Restore from backup
  5. Quit
Choose 1-5: 
```

Follow the TUI prompts to select origin/destination folders and confirm the migration.

### Scan: Discover all projects

```bash
node claude-folder-move.mjs --scan
```

Shows projects grouped by parent folder with session counts:

```
/Users/you/Projects  (3 projects)
  my-app              dirs=1 sessions=5 cwdLines=2841 config=1 history=0
  website             dirs=1 sessions=12 cwdLines=8104 config=1 history=0
  research            dirs=1 sessions=2 cwdLines=634 config=1 history=0

/Users/you/old-backup  (3 projects)
  my-app              dirs=1 sessions=3 cwdLines=1521 config=1 history=0
  archived-site       dirs=1 sessions=1 cwdLines=89 config=1 history=0
  old-research        dirs=1 sessions=2 cwdLines=945 config=1 history=0
```

Each project shows:
- `dirs` — encoded state directories
- `sessions` — session transcript files
- `cwdLines` — cwd references rewritten
- `config` — claude.json entries
- `history` — history.jsonl lines

### Batch migrate multiple projects

Plan first (no changes):
```bash
node claude-folder-move.mjs --plan \
  --origin ~/old-machine-backup/projects \
  --dest ~/projects \
  --projects my-app,website,research \
  --json
```

Then apply:
```bash
node claude-folder-move.mjs --apply \
  --origin ~/old-machine-backup/projects \
  --dest ~/projects \
  --projects my-app,website,research \
  --copy-folders \
  --yes
```

### Consolidate history across moves

If you moved a project twice, history is scattered:

```bash
node claude-folder-move.mjs --consolidate \
  --target ~/projects/my-app \
  --sources ~/old-projects/my-app,~/backup/my-app \
  --yes
```

## Troubleshooting

**"No projects dir found"**
Ensure `~/.claude/projects/` exists. Run Claude Code once if it's a fresh install.

**Session count doesn't match**
Some sessions may be in `~/.claude/sessions/` (live, transient). Use `--scan` to see all counts.

**Can't move nested projects**
The tool filters deeply nested worktree directories (e.g., `<proj>/.claude/worktrees/x`) from parent pickers. Direct children (siblings in `~/projects/`) stay visible.

## Restore a backup

If the migration failed or caused issues:

```bash
node claude-folder-move.mjs --restore latest
```

Or point to a specific backup directory. Restoration verifies the SHA256 manifest before applying.

## License

MIT

---

**Sibling project:** [codex-folder-move](https://github.com/claudio-medeiros/codex-folder-move) — same UX and safety model for OpenAI Codex.
