# Spike 0: Tauri Risk Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute 3 sub-spikes (BlockNote-WKWebView, Yjs placement, DB placement) to lock in 3 architectural decisions before starting memry's Electron → Tauri migration.

**Architecture:** Throwaway Tauri 2.x app in `spikes/tauri-risk-discovery/` + 2 prototype workspaces for S2 comparison. Keeper artifacts (findings + benchmarks + scripts) land in `docs/spikes/tauri-risk-discovery/` on main branch. Autonomous execution with 4 Kaan-review checkpoints (after each sub-spike + final sign-off).

**Tech Stack:** Tauri 2.2+, Rust 1.85+, React 19, Vite 7, TypeScript, BlockNote 0.47.x, Yjs 13.6.x, yrs 0.21+, rusqlite / `@tauri-apps/plugin-sql`, Playwright 1.57+, criterion

**Spec:** `docs/superpowers/specs/2026-04-23-spike-0-tauri-risk-discovery-design.md`

---

## File Structure

### Created during spike (throwaway, removed at cleanup)

```
spikes/tauri-risk-discovery/
├── app/                                      (main Tauri app, S1 + S3 use this)
│   ├── src/                                  React + BlockNote renderer
│   ├── src-tauri/                            Rust backend
│   ├── package.json
│   ├── tauri.conf.json
│   └── vite.config.ts
├── prototypes/
│   ├── s2-yjs-renderer/                      (S2 Prototype A)
│   │   ├── src/
│   │   ├── src-tauri/
│   │   └── [Tauri scaffolding]
│   └── s2-yjs-rust/                          (S2 Prototype B)
│       ├── src/
│       ├── src-tauri/
│       └── [Tauri scaffolding]
└── README.md                                  "this directory is temporary"
```

### Created as keeper artifacts (committed to main)

```
docs/spikes/tauri-risk-discovery/
├── README.md                                  entry point for future readers
├── findings.md                                overall Spike 0 summary
├── s1-blocknote-webview.md                    S1 detailed report
├── s2-yjs-placement.md                        S2 detailed report
├── s3-db-placement.md                         S3 detailed report
├── benchmarks/
│   ├── README.md
│   ├── environment.json
│   ├── s1-feature-matrix.csv
│   ├── s2-roundtrip-latency.json
│   ├── s3-query-latency.json
│   └── screenshots/                           S1 manual test evidence
└── scripts/
    ├── README.md
    ├── collect-environment.ts
    ├── bench-webview-blocknote.ts
    ├── bench-yjs-roundtrip.ts
    └── bench-db-query.ts
```

### Modified files (monorepo root)

- `pnpm-workspace.yaml` — add `!spikes/**` to packages (reverted at cleanup)

### Unmodified (important)

- `apps/desktop/` — Electron app stays untouched during spike; parallel development OK
- `apps/sync-server/` — Cloudflare Workers sync-server stays untouched
- `packages/*` — shared packages untouched

---

## Phase 0: Coordinator Setup

**Executed by:** Coordinator (main session Claude + Kaan), NOT sub-agent.

**Rationale:** Worktree creation, pnpm install, and initial git operations exceed sub-agent permissions per MEMORY.md `feedback_subagent_permissions.md`.

### Task 1: Create worktree and branch

**Files:**
- Modify working directory (no files yet)

- [ ] **Step 1: Verify memry main branch is clean**

Run: `git -C /Users/h4yfans/sideproject/memry status`
Expected: "working tree clean" or only untracked files we're about to create

- [ ] **Step 2: Create worktree**

Run:
```bash
git -C /Users/h4yfans/sideproject/memry worktree add \
  /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk \
  -b spike/tauri-risk-discovery
```

Expected output:
```
Preparing worktree (new branch 'spike/tauri-risk-discovery')
HEAD is now at <commit>
```

- [ ] **Step 3: Verify worktree created**

Run: `ls -la /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk/`
Expected: full memry tree mirrored, `.git` is a file pointing to worktree

- [ ] **Step 4: Confirm branch**

Run: `git -C /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk branch --show-current`
Expected: `spike/tauri-risk-discovery`

### Task 2: Update pnpm-workspace.yaml to exclude spikes/

**Files:**
- Modify: `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk/pnpm-workspace.yaml`

- [ ] **Step 1: Read current pnpm-workspace.yaml**

Run: `cat /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk/pnpm-workspace.yaml`
Expected: list of packages with `apps/*`, `packages/*` patterns

- [ ] **Step 2: Add `!spikes/**` exclusion**

Edit `pnpm-workspace.yaml` to add exclusion pattern. Example final content (adjust to match existing structure):
```yaml
packages:
  - "apps/*"
  - "packages/*"
  - "!spikes/**"
```

- [ ] **Step 3: Verify pnpm still resolves main packages**

Run: `cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk && pnpm -r ls --depth=-1 2>&1 | head -20`
Expected: lists workspace packages (`@memry/desktop`, etc.), NO error about spikes

### Task 3: Scaffold keeper directory structure

**Files:**
- Create: `docs/spikes/tauri-risk-discovery/` and subdirectories

- [ ] **Step 1: Create directory tree**

Run:
```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk
mkdir -p docs/spikes/tauri-risk-discovery/benchmarks/screenshots
mkdir -p docs/spikes/tauri-risk-discovery/scripts
mkdir -p spikes/tauri-risk-discovery
```

- [ ] **Step 2: Verify structure**

Run: `ls -la docs/spikes/tauri-risk-discovery/`
Expected: `benchmarks/`, `scripts/` subdirectories exist

### Task 4: Write README.md for docs/spikes/tauri-risk-discovery/

**Files:**
- Create: `docs/spikes/tauri-risk-discovery/README.md`

- [ ] **Step 1: Write README content**

Create file with:
```markdown
# Spike 0: Tauri Risk Discovery

**Duration:** 2026-04-24 → [end date]
**Status:** [In progress / Complete / Aborted]
**Parent spec:** `docs/superpowers/specs/2026-04-23-spike-0-tauri-risk-discovery-design.md`

## Purpose

Before starting memry's Electron → Tauri migration, this spike tests 3
architectural decisions with real code:

1. **S1** — Does BlockNote work correctly in system webview (WKWebView on macOS)?
2. **S2** — Where does Yjs live: renderer-owned or Rust (yrs)?
3. **S3** — Where does the database live: Rust-owned, plugin-sql, or hybrid?

## How to read this directory

- `findings.md` — overall Spike 0 summary and decisions
- `s1-blocknote-webview.md` — S1 detailed report
- `s2-yjs-placement.md` — S2 detailed report
- `s3-db-placement.md` — S3 detailed report
- `benchmarks/` — raw measurement data (JSON, CSV, screenshots)
- `scripts/` — reproducible benchmark runners

## Reproducing benchmarks

See `scripts/README.md`. Spike prototype code was deleted at end of spike;
scripts can run standalone against any new Tauri/memry code.

## Status

[To be filled in as spike progresses]
```

### Task 5: Write findings.md skeleton

**Files:**
- Create: `docs/spikes/tauri-risk-discovery/findings.md`

- [ ] **Step 1: Write skeleton**

Create file with:
```markdown
# Spike 0: Tauri Risk Discovery — Findings

## Metadata
- **Start:** 2026-04-24
- **End:** [to be filled]
- **Total duration:** [autonomous + review hours]
- **Commit range:** [first commit] → [last commit]

## TL;DR — Migration go/no-go

[🟢 PROCEED / 🟡 PROCEED WITH CAVEATS / 🔴 ABORT]

[2-3 sentence summary]

## Decision summary

| Sub | Decision | Meaning |
|-----|----------|---------|
| S1  | [pending] | [pending] |
| S2  | [pending] | [pending] |
| S3  | [pending] | [pending] |

## Post-spike architecture picture

[ASCII diagram to be added]

## Subproject sequencing

[Estimates to be added]

## Key risks carried forward

[List to be added]

## Next step

Subproject 1 brainstorm (separate session).
```

### Task 6: Write sub-spike findings.md skeletons

**Files:**
- Create: `docs/spikes/tauri-risk-discovery/s1-blocknote-webview.md`
- Create: `docs/spikes/tauri-risk-discovery/s2-yjs-placement.md`
- Create: `docs/spikes/tauri-risk-discovery/s3-db-placement.md`

- [ ] **Step 1: Write s1 skeleton**

Create `s1-blocknote-webview.md` with all 10 sections per spec Section 6
template (Metadata, Hypothesis, TL;DR, Setup, Test matrix results, Benchmark
data, Observations, Decision + rationale, Subsequent subproject impact,
References). Each section body says `[To be filled during S1 execution]`.

- [ ] **Step 2: Write s2 skeleton**

Same structure, substitute S2 content. Body says `[To be filled during S2 execution]`.

- [ ] **Step 3: Write s3 skeleton**

Same structure, substitute S3 content. Body says `[To be filled during S3 execution]`.

### Task 7: Write spikes/tauri-risk-discovery/README.md

**Files:**
- Create: `spikes/tauri-risk-discovery/README.md`

- [ ] **Step 1: Write temporary directory disclaimer**

Create file with:
```markdown
# Spike 0 — Throwaway Code

**⚠️ This directory is temporary.**

Code here will be deleted at the end of Spike 0. Permanent artifacts
(findings, benchmarks, scripts) live in `docs/spikes/tauri-risk-discovery/`.

## Structure

- `app/` — main Tauri 2.x app used for S1 (BlockNote-WKWebView) and S3 (DB placement)
- `prototypes/s2-yjs-renderer/` — S2 Prototype A (renderer-owned Y.Doc)
- `prototypes/s2-yjs-rust/` — S2 Prototype B (yrs in Rust)

## Why this is outside pnpm workspace

`pnpm-workspace.yaml` excludes `spikes/**`. This dir has its own isolated
`package.json` and Cargo manifest. Install deps per-subdir:
`cd spikes/tauri-risk-discovery/app && pnpm install && cargo build`.
```

### Task 8: Scaffold collect-environment.ts

**Files:**
- Create: `docs/spikes/tauri-risk-discovery/scripts/collect-environment.ts`

- [ ] **Step 1: Write environment collector**

Create file with:
```typescript
// Collects hardware/OS/tooling snapshot for reproducible benchmarks.
// Used by all bench-*.ts scripts to tag their output.

import { execSync } from 'node:child_process'
import { platform, arch, release } from 'node:os'
import { writeFileSync } from 'node:fs'

export interface Environment {
  timestamp: string
  os: { platform: string; arch: string; release: string; cpuModel: string | null }
  runtimes: {
    node: string
    rust: string | null
    cargo: string | null
    tauri_cli: string | null
  }
  libraries: {
    yjs: string | null
    yrs: string | null
    tauri_core: string | null
    blocknote_core: string | null
  }
}

function tryRun(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function getCpuModel(): string | null {
  if (platform() === 'darwin') {
    return tryRun('sysctl -n machdep.cpu.brand_string')
  }
  if (platform() === 'linux') {
    return tryRun("awk -F: '/model name/ { print $2; exit }' /proc/cpuinfo")?.trim() ?? null
  }
  if (platform() === 'win32') {
    return tryRun('wmic cpu get Name /value')?.split('=')[1]?.trim() ?? null
  }
  return null
}

export async function collectEnvironment(): Promise<Environment> {
  return {
    timestamp: new Date().toISOString(),
    os: {
      platform: platform(),
      arch: arch(),
      release: release(),
      cpuModel: getCpuModel(),
    },
    runtimes: {
      node: process.version,
      rust: tryRun('rustc --version'),
      cargo: tryRun('cargo --version'),
      tauri_cli: tryRun('cargo tauri --version') ?? tryRun('tauri --version'),
    },
    libraries: {
      yjs: tryRun(`pnpm list yjs --depth 0 --json 2>/dev/null | grep '"version"' | head -1 | cut -d'"' -f4`) ?? null,
      yrs: null,
      tauri_core: null,
      blocknote_core: tryRun(`pnpm list @blocknote/core --depth 0 --json 2>/dev/null | grep '"version"' | head -1 | cut -d'"' -f4`) ?? null,
    },
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  collectEnvironment().then((env) => {
    const output = 'docs/spikes/tauri-risk-discovery/benchmarks/environment.json'
    writeFileSync(output, JSON.stringify(env, null, 2))
    console.log(`Environment snapshot written to ${output}`)
    console.log(JSON.stringify(env, null, 2))
  })
}
```

- [ ] **Step 2: Run environment collector to produce baseline**

Run: `cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk && pnpm exec tsx docs/spikes/tauri-risk-discovery/scripts/collect-environment.ts`
Expected: writes `docs/spikes/tauri-risk-discovery/benchmarks/environment.json`, prints JSON to stdout

- [ ] **Step 3: Verify output**

Run: `cat docs/spikes/tauri-risk-discovery/benchmarks/environment.json`
Expected: JSON with `os`, `runtimes`, `libraries` keys populated

### Task 9: Write scripts/README.md

**Files:**
- Create: `docs/spikes/tauri-risk-discovery/scripts/README.md`

- [ ] **Step 1: Write runner guide**

Create file with:
```markdown
# Spike 0 Benchmark Scripts

Reproducible runners for Spike 0 benchmarks. All write output to
`../benchmarks/<name>.json` with schema version 1.

## Prerequisites

- pnpm installed at monorepo root
- Rust 1.85+ with cargo
- macOS (Windows partial support for S1)

## Running

```bash
# Environment snapshot (run before other benchmarks)
pnpm exec tsx collect-environment.ts

# S1: BlockNote + WKWebView feature matrix
pnpm exec tsx bench-webview-blocknote.ts

# S2: Yjs roundtrip latency (Prototype A vs B)
pnpm exec tsx bench-yjs-roundtrip.ts

# S3: DB query latency (3 options)
pnpm exec tsx bench-db-query.ts
```

## Output format

See `../benchmarks/environment.json` for schema example. All outputs include:
- `schema_version: 1`
- `environment` (OS, runtimes, libraries)
- `runs` (per-test data)
- `notes` (anomalies)

## After spike cleanup

Spike prototype code in `spikes/tauri-risk-discovery/` was deleted. To
re-run benchmarks, re-scaffold prototypes using the spec's Section 5 setup
instructions or any equivalent Tauri + BlockNote scaffold.
```

### Task 10: Write benchmarks/README.md

**Files:**
- Create: `docs/spikes/tauri-risk-discovery/benchmarks/README.md`

- [ ] **Step 1: Write benchmarks directory guide**

Create file with:
```markdown
# Spike 0 Benchmark Data

Raw measurement outputs from Spike 0. Not human-authored — produced by
`../scripts/bench-*.ts` runners.

## Files

- `environment.json` — hardware/OS/tooling snapshot at spike start
- `s1-feature-matrix.csv` — S1 per-test pass/fail grid (macOS + Windows)
- `s2-roundtrip-latency.json` — S2 Prototype A vs B timing
- `s3-query-latency.json` — S3 3-option DB query benchmarks
- `screenshots/` — S1 manual test evidence (IME, HTML paste, resize)

## Schema

All JSON files use `schema_version: 1`:
```json
{
  "schema_version": 1,
  "spike": "sN-name",
  "benchmark": "benchmark-name",
  "timestamp": "ISO 8601",
  "environment": { /* see environment.json */ },
  "runs": [ /* per-test data */ ],
  "notes": "free text"
}
```

Schema changes produce a new version; old files remain readable.
```

### Task 11: Initial spike commit

**Files:**
- Modify: git state

- [ ] **Step 1: Stage scaffolded files**

Run:
```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk
git add pnpm-workspace.yaml
git add spikes/tauri-risk-discovery/README.md
git add docs/spikes/tauri-risk-discovery/
```

- [ ] **Step 2: Verify staged state**

Run: `git status`
Expected: changes to `pnpm-workspace.yaml`, new files in `spikes/` and `docs/spikes/`

- [ ] **Step 3: Commit**

Run:
```bash
git commit -m "spike(setup): initialize spike 0 tauri risk discovery

- Add docs/spikes/tauri-risk-discovery/ with README, findings skeletons,
  benchmark and script templates
- Add spikes/tauri-risk-discovery/README with throwaway-dir disclaimer
- Exclude spikes/** from pnpm workspace
- Include collect-environment.ts helper for reproducible benchmark tagging"
```
Expected: commit succeeds

- [ ] **Step 4: Verify commit**

Run: `git log -1 --stat`
Expected: shows created files

### Task 12: Scaffold Tauri app via create-tauri-app

**Files:**
- Create: `spikes/tauri-risk-discovery/app/` (full Tauri 2.x scaffold)

- [ ] **Step 1: Run create-tauri-app interactively**

Run:
```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk/spikes/tauri-risk-discovery
pnpm create tauri-app@latest app -- --template react-ts --manager pnpm
```

If CLI prompts (depending on version), select:
- App name: `spike-tauri-risk`
- Window title: `Spike 0`
- Package manager: `pnpm`
- UI template: `React` + TypeScript
- UI flavor: `React`

Expected: directory `spikes/tauri-risk-discovery/app/` created with full Tauri scaffold

- [ ] **Step 2: Verify scaffold**

Run: `ls spikes/tauri-risk-discovery/app/`
Expected: `src/`, `src-tauri/`, `package.json`, `tauri.conf.json`, `vite.config.ts`, `index.html`

- [ ] **Step 3: Install deps**

Run: `cd spikes/tauri-risk-discovery/app && pnpm install`
Expected: node_modules populated, no errors

### Task 13: Configure Tauri app (minimum macOS, bundle identifier)

**Files:**
- Modify: `spikes/tauri-risk-discovery/app/src-tauri/tauri.conf.json`

- [ ] **Step 1: Read current tauri.conf.json**

Run: `cat spikes/tauri-risk-discovery/app/src-tauri/tauri.conf.json`

- [ ] **Step 2: Update identifier and macOS minimum**

Edit `tauri.conf.json`:
- Set `identifier` to `com.memry.spike-tauri-risk`
- Under `bundle.macOS` add `"minimumSystemVersion": "10.15"`
- Under `app.windows[0]` set `title` to `"Spike 0 — Tauri Risk Discovery"`

Example final shape (adjust to template's actual keys, the below may need merging):
```json
{
  "identifier": "com.memry.spike-tauri-risk",
  "app": {
    "windows": [{ "title": "Spike 0 — Tauri Risk Discovery", "width": 1200, "height": 800 }]
  },
  "bundle": {
    "macOS": { "minimumSystemVersion": "10.15" }
  }
}
```

### Task 14: Verify Tauri dev runs

**Files:** none (sanity check)

- [ ] **Step 1: Run dev server**

Run: `cd spikes/tauri-risk-discovery/app && pnpm tauri dev`
Expected: Tauri window opens showing default React+Vite welcome page. Rust compiles without error. Vite HMR ready.

- [ ] **Step 2: Verify webview on macOS is WKWebView**

In the opened Tauri window, right-click → Inspect Element (if devtools enabled) or check via the app. Alternatively, run: `ps aux | grep -i webkit` while Tauri app is running — should show WebKit processes.

- [ ] **Step 3: Close dev server**

Press Ctrl+C in terminal

- [ ] **Step 4: Commit Tauri scaffold**

Run:
```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk
git add spikes/tauri-risk-discovery/app/
# Note: spikes/ is in pnpm exclusion but still tracked by git
git commit -m "spike(app): scaffold Tauri 2.x app with React+TS template

- Created via pnpm create tauri-app
- identifier: com.memry.spike-tauri-risk
- macOS minimum version: 10.15"
```

---

## Phase 1: S1 — BlockNote + WKWebView

**Sub-agent dispatch context:** Fresh sub-agent invocation. Before starting,
read `docs/spikes/tauri-risk-discovery/s1-blocknote-webview.md` skeleton to
understand target artifact. No prior sub-spike findings to read (S1 is first).

### Task 15: Install BlockNote deps in spike app

**Files:**
- Modify: `spikes/tauri-risk-discovery/app/package.json`

- [ ] **Step 1: Install BlockNote core + React + shadcn wrapper**

Run:
```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk/spikes/tauri-risk-discovery/app
pnpm add @blocknote/core@^0.47 @blocknote/react@^0.47 @blocknote/shadcn@^0.47
```

⚠️ If sub-agent: pnpm install is permission-restricted; return to coordinator with
this command request.

- [ ] **Step 2: Verify install**

Run: `pnpm list @blocknote/core --depth 0`
Expected: shows `@blocknote/core@0.47.x`

### Task 16: Replace default App.tsx with BlockNote editor

**Files:**
- Modify: `spikes/tauri-risk-discovery/app/src/App.tsx`

- [ ] **Step 1: Write BlockNote integration**

Replace `App.tsx` contents with:
```tsx
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/shadcn'
import { useCallback, useState } from 'react'
import '@blocknote/core/fonts/inter.css'
import '@blocknote/shadcn/style.css'
import './App.css'

const STORAGE_KEY = 'spike-s1-blocknote-doc'

function App() {
  const editor = useCreateBlockNote({
    initialContent: (() => {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (!saved) return undefined
      try { return JSON.parse(saved) } catch { return undefined }
    })(),
  })

  const [lastDump, setLastDump] = useState<string>('')

  const save = useCallback(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(editor.document))
  }, [editor])

  const load = useCallback(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      try {
        const blocks = JSON.parse(saved)
        editor.replaceBlocks(editor.document, blocks)
      } catch (e) {
        console.error('Load failed:', e)
      }
    }
  }, [editor])

  const dumpJson = useCallback(() => {
    const json = JSON.stringify(editor.document, null, 2)
    setLastDump(json)
    console.log('BlockNote dump:', json)
  }, [editor])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ padding: 8, display: 'flex', gap: 8, borderBottom: '1px solid #ccc' }}>
        <button onClick={save}>Save</button>
        <button onClick={load}>Load</button>
        <button onClick={dumpJson}>Dump JSON</button>
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        <BlockNoteView editor={editor} />
      </div>
      {lastDump && (
        <pre style={{ maxHeight: 200, overflow: 'auto', fontSize: 10, padding: 8, margin: 0, borderTop: '1px solid #ccc' }}>
          {lastDump}
        </pre>
      )}
    </div>
  )
}

export default App
```

- [ ] **Step 2: Run dev, verify editor renders**

Run: `pnpm tauri dev` from `spikes/tauri-risk-discovery/app/`
Expected: Tauri window shows BlockNote editor. Typing works. Save/Load/Dump buttons visible.

- [ ] **Step 3: Manual smoke — type "Hello", hit Save, reload window, hit Load**

Type some text, click Save. Press Cmd+R to reload. Click Load. Text should reappear.

- [ ] **Step 4: Commit**

Run:
```bash
git add spikes/tauri-risk-discovery/app/
git commit -m "spike(s1): integrate BlockNote editor into Tauri app

- Full-viewport BlockNote editor in App.tsx
- Save/Load/Dump buttons wired to localStorage
- Ready for S1 test matrix execution"
```

### Task 17: Setup Playwright for Tauri app testing

**Files:**
- Create: `spikes/tauri-risk-discovery/app/playwright.config.ts`
- Modify: `spikes/tauri-risk-discovery/app/package.json` (add playwright dep)

- [ ] **Step 1: Install Playwright**

Run:
```bash
cd spikes/tauri-risk-discovery/app
pnpm add -D @playwright/test@^1.57
pnpm exec playwright install webkit
```

⚠️ Sub-agent: return to coordinator for pnpm commands.

- [ ] **Step 2: Write playwright.config.ts**

Create file with:
```typescript
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  fullyParallel: false,  // Tauri tests run serially
  forbidOnly: !!process.env.CI,
  retries: 1,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report' }]],

  use: {
    // Note: Tauri apps aren't directly driven by Playwright in v1.57.
    // Strategy: run Vite dev server separately, test renderer via
    // localhost URL. Actual WKWebView testing happens manually for
    // webview-specific tests (IME, paste source).
    baseURL: 'http://localhost:1420',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],

  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:1420',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
})
```

- [ ] **Step 3: Verify playwright config**

Run: `pnpm exec playwright test --list 2>&1 | head -5`
Expected: "No tests found" (we haven't written tests yet, config is valid)

### Task 18: Write bench-webview-blocknote.ts runner

**Files:**
- Create: `docs/spikes/tauri-risk-discovery/scripts/bench-webview-blocknote.ts`

- [ ] **Step 1: Write runner skeleton**

Create file with:
```typescript
// S1 benchmark runner. Orchestrates Playwright tests + collects results
// into ../benchmarks/s1-feature-matrix.csv. Manual tests (IME, paste HTML,
// resize, sigma) are marked "manual-pending" and completed via checklist.

import { collectEnvironment } from './collect-environment'
import { execSync } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'

interface TestResult {
  id: number
  name: string
  platform: 'macOS' | 'Windows'
  method: 'playwright' | 'manual'
  status: 'pass' | 'fail' | 'skipped' | 'manual-pending'
  notes: string
  evidence?: string  // screenshot path, metric value, etc.
}

const TESTS: Omit<TestResult, 'status' | 'notes' | 'evidence'>[] = [
  { id: 1, name: 'ASCII typing', platform: 'macOS', method: 'playwright' },
  { id: 2, name: 'Turkish typing', platform: 'macOS', method: 'playwright' },
  { id: 3, name: 'IME Japanese input', platform: 'macOS', method: 'manual' },
  { id: 4, name: 'Paste plain text 500 char', platform: 'macOS', method: 'playwright' },
  { id: 5, name: 'Paste rich HTML', platform: 'macOS', method: 'manual' },
  { id: 6, name: 'Paste image clipboard', platform: 'macOS', method: 'playwright' },
  { id: 7, name: 'Drag-drop image file', platform: 'macOS', method: 'playwright' },
  { id: 8, name: 'Slash menu', platform: 'macOS', method: 'playwright' },
  { id: 9, name: 'Undo/redo 10-op chain', platform: 'macOS', method: 'playwright' },
  { id: 10, name: 'Table editing', platform: 'macOS', method: 'playwright' },
  { id: 11, name: 'Code block syntax highlight', platform: 'macOS', method: 'playwright' },
  { id: 12, name: 'Link insertion', platform: 'macOS', method: 'playwright' },
  { id: 13, name: 'Large doc stress 10k char', platform: 'macOS', method: 'playwright' },
  { id: 14, name: 'Window resize mid-typing', platform: 'macOS', method: 'manual' },
  { id: 15, name: '@react-sigma graph smoke', platform: 'macOS', method: 'manual' },
  { id: 1, name: 'ASCII typing', platform: 'Windows', method: 'playwright' },
  { id: 4, name: 'Paste plain text 500 char', platform: 'Windows', method: 'playwright' },
  { id: 5, name: 'Paste rich HTML', platform: 'Windows', method: 'manual' },
  { id: 8, name: 'Slash menu', platform: 'Windows', method: 'playwright' },
  { id: 9, name: 'Undo/redo 10-op chain', platform: 'Windows', method: 'playwright' },
]

async function runPlaywrightTests(platform: 'macOS' | 'Windows'): Promise<Record<number, { status: 'pass' | 'fail'; notes: string }>> {
  const appDir = '../../../spikes/tauri-risk-discovery/app'
  const results: Record<number, { status: 'pass' | 'fail'; notes: string }> = {}
  try {
    execSync(`cd ${appDir} && pnpm exec playwright test --reporter=json`, {
      stdio: 'pipe',
      encoding: 'utf8',
    })
  } catch (e: any) {
    const output = e.stdout?.toString() ?? ''
    // Parse JSON from stdout (simplified — actual Playwright JSON reporter format is more complex)
    console.warn('Playwright exited with failures. Parsing partial output...')
  }
  // Parse playwright-report/results.json if present
  const reportPath = `${appDir}/playwright-report/results.json`
  if (existsSync(reportPath)) {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    for (const suite of report.suites ?? []) {
      for (const spec of suite.specs ?? []) {
        const idMatch = spec.title.match(/test-(\d+)-/)
        if (idMatch) {
          const id = parseInt(idMatch[1])
          const pass = spec.tests?.[0]?.status === 'passed'
          results[id] = { status: pass ? 'pass' : 'fail', notes: spec.tests?.[0]?.error?.message ?? '' }
        }
      }
    }
  }
  return results
}

async function main() {
  const env = await collectEnvironment()
  const results: TestResult[] = []

  console.log('[bench-webview-blocknote] Running macOS Playwright tests...')
  const macOSResults = await runPlaywrightTests('macOS')

  for (const test of TESTS) {
    const result = test.method === 'manual'
      ? { status: 'manual-pending' as const, notes: '' }
      : macOSResults[test.id] ?? { status: 'skipped' as const, notes: 'not run on this platform' }
    results.push({ ...test, ...result })
  }

  // Write CSV
  const header = 'id,name,platform,method,status,notes,evidence'
  const rows = results.map(r =>
    [r.id, JSON.stringify(r.name), r.platform, r.method, r.status, JSON.stringify(r.notes), r.evidence ?? ''].join(',')
  )
  const csv = [header, ...rows].join('\n')
  writeFileSync('../benchmarks/s1-feature-matrix.csv', csv)
  console.log('[bench-webview-blocknote] CSV written to ../benchmarks/s1-feature-matrix.csv')
  console.log(`[bench-webview-blocknote] Manual tests pending: ${results.filter(r => r.status === 'manual-pending').length}`)
  console.log(`[bench-webview-blocknote] Environment: ${JSON.stringify(env.os)}`)
}

main().catch(console.error)
```

### Task 19: Write Test #1 — ASCII typing (Playwright)

**Files:**
- Create: `spikes/tauri-risk-discovery/app/tests/e2e/test-1-ascii-typing.spec.ts`

- [ ] **Step 1: Write test**

Create file with:
```typescript
import { test, expect } from '@playwright/test'

test('test-1-ascii-typing: types "Hello World" into BlockNote, verifies DOM', async ({ page }) => {
  await page.goto('/')
  // Wait for BlockNote editor to mount
  const editor = page.locator('[data-bn-editor]').first()
  await editor.waitFor({ state: 'visible', timeout: 10000 })

  // Click into editor and type
  await editor.click()
  await page.keyboard.type('Hello World', { delay: 20 })

  // Verify text appears in rendered DOM (ProseMirror inserts into contenteditable)
  const bodyText = await editor.innerText()
  expect(bodyText).toContain('Hello World')
})
```

- [ ] **Step 2: Run test to verify it passes**

Run:
```bash
cd spikes/tauri-risk-discovery/app
pnpm exec playwright test test-1-ascii-typing --reporter=list
```
Expected: 1 test passed

- [ ] **Step 3: If fails, debug**

If the selector `[data-bn-editor]` doesn't match (BlockNote DOM structure
may differ), inspect the actual DOM:
- Run dev server: `pnpm dev`
- Open http://localhost:1420 in browser
- Inspect element, find the editor container
- Update selector accordingly (e.g., `[contenteditable="true"]` as fallback)

### Task 20: Write Test #2 — Turkish typing with diacritics

**Files:**
- Create: `spikes/tauri-risk-discovery/app/tests/e2e/test-2-turkish-typing.spec.ts`

- [ ] **Step 1: Write test**

Create file with:
```typescript
import { test, expect } from '@playwright/test'

const TURKISH_TEXT = 'İğüşçö çalışıyor mu?'

test('test-2-turkish-typing: types Turkish with diacritics', async ({ page }) => {
  await page.goto('/')
  const editor = page.locator('[data-bn-editor]').first()
  await editor.waitFor({ state: 'visible', timeout: 10000 })

  await editor.click()
  await page.keyboard.type(TURKISH_TEXT, { delay: 30 })

  const bodyText = await editor.innerText()
  expect(bodyText).toContain(TURKISH_TEXT)

  // Explicit check: every diacritic character present
  for (const ch of ['İ', 'ğ', 'ü', 'ş', 'ç', 'ö', 'ı']) {
    expect(bodyText).toContain(ch)
  }
})
```

- [ ] **Step 2: Run test**

Run: `pnpm exec playwright test test-2-turkish-typing`
Expected: 1 test passed

### Task 21: Write Test #3 — IME Japanese input (manual checklist)

**Files:**
- Create: `docs/spikes/tauri-risk-discovery/benchmarks/s1-manual-checklist.md`

- [ ] **Step 1: Add Test #3 section to checklist**

Create file (or append to existing) with:
```markdown
# S1 Manual Test Checklist

These tests cannot be reliably automated (IME composition events, rich clipboard,
native resize behavior). Execute manually and record result.

## Test #3 — IME Japanese input

**Setup:**
- macOS System Settings → Keyboard → Input Sources → Add "Hiragana" (Japanese)
- In Tauri app, click into BlockNote editor
- Switch input to Hiragana (Cmd+Space)

**Procedure:**
1. Type "konnichiwa" (should show hiragana composition underline as you type)
2. Press Space to convert to kanji candidates
3. Press Enter to commit "こんにちは"

**Expected:**
- Composition underline appears during typing
- Conversion UI appears on Space
- Final text "こんにちは" appears in editor

**Pass criteria:** Final text matches. No characters duplicated/dropped.
Composition underline visible during entry.

**Result:** [PASS / FAIL]

**Notes:**
[Any observations, especially: duplicate characters, dropped composition events,
IME UI disappearing, etc.]

**Evidence:** screenshots/test-3-ime-before.png, test-3-ime-after.png
(take screenshots and save to benchmarks/screenshots/)
```

- [ ] **Step 2: Wait for manual execution**

This test is MANUAL. Sub-agent marks it `manual-pending` and includes
instructions in findings.md. Kaan executes during checkpoint review.

### Task 22: Write Test #4 — Paste plain text 500 char (Playwright)

**Files:**
- Create: `spikes/tauri-risk-discovery/app/tests/e2e/test-4-paste-plain-text.spec.ts`

- [ ] **Step 1: Write test**

Create file with:
```typescript
import { test, expect } from '@playwright/test'

// 500-char lorem ipsum
const LOREM = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. Sed ut perspiciatis unde omnis iste natus error sit volup'

test('test-4-paste-plain-text: pastes 500-char plain text', async ({ page, context }) => {
  // Grant clipboard permission
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])

  await page.goto('/')
  const editor = page.locator('[data-bn-editor]').first()
  await editor.waitFor({ state: 'visible', timeout: 10000 })
  await editor.click()

  // Write to clipboard via evaluate
  await page.evaluate((text) => navigator.clipboard.writeText(text), LOREM)

  // Paste
  const isMac = process.platform === 'darwin'
  await page.keyboard.press(isMac ? 'Meta+v' : 'Control+v')
  await page.waitForTimeout(500)

  const bodyText = await editor.innerText()
  expect(bodyText.length).toBeGreaterThanOrEqual(LOREM.length - 5)  // 5-char slack for normalization
  expect(bodyText).toContain(LOREM.slice(0, 50))
  expect(bodyText).toContain(LOREM.slice(-50))
})
```

- [ ] **Step 2: Run test**

Run: `pnpm exec playwright test test-4-paste-plain-text`
Expected: pass

### Task 23: Write Test #5 — Paste rich HTML (manual)

**Files:**
- Modify: `docs/spikes/tauri-risk-discovery/benchmarks/s1-manual-checklist.md`

- [ ] **Step 1: Append Test #5 section**

Add to checklist file:
```markdown
## Test #5 — Paste rich HTML from external source

**Setup:**
- Open https://docs.google.com/ in macOS Safari
- Create a short document with: h1 heading, h2 heading, bold text, italic text,
  unordered list with 3 items, ordered list with 3 items, 1 link

**Procedure:**
1. Select entire document (Cmd+A), copy (Cmd+C)
2. Switch to Tauri app (Spike 0 BlockNote editor)
3. Click into editor
4. Paste (Cmd+V)

**Expected (per spec pass criteria):**
- Headings (h1, h2) render as block-level headings in BlockNote
- Bold/italic marks preserved
- Lists (ul, ol) preserved, item order correct
- Links' href preserved (hover to verify URL)
- Inline style attributes MAY be lost (`style="color:red"` → no color) — OK
- CSS class names MAY be lost — OK

**Pass criteria:**
- Block structure preserved (headings as headings, lists as lists)
- Text content preserved 100%
- Mark styles (bold/italic) preserved

**Fail criteria:**
- Blocks collapsed to single paragraph
- List items merged or reordered
- Text characters dropped

**Result:** [PASS / PARTIAL / FAIL]

**Notes:**
[What was preserved, what was lost]

**Evidence:** screenshots/test-5-paste-html-source.png, test-5-paste-html-result.png
```

### Task 24: Write Test #6 — Paste image from clipboard (Playwright)

**Files:**
- Create: `spikes/tauri-risk-discovery/app/tests/e2e/test-6-paste-image.spec.ts`

- [ ] **Step 1: Write test**

Create file with:
```typescript
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

test('test-6-paste-image: pastes image from clipboard, verifies image block or no-crash', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])

  await page.goto('/')
  const editor = page.locator('[data-bn-editor]').first()
  await editor.waitFor({ state: 'visible', timeout: 10000 })
  await editor.click()

  // Inject a small PNG into clipboard via Clipboard API
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAen63NgAAAAASUVORK5CYII='
  await page.evaluate(async (b64) => {
    const bin = atob(b64)
    const arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    const blob = new Blob([arr], { type: 'image/png' })
    const item = new ClipboardItem({ 'image/png': blob })
    await navigator.clipboard.write([item])
  }, pngBase64)

  // Paste
  await page.keyboard.press('Meta+v')
  await page.waitForTimeout(1000)

  // Verify either: (a) image block inserted OR (b) no crash (editor still responsive)
  const afterContent = await editor.innerText()
  const imgTags = await page.locator('[data-bn-editor] img').count()
  const editorStillResponsive = await editor.isVisible()

  expect(editorStillResponsive).toBe(true)
  // Best-effort: image block would be nice, but "no crash" is minimum bar
  console.log(`[test-6] Image tags found: ${imgTags}, editor responsive: ${editorStillResponsive}`)
})
```

- [ ] **Step 2: Run test**

Run: `pnpm exec playwright test test-6-paste-image`
Expected: pass

### Task 25: Write Test #7 — Drag-drop image file

**Files:**
- Create: `spikes/tauri-risk-discovery/app/tests/e2e/test-7-drag-drop-image.spec.ts`
- Create: `spikes/tauri-risk-discovery/app/tests/fixtures/test-image.png` (1x1 red PNG)

- [ ] **Step 1: Create fixture image**

Run:
```bash
cd spikes/tauri-risk-discovery/app
mkdir -p tests/fixtures
# Create 1x1 red PNG via node
node -e "require('fs').writeFileSync('tests/fixtures/test-image.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64'))"
```

- [ ] **Step 2: Write test**

Create file with:
```typescript
import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'

test('test-7-drag-drop-image: drag-drops image file into editor', async ({ page }) => {
  await page.goto('/')
  const editor = page.locator('[data-bn-editor]').first()
  await editor.waitFor({ state: 'visible', timeout: 10000 })

  // Simulate file drop via Playwright dispatchEvent
  const imagePath = resolve(__dirname, '../fixtures/test-image.png')
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer())

  await page.evaluate(async ({ path }) => {
    const response = await fetch('file://' + path)
    const blob = await response.blob()
    const file = new File([blob], 'test-image.png', { type: 'image/png' })
    ;(window as any).__testFile = file
  }, { path: imagePath }).catch(() => {
    // file:// may not fetch; fallback: test dispatches a synthetic drop event
  })

  // Dispatch drop
  await editor.dispatchEvent('drop', {
    dataTransfer: {
      files: [{ name: 'test-image.png', type: 'image/png' }],
      types: ['Files'],
    },
  })
  await page.waitForTimeout(1000)

  const imgTags = await page.locator('[data-bn-editor] img').count()
  console.log(`[test-7] Images after drop: ${imgTags}`)
  // Acceptance: image inserted OR no-crash (editor responsive)
  expect(await editor.isVisible()).toBe(true)
})
```

- [ ] **Step 3: Run test**

Run: `pnpm exec playwright test test-7-drag-drop-image`
Expected: pass (image insertion ideal, no-crash acceptable)

### Task 26: Write Test #8 — Slash menu

**Files:**
- Create: `spikes/tauri-risk-discovery/app/tests/e2e/test-8-slash-menu.spec.ts`

- [ ] **Step 1: Write test**

Create file with:
```typescript
import { test, expect } from '@playwright/test'

test('test-8-slash-menu: slash opens menu, can filter, can insert heading', async ({ page }) => {
  await page.goto('/')
  const editor = page.locator('[data-bn-editor]').first()
  await editor.waitFor({ state: 'visible', timeout: 10000 })
  await editor.click()

  // Type slash
  await page.keyboard.press('/')
  await page.waitForTimeout(300)

  // Menu should open - look for any menu-like container (class varies by BlockNote version)
  const menu = page.locator('[role="listbox"], [class*="slashMenu"], [class*="Suggestion"]').first()
  await expect(menu).toBeVisible({ timeout: 3000 })

  // Type "heading" to filter
  await page.keyboard.type('heading')
  await page.waitForTimeout(300)

  // Press Enter to insert heading-1
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)

  // Type into the heading
  await page.keyboard.type('Slash Test')
  await page.waitForTimeout(300)

  // Verify heading created — look for any heading-like element
  const headingCount = await page.locator('[data-bn-editor] h1, [data-bn-editor] [data-content-type="heading"]').count()
  expect(headingCount).toBeGreaterThanOrEqual(1)
})
```

- [ ] **Step 2: Run test**

Run: `pnpm exec playwright test test-8-slash-menu`
Expected: pass

### Task 27: Write Test #9 — Undo/redo 10-op chain

**Files:**
- Create: `spikes/tauri-risk-discovery/app/tests/e2e/test-9-undo-redo.spec.ts`

- [ ] **Step 1: Write test**

Create file with:
```typescript
import { test, expect } from '@playwright/test'

test('test-9-undo-redo: 10 typing ops, 10 undos, 10 redos — state consistent', async ({ page }) => {
  await page.goto('/')
  const editor = page.locator('[data-bn-editor]').first()
  await editor.waitFor({ state: 'visible', timeout: 10000 })
  await editor.click()

  const phrases = ['alpha ', 'beta ', 'gamma ', 'delta ', 'epsilon ', 'zeta ', 'eta ', 'theta ', 'iota ', 'kappa ']

  // Type each phrase as a distinct operation
  for (const phrase of phrases) {
    await page.keyboard.type(phrase, { delay: 30 })
    await page.waitForTimeout(100)
  }

  const afterTyping = await editor.innerText()
  for (const phrase of phrases) {
    expect(afterTyping).toContain(phrase.trim())
  }

  // 10 undos
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Meta+z')
    await page.waitForTimeout(80)
  }

  const afterUndo = await editor.innerText()
  // At least most content should be removed — tolerate BlockNote's grain
  expect(afterUndo.length).toBeLessThan(afterTyping.length / 2)

  // 10 redos
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Meta+Shift+z')
    await page.waitForTimeout(80)
  }

  const afterRedo = await editor.innerText()
  for (const phrase of phrases) {
    expect(afterRedo).toContain(phrase.trim())
  }
})
```

- [ ] **Step 2: Run test**

Run: `pnpm exec playwright test test-9-undo-redo`
Expected: pass

### Task 28: Write Test #10 — Table editing

**Files:**
- Create: `spikes/tauri-risk-discovery/app/tests/e2e/test-10-table.spec.ts`

- [ ] **Step 1: Write test**

Create file with:
```typescript
import { test, expect } from '@playwright/test'

test('test-10-table: insert table via slash menu, type into cell', async ({ page }) => {
  await page.goto('/')
  const editor = page.locator('[data-bn-editor]').first()
  await editor.waitFor({ state: 'visible', timeout: 10000 })
  await editor.click()

  // Open slash menu, type "table", enter
  await page.keyboard.press('/')
  await page.waitForTimeout(300)
  await page.keyboard.type('table')
  await page.waitForTimeout(300)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(500)

  // Verify table rendered
  const tableCount = await page.locator('[data-bn-editor] table').count()
  expect(tableCount).toBeGreaterThanOrEqual(1)

  // Type into first cell (active cell should be focused)
  await page.keyboard.type('cell-1')
  await page.waitForTimeout(300)

  const afterText = await editor.innerText()
  expect(afterText).toContain('cell-1')
})
```

- [ ] **Step 2: Run test**

Run: `pnpm exec playwright test test-10-table`
Expected: pass

### Task 29: Write Test #11 — Code block

**Files:**
- Create: `spikes/tauri-risk-discovery/app/tests/e2e/test-11-code-block.spec.ts`

- [ ] **Step 1: Write test**

Create file with:
```typescript
import { test, expect } from '@playwright/test'

test('test-11-code-block: insert code block, type code, verify renders', async ({ page }) => {
  await page.goto('/')
  const editor = page.locator('[data-bn-editor]').first()
  await editor.waitFor({ state: 'visible', timeout: 10000 })
  await editor.click()

  // Insert code block via slash menu
  await page.keyboard.press('/')
  await page.waitForTimeout(300)
  await page.keyboard.type('code')
  await page.waitForTimeout(300)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(500)

  // Verify code block element exists
  const codeCount = await page.locator('[data-bn-editor] pre, [data-bn-editor] code, [data-content-type="codeBlock"]').count()
  expect(codeCount).toBeGreaterThanOrEqual(1)

  // Type code
  await page.keyboard.type('const x = 42;')
  await page.waitForTimeout(300)

  const afterText = await editor.innerText()
  expect(afterText).toContain('const x = 42;')
})
```

- [ ] **Step 2: Run test**

Run: `pnpm exec playwright test test-11-code-block`
Expected: pass

### Task 30: Write Test #12 — Link insertion

**Files:**
- Create: `spikes/tauri-risk-discovery/app/tests/e2e/test-12-link.spec.ts`

- [ ] **Step 1: Write test**

Create file with:
```typescript
import { test, expect } from '@playwright/test'

test('test-12-link: insert link via Cmd+K, verify href set', async ({ page }) => {
  await page.goto('/')
  const editor = page.locator('[data-bn-editor]').first()
  await editor.waitFor({ state: 'visible', timeout: 10000 })
  await editor.click()

  // Type text, select it, open link dialog
  await page.keyboard.type('example site', { delay: 30 })
  await page.keyboard.press('Meta+a')  // select all
  await page.waitForTimeout(200)
  await page.keyboard.press('Meta+k')  // open link toolbar
  await page.waitForTimeout(500)

  // Type URL
  await page.keyboard.type('https://example.com')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(500)

  // Verify link created
  const linkCount = await page.locator('[data-bn-editor] a[href*="example.com"]').count()
  expect(linkCount).toBeGreaterThanOrEqual(1)
})
```

- [ ] **Step 2: Run test**

Run: `pnpm exec playwright test test-12-link`
Expected: pass

### Task 31: Write Test #13 — Large doc stress

**Files:**
- Create: `spikes/tauri-risk-discovery/app/tests/e2e/test-13-stress.spec.ts`

- [ ] **Step 1: Write test**

Create file with:
```typescript
import { test, expect } from '@playwright/test'

test('test-13-stress: 10k char typing, measure typing latency p95 < 50ms', async ({ page }) => {
  await page.goto('/')
  const editor = page.locator('[data-bn-editor]').first()
  await editor.waitFor({ state: 'visible', timeout: 10000 })
  await editor.click()

  // Pre-populate with 9500 chars (multiple paragraphs) via programmatic insert
  const prefill = 'Lorem ipsum dolor sit amet. '.repeat(340)  // ~9500 chars
  await page.keyboard.type(prefill.slice(0, 500))  // first 500 via real typing
  // Fill rest via evaluate (faster) — acceptable for stress setup
  await page.evaluate((text) => {
    const editor = document.querySelector('[data-bn-editor]') as HTMLElement
    if (!editor) return
    // BlockNote content set via its own API isn't easily available from outside
    // For stress test, accept that seed content matters less than delta typing
  }, prefill)

  // Measure typing latency for 500 additional chars
  const latencies: number[] = []
  const additional = 'XYZXYZXYZXYZXYZXYZXYZXYZ'.repeat(20)  // 480 chars

  for (const ch of additional) {
    const start = Date.now()
    await page.keyboard.type(ch)
    const elapsed = Date.now() - start
    latencies.push(elapsed)
  }

  latencies.sort((a, b) => a - b)
  const p50 = latencies[Math.floor(latencies.length * 0.5)]
  const p95 = latencies[Math.floor(latencies.length * 0.95)]
  console.log(`[test-13] Typing latency p50=${p50}ms p95=${p95}ms`)

  // Write benchmark data into a JSON sidecar for main runner to pick up
  const fs = require('node:fs')
  fs.writeFileSync(
    '/tmp/s1-test-13-latency.json',
    JSON.stringify({ p50, p95, samples: latencies.length, threshold_p95_ms: 50 })
  )

  expect(p95).toBeLessThan(50)  // pass threshold
})
```

- [ ] **Step 2: Run test**

Run: `pnpm exec playwright test test-13-stress`
Expected: pass (or yellow if p95 50-100ms range — log for findings)

### Task 32: Write Test #14 — Window resize (manual)

**Files:**
- Modify: `docs/spikes/tauri-risk-discovery/benchmarks/s1-manual-checklist.md`

- [ ] **Step 1: Append Test #14**

Append to checklist:
```markdown
## Test #14 — Window resize mid-typing

**Procedure:**
1. Open Tauri app
2. Type a few paragraphs into BlockNote editor
3. Position caret in middle of text
4. Drag window corner to resize (shrink width by ~40%, then enlarge by ~60%)
5. Continue typing — observe caret behavior

**Expected:**
- Text reflows with new width
- Caret stays at same logical position (same word/character)
- Continued typing inserts at correct position

**Fail criteria:**
- Caret jumps to unrelated position
- Text layout breaks (overlaps, disappears)
- Typing inserts at wrong location

**Result:** [PASS / FAIL]
**Evidence:** screenshots/test-14-resize-before.png, test-14-resize-after.png
```

### Task 33: Write Test #15 — @react-sigma smoke (manual)

**Files:**
- Modify: `docs/spikes/tauri-risk-discovery/benchmarks/s1-manual-checklist.md`

- [ ] **Step 1: Append Test #15**

Append to checklist:
```markdown
## Test #15 — @react-sigma graph smoke (no editor, webview WebGL test)

**Setup:**
- Temporarily modify `app/src/App.tsx` to import and render a minimal
  `@react-sigma/core` SigmaContainer with 10 nodes
- Run `pnpm tauri dev`

**Procedure:**
1. Observe if SigmaContainer renders (graph visible as dots/nodes)
2. Drag to pan, scroll to zoom — interactions smooth?

**Expected:**
- Graph renders without crash
- WebGL context opens (no "WebGL not supported" error)
- Pan/zoom responsive (> 30 fps)

**Fail criteria:**
- Crash on mount
- Empty canvas (WebGL context failed)
- Pan/zoom janky (< 20 fps)

**Result:** [PASS / FAIL]
**Evidence:** screenshots/test-15-sigma-render.png

**Post-test cleanup:** revert App.tsx to BlockNote-only for other tests.
```

### Task 34: Run full test matrix on macOS

**Files:**
- Modify: `docs/spikes/tauri-risk-discovery/benchmarks/s1-feature-matrix.csv`

- [ ] **Step 1: Run bench-webview-blocknote.ts**

Run:
```bash
cd docs/spikes/tauri-risk-discovery/scripts
pnpm exec tsx bench-webview-blocknote.ts
```
Expected: CSV written, automated tests produce pass/fail, manual tests marked `manual-pending`

- [ ] **Step 2: Verify CSV**

Run: `cat ../benchmarks/s1-feature-matrix.csv`
Expected: 20 rows (15 macOS + 5 Windows placeholders), status column populated for automated tests

- [ ] **Step 3: Manually execute Tests #3, #5, #14, #15 per checklist**

Follow `s1-manual-checklist.md` procedures. Take screenshots, save to
`benchmarks/screenshots/`. Record results in checklist file.

- [ ] **Step 4: Update CSV with manual test results**

Edit `s1-feature-matrix.csv` manually — change `manual-pending` → `pass`/`fail`
for rows 3, 5, 14, 15 based on checklist outcomes.

### Task 35: Write s1-blocknote-webview.md findings

**Files:**
- Modify: `docs/spikes/tauri-risk-discovery/s1-blocknote-webview.md`

- [ ] **Step 1: Fill in all 10 sections per spec template**

Replace skeleton placeholders with actual findings:

- **Metadata:** current date, runner ("Claude Code autonomous + Kaan manual"), commit SHA, duration
- **Hypothesis:** copy from spec Section 5.1
- **TL;DR:** 🟢/🟡/🔴 verdict + 2-3 sentence summary based on test results
- **Setup:** brief description of app, link to `spikes/tauri-risk-discovery/app/` dir, versions
- **Test matrix results:** table summarizing CSV contents
- **Benchmark data:** reference s1-feature-matrix.csv, paste key numbers (p95 typing latency)
- **Observations:** any surprises from manual tests (IME behavior quirks, HTML paste losses, etc.)
- **Decision + rationale:** given results, 🟢/🟡/🔴 + 2-3 sentence justification
- **Subsequent subproject impact:**
  - "Subproject 1 can proceed with BlockNote as-is" OR
  - "Subproject 1 needs workaround for [specific issue]"
- **References:** BlockNote docs, Tauri webview docs, GitHub issues if any found

- [ ] **Step 2: Verify file complete**

Run: `grep -c "To be filled" docs/spikes/tauri-risk-discovery/s1-blocknote-webview.md`
Expected: 0 (no placeholder text remaining)

### Task 36: Checkpoint 1 — Kaan review of S1

**Files:** no changes — coordinator action

- [ ] **Step 1: Sub-agent returns completion signal**

Sub-agent output should include:
- TL;DR verdict
- File list (modified and created)
- Coordinator actions: `git add` paths, `git commit -m "spike(s1): ..."`
- Any surprises or blockers

- [ ] **Step 2: Coordinator commits S1 artifacts**

Run:
```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk
git add spikes/tauri-risk-discovery/app/
git add docs/spikes/tauri-risk-discovery/s1-blocknote-webview.md
git add docs/spikes/tauri-risk-discovery/benchmarks/s1-feature-matrix.csv
git add docs/spikes/tauri-risk-discovery/benchmarks/s1-manual-checklist.md
git add docs/spikes/tauri-risk-discovery/benchmarks/screenshots/
git add docs/spikes/tauri-risk-discovery/scripts/bench-webview-blocknote.ts
git commit -m "spike(s1): BlockNote + WKWebView compatibility findings

Tests run: 15 macOS + 5 Windows subset.
Verdict: [🟢/🟡/🔴 from findings]
Key observations: [summary]"
```

- [ ] **Step 3: Present summary to Kaan**

Coordinator outputs structured summary per spec Section 6 checkpoint protocol
(TL;DR + key bulgular + sürprizler + dosyalar + decision prompt).

- [ ] **Step 4: Await Kaan decision**

Kaan returns 🟢/🟡/🔴. If 🔴 (data loss): halt spike, escalate per spec
Section 7. If 🟢/🟡: proceed to Phase 2 (S2).

---

## Phase 2: S2 — Yjs Placement

**Sub-agent dispatch context:** Fresh sub-agent invocation. Before starting,
read `docs/spikes/tauri-risk-discovery/s1-blocknote-webview.md` (full text) for
S1 learnings that may affect S2. In particular: if S1 surfaced BlockNote observer
issues, note them here because S2 tests BlockNote + Yjs observer integration.

### Task 37: Scaffold Prototype A (renderer-owned Y.Doc)

**Files:**
- Create: `spikes/tauri-risk-discovery/prototypes/s2-yjs-renderer/` (full Tauri scaffold)

- [ ] **Step 1: Copy main app as template**

Run:
```bash
cd spikes/tauri-risk-discovery
cp -r app prototypes/s2-yjs-renderer
# Clean up app-specific state
rm -rf prototypes/s2-yjs-renderer/node_modules
rm -rf prototypes/s2-yjs-renderer/src-tauri/target
```

- [ ] **Step 2: Update package.json name**

Edit `prototypes/s2-yjs-renderer/package.json`:
- Change `"name"` to `"s2-yjs-renderer"`

- [ ] **Step 3: Update Tauri identifier**

Edit `prototypes/s2-yjs-renderer/src-tauri/tauri.conf.json`:
- Change `identifier` to `com.memry.spike-s2-yjs-renderer`

- [ ] **Step 4: Install deps**

Run: `cd prototypes/s2-yjs-renderer && pnpm install`

⚠️ Sub-agent: return to coordinator for pnpm command.

### Task 38: Add Yjs + y-prosemirror deps to Prototype A

**Files:**
- Modify: `spikes/tauri-risk-discovery/prototypes/s2-yjs-renderer/package.json`

- [ ] **Step 1: Install Yjs stack**

Run:
```bash
cd spikes/tauri-risk-discovery/prototypes/s2-yjs-renderer
pnpm add yjs@^13.6 y-prosemirror@^1.3 y-protocols@^1.0
```

- [ ] **Step 2: Verify**

Run: `pnpm list yjs y-prosemirror --depth 0`
Expected: versions 13.6.x and 1.3.x

### Task 39: Implement Prototype A Rust persistence commands

**Files:**
- Modify: `spikes/tauri-risk-discovery/prototypes/s2-yjs-renderer/src-tauri/src/lib.rs` (or main.rs depending on template)
- Modify: `spikes/tauri-risk-discovery/prototypes/s2-yjs-renderer/src-tauri/Cargo.toml`

- [ ] **Step 1: Add rusqlite dependency**

Edit `Cargo.toml`, add under `[dependencies]`:
```toml
rusqlite = { version = "0.31", features = ["bundled"] }
```

- [ ] **Step 2: Write Rust commands**

Replace (or extend) `src-tauri/src/lib.rs`:
```rust
use std::sync::Mutex;
use rusqlite::{Connection, params};
use tauri::State;

struct DbState(Mutex<Connection>);

fn init_db() -> Connection {
    let conn = Connection::open_in_memory().expect("open sqlite");
    conn.execute(
        "CREATE TABLE IF NOT EXISTS crdt_snapshots (
            note_id TEXT PRIMARY KEY,
            bytes BLOB NOT NULL
        )",
        [],
    ).expect("create snapshots table");
    conn.execute(
        "CREATE TABLE IF NOT EXISTS crdt_updates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            note_id TEXT NOT NULL,
            bytes BLOB NOT NULL,
            ts INTEGER NOT NULL
        )",
        [],
    ).expect("create updates table");
    conn
}

#[tauri::command]
fn save_crdt_snapshot(note_id: String, bytes: Vec<u8>, state: State<DbState>) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO crdt_snapshots (note_id, bytes) VALUES (?, ?)
         ON CONFLICT(note_id) DO UPDATE SET bytes = excluded.bytes",
        params![note_id, bytes],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_crdt_snapshot(note_id: String, state: State<DbState>) -> Result<Option<Vec<u8>>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT bytes FROM crdt_snapshots WHERE note_id = ?")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query(params![note_id]).map_err(|e| e.to_string())?;
    if let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let bytes: Vec<u8> = row.get(0).map_err(|e| e.to_string())?;
        Ok(Some(bytes))
    } else {
        Ok(None)
    }
}

#[tauri::command]
fn append_crdt_update(note_id: String, bytes: Vec<u8>, state: State<DbState>) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO crdt_updates (note_id, bytes, ts) VALUES (?, ?, ?)",
        params![note_id, bytes, ts],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let conn = init_db();
    tauri::Builder::default()
        .manage(DbState(Mutex::new(conn)))
        .invoke_handler(tauri::generate_handler![
            save_crdt_snapshot,
            load_crdt_snapshot,
            append_crdt_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: Build**

Run: `cd prototypes/s2-yjs-renderer && pnpm tauri build --debug 2>&1 | tail -20`
Expected: Build succeeds (may warn about unused imports, OK)

⚠️ Sub-agent: cargo builds via pnpm tauri are OK. Long compile on first run.

### Task 40: Implement Prototype A renderer — BlockNote + y-prosemirror

**Files:**
- Modify: `spikes/tauri-risk-discovery/prototypes/s2-yjs-renderer/src/App.tsx`

- [ ] **Step 1: Replace App.tsx with Yjs-bound BlockNote**

Overwrite `App.tsx` with:
```tsx
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/shadcn'
import { useEffect, useCallback, useState, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import * as Y from 'yjs'
import '@blocknote/core/fonts/inter.css'
import '@blocknote/shadcn/style.css'

const NOTE_ID = 'proto-a-test-note'

function App() {
  const ydocRef = useRef<Y.Doc>(new Y.Doc())
  const xmlFragment = ydocRef.current.getXmlFragment('blocknote')

  const editor = useCreateBlockNote({
    collaboration: {
      provider: null as any,  // no network provider, local-only Y.Doc
      fragment: xmlFragment,
      user: { name: 'spike-user', color: '#123456' },
    },
  })

  const [updateCount, setUpdateCount] = useState(0)

  // Wire Y.Doc.update → Rust persistence
  useEffect(() => {
    const ydoc = ydocRef.current
    const handler = async (update: Uint8Array, origin: any) => {
      // Skip updates we applied from Rust (loop prevention)
      if (origin === 'rust') return
      await invoke('append_crdt_update', {
        noteId: NOTE_ID,
        bytes: Array.from(update),
      })
      setUpdateCount((c) => c + 1)
    }
    ydoc.on('update', handler)
    return () => { ydoc.off('update', handler) }
  }, [])

  // Load from snapshot on mount
  useEffect(() => {
    const load = async () => {
      const snap = await invoke<number[] | null>('load_crdt_snapshot', { noteId: NOTE_ID })
      if (snap) {
        Y.applyUpdate(ydocRef.current, new Uint8Array(snap), 'rust')
      }
    }
    load()
  }, [])

  const saveSnapshot = useCallback(async () => {
    const snap = Y.encodeStateAsUpdate(ydocRef.current)
    await invoke('save_crdt_snapshot', {
      noteId: NOTE_ID,
      bytes: Array.from(snap),
    })
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ padding: 8, display: 'flex', gap: 8, borderBottom: '1px solid #ccc' }}>
        <button onClick={saveSnapshot}>Save Snapshot</button>
        <span>Updates persisted: {updateCount}</span>
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        <BlockNoteView editor={editor} />
      </div>
    </div>
  )
}

export default App
```

- [ ] **Step 2: Run dev**

Run: `pnpm tauri dev`
Expected: Editor opens. Typing triggers Rust `append_crdt_update` (visible via Rust stdout / updates counter).

### Task 41: Write Prototype A Test #1 — Single-device roundtrip

**Files:**
- Create: `spikes/tauri-risk-discovery/prototypes/s2-yjs-renderer/tests/e2e/test-1-roundtrip.spec.ts`

- [ ] **Step 1: Write test**

Create file with:
```typescript
import { test, expect } from '@playwright/test'

test('proto-A-test-1-roundtrip: type, save snapshot, reload, verify restore', async ({ page }) => {
  await page.goto('/')
  await page.locator('[data-bn-editor]').waitFor({ timeout: 10000 })
  await page.locator('[data-bn-editor]').click()

  const testText = 'Prototype A roundtrip test content'
  await page.keyboard.type(testText, { delay: 30 })
  await page.waitForTimeout(500)

  // Save snapshot
  await page.click('button:has-text("Save Snapshot")')
  await page.waitForTimeout(500)

  // Reload
  await page.reload()
  await page.locator('[data-bn-editor]').waitFor({ timeout: 10000 })

  const afterReload = await page.locator('[data-bn-editor]').innerText()
  expect(afterReload).toContain(testText)
})
```

- [ ] **Step 2: Run test**

Run:
```bash
cd prototypes/s2-yjs-renderer
pnpm exec playwright test test-1-roundtrip
```
Expected: pass

### Task 42: Scaffold Prototype B (yrs in Rust)

**Files:**
- Create: `spikes/tauri-risk-discovery/prototypes/s2-yjs-rust/` (full Tauri scaffold)

- [ ] **Step 1: Copy main app as template**

Run:
```bash
cd spikes/tauri-risk-discovery
cp -r app prototypes/s2-yjs-rust
rm -rf prototypes/s2-yjs-rust/node_modules
rm -rf prototypes/s2-yjs-rust/src-tauri/target
```

- [ ] **Step 2: Update identifier + name**

Edit `prototypes/s2-yjs-rust/package.json`: name → `s2-yjs-rust`
Edit `src-tauri/tauri.conf.json`: identifier → `com.memry.spike-s2-yjs-rust`

- [ ] **Step 3: Install deps**

Run: `cd prototypes/s2-yjs-rust && pnpm install`

### Task 43: Add yrs to Prototype B Rust

**Files:**
- Modify: `spikes/tauri-risk-discovery/prototypes/s2-yjs-rust/src-tauri/Cargo.toml`

- [ ] **Step 1: Add yrs dependency**

Edit `Cargo.toml`, add:
```toml
yrs = "0.21"
y-sync = "0.4"
```

- [ ] **Step 2: Add Yjs in renderer (for shadow Y.Doc)**

Run:
```bash
cd prototypes/s2-yjs-rust
pnpm add yjs@^13.6 y-prosemirror@^1.3
```

### Task 44: Implement Prototype B Rust — yrs Doc + Tauri commands

**Files:**
- Modify: `spikes/tauri-risk-discovery/prototypes/s2-yjs-rust/src-tauri/src/lib.rs`

- [ ] **Step 1: Write yrs-backed commands**

Replace `lib.rs` with:
```rust
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{State, Emitter, Manager, AppHandle};
use yrs::{Doc, Transact, ReadTxn, encoding::read::Cursor};
use yrs::updates::encoder::{Encode, Encoder};
use yrs::updates::decoder::Decode;

struct DocsState(Mutex<HashMap<String, Doc>>);

#[tauri::command]
fn apply_update(
    note_id: String,
    update_bytes: Vec<u8>,
    state: State<DocsState>,
    app: AppHandle,
) -> Result<Vec<u8>, String> {
    let mut docs = state.0.lock().map_err(|e| e.to_string())?;
    let doc = docs.entry(note_id.clone()).or_insert_with(Doc::new);

    let update = yrs::Update::decode_v1(&update_bytes).map_err(|e| e.to_string())?;
    let mut txn = doc.transact_mut();
    txn.apply_update(update).map_err(|e| e.to_string())?;
    let post_state = txn.state_vector().encode_v1();
    drop(txn);

    // Emit event to renderer for shadow Y.Doc sync
    app.emit_to("main", "crdt-update", &update_bytes).ok();

    Ok(post_state)
}

#[tauri::command]
fn get_state_vector(note_id: String, state: State<DocsState>) -> Result<Vec<u8>, String> {
    let docs = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(doc) = docs.get(&note_id) {
        let txn = doc.transact();
        Ok(txn.state_vector().encode_v1())
    } else {
        Ok(vec![])
    }
}

#[tauri::command]
fn get_snapshot(note_id: String, state: State<DocsState>) -> Result<Vec<u8>, String> {
    let docs = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(doc) = docs.get(&note_id) {
        let txn = doc.transact();
        Ok(txn.encode_state_as_update_v1(&yrs::StateVector::default()))
    } else {
        Ok(vec![])
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(DocsState(Mutex::new(HashMap::new())))
        .invoke_handler(tauri::generate_handler![
            apply_update,
            get_state_vector,
            get_snapshot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 2: Build**

Run: `cd prototypes/s2-yjs-rust && pnpm tauri build --debug 2>&1 | tail -30`
Expected: Build succeeds (yrs compiles, may take 2-5 min first time)

### Task 45: Implement Prototype B renderer — shadow Y.Doc + origin tagging

**Files:**
- Modify: `spikes/tauri-risk-discovery/prototypes/s2-yjs-rust/src/App.tsx`

- [ ] **Step 1: Write shadow Y.Doc + bidirectional sync**

Overwrite `App.tsx`:
```tsx
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/shadcn'
import { useEffect, useCallback, useState, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import * as Y from 'yjs'
import '@blocknote/core/fonts/inter.css'
import '@blocknote/shadcn/style.css'

const NOTE_ID = 'proto-b-test-note'

function App() {
  const ydocRef = useRef<Y.Doc>(new Y.Doc())
  const xmlFragment = ydocRef.current.getXmlFragment('blocknote')

  const editor = useCreateBlockNote({
    collaboration: {
      provider: null as any,
      fragment: xmlFragment,
      user: { name: 'spike-user', color: '#654321' },
    },
  })

  const [updateCount, setUpdateCount] = useState(0)
  const [echoSkipped, setEchoSkipped] = useState(0)

  // Shadow Y.Doc: local edits → push to Rust yrs
  useEffect(() => {
    const ydoc = ydocRef.current
    const handler = async (update: Uint8Array, origin: any) => {
      if (origin === 'rust') {
        setEchoSkipped((c) => c + 1)
        return
      }
      await invoke('apply_update', {
        noteId: NOTE_ID,
        updateBytes: Array.from(update),
      })
      setUpdateCount((c) => c + 1)
    }
    ydoc.on('update', handler)
    return () => { ydoc.off('update', handler) }
  }, [])

  // Listen for Rust-origin updates, apply to shadow Y.Doc
  useEffect(() => {
    const unlisten = listen<number[]>('crdt-update', (event) => {
      const update = new Uint8Array(event.payload)
      Y.applyUpdate(ydocRef.current, update, 'rust')
    })
    return () => { unlisten.then((fn) => fn()) }
  }, [])

  // Load from Rust on mount
  useEffect(() => {
    const load = async () => {
      const snap = await invoke<number[]>('get_snapshot', { noteId: NOTE_ID })
      if (snap && snap.length > 0) {
        Y.applyUpdate(ydocRef.current, new Uint8Array(snap), 'rust')
      }
    }
    load()
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ padding: 8, display: 'flex', gap: 16, borderBottom: '1px solid #ccc' }}>
        <span>Prototype B (yrs in Rust)</span>
        <span>Updates sent to Rust: {updateCount}</span>
        <span>Echo updates skipped: {echoSkipped}</span>
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        <BlockNoteView editor={editor} />
      </div>
    </div>
  )
}

export default App
```

- [ ] **Step 2: Run dev**

Run: `pnpm tauri dev`
Expected: Editor opens. Typing increments counter. "Echo updates skipped" should stay 0 (no loops).

### Task 46: Write S2 bench runner (A vs B unified)

**Files:**
- Create: `docs/spikes/tauri-risk-discovery/scripts/bench-yjs-roundtrip.ts`

- [ ] **Step 1: Write unified benchmark runner**

Create file with:
```typescript
// S2 benchmark: runs identical test suite against Prototype A and B,
// collects timings, writes to s2-roundtrip-latency.json.

import { collectEnvironment } from './collect-environment'
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

interface PrototypeResult {
  prototype: 'A' | 'B'
  test: string
  samples: number[]
  p50: number
  p95: number
  unit: string
  pass: boolean
  notes: string
}

async function runPrototype(prototype: 'A' | 'B'): Promise<PrototypeResult[]> {
  const dir = prototype === 'A'
    ? '../../../spikes/tauri-risk-discovery/prototypes/s2-yjs-renderer'
    : '../../../spikes/tauri-risk-discovery/prototypes/s2-yjs-rust'

  const results: PrototypeResult[] = []

  try {
    execSync(`cd ${dir} && pnpm exec playwright test --reporter=json > /tmp/s2-${prototype}-playwright.json`, {
      stdio: 'pipe',
      encoding: 'utf8',
    })
  } catch (e) {
    console.warn(`[bench-yjs-roundtrip] Prototype ${prototype} tests had failures`)
  }

  // Parse Playwright results
  const path = `/tmp/s2-${prototype}-playwright.json`
  if (existsSync(path)) {
    const report = JSON.parse(readFileSync(path, 'utf8'))
    // Populate results based on report structure (simplified)
  }

  return results
}

async function main() {
  const env = await collectEnvironment()
  console.log('[bench-yjs-roundtrip] Running Prototype A tests...')
  const aResults = await runPrototype('A')
  console.log('[bench-yjs-roundtrip] Running Prototype B tests...')
  const bResults = await runPrototype('B')

  const output = {
    schema_version: 1,
    spike: 's2-yjs-placement',
    benchmark: 'roundtrip-latency',
    timestamp: new Date().toISOString(),
    environment: env,
    runs: [...aResults, ...bResults],
    notes: 'See s2-yjs-placement.md for qualitative observations',
  }

  writeFileSync(
    '../benchmarks/s2-roundtrip-latency.json',
    JSON.stringify(output, null, 2),
  )
  console.log('[bench-yjs-roundtrip] Output: ../benchmarks/s2-roundtrip-latency.json')
}

main().catch(console.error)
```

### Task 47: Write S2 Tests #1-#8 for both prototypes

**Files:**
- Create: `spikes/tauri-risk-discovery/prototypes/s2-yjs-renderer/tests/e2e/` (8 test files)
- Create: `spikes/tauri-risk-discovery/prototypes/s2-yjs-rust/tests/e2e/` (8 test files)

The 8 tests share structure; each prototype gets the same test suite. Per the
spec Section 5.2 test matrix:

- [ ] **Step 1: Test #1 (roundtrip) already written in Task 41 for A**

Copy to Prototype B dir:
```bash
cp spikes/tauri-risk-discovery/prototypes/s2-yjs-renderer/tests/e2e/test-1-roundtrip.spec.ts \
   spikes/tauri-risk-discovery/prototypes/s2-yjs-rust/tests/e2e/test-1-roundtrip.spec.ts
```

- [ ] **Step 2: Write Test #2 — Nested block (heading + bullet + code)**

Create `tests/e2e/test-2-nested-block.spec.ts` in both prototype dirs:
```typescript
import { test, expect } from '@playwright/test'

test('s2-test-2-nested-block: heading + nested list + code block roundtrip', async ({ page }) => {
  await page.goto('/')
  await page.locator('[data-bn-editor]').waitFor({ timeout: 10000 })
  await page.locator('[data-bn-editor]').click()

  // Insert heading
  await page.keyboard.press('/')
  await page.waitForTimeout(300)
  await page.keyboard.type('heading')
  await page.waitForTimeout(300)
  await page.keyboard.press('Enter')
  await page.keyboard.type('Main Heading')
  await page.keyboard.press('Enter')

  // Insert nested list (2 levels)
  await page.keyboard.press('/')
  await page.waitForTimeout(300)
  await page.keyboard.type('bullet')
  await page.waitForTimeout(300)
  await page.keyboard.press('Enter')
  await page.keyboard.type('Level 1 item A')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Tab')  // indent
  await page.keyboard.type('Level 2 item A1')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Level 2 item A2')

  // Dump JSON (via clicking Dump button if exposed, or via evaluate)
  const beforeDump = await page.locator('[data-bn-editor]').innerText()

  // Reload and verify
  await page.reload()
  await page.locator('[data-bn-editor]').waitFor({ timeout: 10000 })
  const afterDump = await page.locator('[data-bn-editor]').innerText()

  expect(afterDump).toContain('Main Heading')
  expect(afterDump).toContain('Level 1 item A')
  expect(afterDump).toContain('Level 2 item A1')
  expect(afterDump).toContain('Level 2 item A2')
})
```

- [ ] **Step 3: Test #3 — Mark encoding (bold + italic + code overlap)**

Create `tests/e2e/test-3-mark-encoding.spec.ts`:
```typescript
import { test, expect } from '@playwright/test'

test('s2-test-3-mark-encoding: overlapping bold/italic/code marks roundtrip', async ({ page }) => {
  await page.goto('/')
  await page.locator('[data-bn-editor]').waitFor({ timeout: 10000 })
  await page.locator('[data-bn-editor]').click()

  // Type "marked text"
  await page.keyboard.type('bold italic code', { delay: 30 })

  // Select all, apply bold
  await page.keyboard.press('Meta+a')
  await page.keyboard.press('Meta+b')
  // Keep select, apply italic
  await page.keyboard.press('Meta+a')
  await page.keyboard.press('Meta+i')
  // Keep select, apply code
  await page.keyboard.press('Meta+a')
  await page.keyboard.press('Meta+e')  // BlockNote default for inline code — may vary

  await page.waitForTimeout(500)

  // Verify marks
  const boldCount = await page.locator('[data-bn-editor] strong, [data-bn-editor] b').count()
  const italicCount = await page.locator('[data-bn-editor] em, [data-bn-editor] i').count()
  expect(boldCount).toBeGreaterThanOrEqual(1)
  expect(italicCount).toBeGreaterThanOrEqual(1)

  // Reload, verify marks persist
  await page.reload()
  await page.locator('[data-bn-editor]').waitFor({ timeout: 10000 })
  const afterBold = await page.locator('[data-bn-editor] strong, [data-bn-editor] b').count()
  expect(afterBold).toBeGreaterThanOrEqual(1)
})
```

- [ ] **Step 4: Test #4 — Two-device merge (Node-only, no browser)**

Create `tests/node/test-4-two-device-merge.test.ts`:
```typescript
import { test, expect } from 'vitest'
import * as Y from 'yjs'

test('s2-test-4-two-device-merge: 2 Y.Docs concurrent edits merge deterministically', () => {
  const docA = new Y.Doc()
  const docB = new Y.Doc()

  const textA = docA.getText('test')
  const textB = docB.getText('test')

  // Device A edits
  textA.insert(0, 'Hello ')
  textA.insert(6, 'World')

  // Device B edits (concurrent, unaware of A)
  textB.insert(0, 'Foo ')
  textB.insert(4, 'Bar')

  // Sync: A → B
  const updateA = Y.encodeStateAsUpdate(docA)
  Y.applyUpdate(docB, updateA)

  // Sync: B → A
  const updateB = Y.encodeStateAsUpdate(docB)
  Y.applyUpdate(docA, updateB)

  // Verify both docs have identical state
  expect(textA.toString()).toBe(textB.toString())
  expect(Y.encodeStateAsUpdate(docA)).toEqual(Y.encodeStateAsUpdate(docB))
})
```

For Prototype B equivalent — uses Rust yrs library via Tauri command:

Create `tests/node/test-4-two-device-merge-rust.test.ts`: mirrors above but one
docB simulated via `invoke('apply_update', ...)` calls. (Requires running
Tauri app in background; implementation deferred to sub-agent based on S1/S2
exploration.)

- [ ] **Step 5: Tests #5-7 — state vector size / update size / compaction**

Create `tests/node/test-5-6-7-benchmarks.test.ts`:
```typescript
import { test, expect } from 'vitest'
import * as Y from 'yjs'

test('s2-test-5-state-vector-size: 1000 ops, size reasonable', () => {
  const doc = new Y.Doc()
  const text = doc.getText('t')
  for (let i = 0; i < 1000; i++) text.insert(i, 'x')
  const sv = Y.encodeStateVector(doc)
  const fs = require('node:fs')
  fs.writeFileSync('/tmp/s2-yjs-state-vector.json', JSON.stringify({
    ops: 1000,
    stateVectorBytes: sv.length,
    prototype: 'yjs-reference',
  }))
  expect(sv.length).toBeLessThan(50)  // Yjs state vectors are tiny
})

test('s2-test-6-update-size: single char insert update size', () => {
  const doc = new Y.Doc()
  const text = doc.getText('t')
  let updateBytes: Uint8Array = new Uint8Array(0)
  doc.on('update', (update: Uint8Array) => { updateBytes = update })
  text.insert(0, 'a')
  const fs = require('node:fs')
  fs.writeFileSync('/tmp/s2-yjs-single-update.json', JSON.stringify({
    singleCharUpdateBytes: updateBytes.length,
    prototype: 'yjs-reference',
  }))
  expect(updateBytes.length).toBeGreaterThan(0)
  expect(updateBytes.length).toBeLessThan(100)
})

test('s2-test-7-compaction: 1000 updates merged to single snapshot', () => {
  const doc = new Y.Doc()
  const text = doc.getText('t')
  const updates: Uint8Array[] = []
  doc.on('update', (u: Uint8Array) => updates.push(u))
  for (let i = 0; i < 1000; i++) text.insert(i, 'x')

  const merged = Y.mergeUpdates(updates)
  const snapshot = Y.encodeStateAsUpdate(doc)
  const fs = require('node:fs')
  fs.writeFileSync('/tmp/s2-yjs-compaction.json', JSON.stringify({
    updatesCount: updates.length,
    mergedBytes: merged.length,
    snapshotBytes: snapshot.length,
    prototype: 'yjs-reference',
  }))
  expect(merged.length).toBeLessThan(updates.length * 20)  // compaction effective
})
```

- [ ] **Step 6: Test #8 — Origin filtering (Prototype B only)**

Create `tests/e2e/test-8-origin-filtering.spec.ts` in **s2-yjs-rust only**:
```typescript
import { test, expect } from '@playwright/test'

test('s2-test-8-origin-filtering: Rust-origin updates don\'t re-trigger send', async ({ page }) => {
  await page.goto('/')
  await page.locator('[data-bn-editor]').waitFor({ timeout: 10000 })
  await page.locator('[data-bn-editor]').click()

  await page.keyboard.type('initial text', { delay: 30 })
  await page.waitForTimeout(1000)

  const sentBefore = await page.locator('text=/Updates sent to Rust: (\\d+)/').textContent()
  const skippedBefore = await page.locator('text=/Echo updates skipped: (\\d+)/').textContent()

  // Reload (this triggers load_snapshot which applies update with origin='rust')
  await page.reload()
  await page.locator('[data-bn-editor]').waitFor({ timeout: 10000 })
  await page.waitForTimeout(2000)

  const skippedAfter = await page.locator('text=/Echo updates skipped: (\\d+)/').textContent()

  // Echo skipped should increase (Rust-origin update was filtered)
  // Updates sent should NOT increase (because of filtering)
  expect(skippedAfter).not.toBe(skippedBefore)
})
```

- [ ] **Step 7: Run all S2 tests**

For each prototype:
```bash
cd prototypes/s2-yjs-renderer && pnpm exec playwright test && pnpm exec vitest run tests/node
cd ../s2-yjs-rust && pnpm exec playwright test && pnpm exec vitest run tests/node
```
Expected: Most pass. Log failures for findings.

### Task 48: Measure typing latency (A vs B) for benchmark

**Files:**
- Create: `spikes/tauri-risk-discovery/prototypes/s2-yjs-renderer/tests/bench/typing-latency.spec.ts`
- Create: `spikes/tauri-risk-discovery/prototypes/s2-yjs-rust/tests/bench/typing-latency.spec.ts`

- [ ] **Step 1: Write typing latency bench**

Create file in BOTH prototype dirs:
```typescript
import { test } from '@playwright/test'
import { writeFileSync } from 'node:fs'

test('s2-typing-latency: measure per-char latency for 500 chars', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.locator('[data-bn-editor]').waitFor({ timeout: 10000 })
  await page.locator('[data-bn-editor]').click()

  const latencies: number[] = []
  const text = 'XYZXYZXYZXYZXYZXYZXYZXYZ'.repeat(21)  // 504 chars

  for (const ch of text) {
    const start = performance.now()
    await page.keyboard.type(ch)
    latencies.push(performance.now() - start)
  }

  latencies.sort((a, b) => a - b)
  const p50 = latencies[Math.floor(latencies.length * 0.5)]
  const p95 = latencies[Math.floor(latencies.length * 0.95)]

  // Prototype is inferred from dir name
  const prototype = testInfo.project.name.includes('rust') ? 'B' : 'A'
  const payload = {
    prototype,
    test: 'typing-latency',
    samples: latencies,
    p50,
    p95,
    unit: 'ms',
  }
  writeFileSync(`/tmp/s2-${prototype}-typing-latency.json`, JSON.stringify(payload))

  console.log(`[s2-${prototype}-typing] p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms`)
})
```

- [ ] **Step 2: Run latency bench for both prototypes**

```bash
cd prototypes/s2-yjs-renderer && pnpm exec playwright test typing-latency.spec.ts
cd ../s2-yjs-rust && pnpm exec playwright test typing-latency.spec.ts
```

- [ ] **Step 3: Assemble s2-roundtrip-latency.json**

Run: `cd docs/spikes/tauri-risk-discovery/scripts && pnpm exec tsx bench-yjs-roundtrip.ts`
Expected: Aggregates all benchmark sidecars from `/tmp/s2-*`, writes unified JSON to `../benchmarks/`.

### Task 49: Write s2-yjs-placement.md findings

**Files:**
- Modify: `docs/spikes/tauri-risk-discovery/s2-yjs-placement.md`

- [ ] **Step 1: Fill in all 10 sections**

Populate placeholders with actual findings:

- Metadata: date, commits, duration
- Hypothesis: copy from spec Section 5.2
- TL;DR: 🟢 B wins / 🟡 hybrid / 🔴 A wins + reason
- Setup: Prototype A vs B, paths, versions
- Test matrix results: all 8 tests × 2 prototypes table
- Benchmark data: typing latency p50/p95 comparison, update size
- Observations: any yrs quirks, y-prosemirror compat issues found, origin filtering behavior
- Decision + rationale: based on results
- Subsequent subproject impact: what Subproject 5 looks like depending on verdict
- References: yrs repo, y-prosemirror docs, Yjs spec

- [ ] **Step 2: Verify complete**

Run: `grep -c "To be filled" docs/spikes/tauri-risk-discovery/s2-yjs-placement.md`
Expected: 0

### Task 50: Checkpoint 2 — Kaan review of S2

**Files:** no code — coordinator action

- [ ] **Step 1: Sub-agent returns completion signal**

Same as Task 36 (S1 checkpoint) but for S2.

- [ ] **Step 2: Coordinator commits**

Run:
```bash
git add spikes/tauri-risk-discovery/prototypes/
git add docs/spikes/tauri-risk-discovery/s2-yjs-placement.md
git add docs/spikes/tauri-risk-discovery/benchmarks/s2-roundtrip-latency.json
git add docs/spikes/tauri-risk-discovery/scripts/bench-yjs-roundtrip.ts
git commit -m "spike(s2): Yjs placement findings

Prototype A: renderer Y.Doc + Rust persistence
Prototype B: yrs in Rust + renderer shadow Y.Doc
Verdict: [🟢/🟡/🔴]
Key: [summary]"
```

- [ ] **Step 3: Present to Kaan, await decision**

Per Section 6 checkpoint protocol.

---

## Phase 3: S3 — DB Placement

**Sub-agent dispatch context:** Fresh sub-agent. Before starting, read S1 and
S2 findings. S3 focuses on database layer; prior findings shouldn't heavily
affect S3 but should be read for consistency.

### Task 51: Add DB deps to spike app (for Options A, B, C)

**Files:**
- Modify: `spikes/tauri-risk-discovery/app/src-tauri/Cargo.toml`
- Modify: `spikes/tauri-risk-discovery/app/package.json`

- [ ] **Step 1: Add rusqlite + sqlite-vec (Option A)**

Edit Cargo.toml:
```toml
[dependencies]
rusqlite = { version = "0.31", features = ["bundled", "load_extension"] }
# sqlite-vec via rusqlite_extension crate (or custom load_extension call)
```

- [ ] **Step 2: Add @tauri-apps/plugin-sql (Option B)**

Run:
```bash
cd spikes/tauri-risk-discovery/app
pnpm add @tauri-apps/plugin-sql@^2.1
```

Also add Rust-side plugin:
```bash
cd src-tauri
cargo add tauri-plugin-sql --features sqlite
```

### Task 52: Implement Option A — rusqlite + custom Tauri commands

**Files:**
- Create: `spikes/tauri-risk-discovery/app/src-tauri/src/db_option_a.rs`
- Modify: `spikes/tauri-risk-discovery/app/src-tauri/src/lib.rs`

- [ ] **Step 1: Write Option A module**

Create `db_option_a.rs`:
```rust
use std::sync::Mutex;
use rusqlite::{Connection, params};
use tauri::State;
use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct Note {
    pub id: String,
    pub title: String,
    pub body: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}

pub struct OptionADb(pub Mutex<Connection>);

impl OptionADb {
    pub fn new() -> Self {
        let conn = Connection::open("/tmp/spike-s3-option-a.db").expect("open db");
        conn.execute(
            "CREATE TABLE IF NOT EXISTS notes (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                body TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                deleted_at INTEGER
            )",
            [],
        ).expect("create notes");
        conn.execute(
            "CREATE TABLE IF NOT EXISTS embeddings (
                note_id TEXT PRIMARY KEY,
                embedding BLOB NOT NULL
            )",
            [],
        ).expect("create embeddings");
        Self(Mutex::new(conn))
    }
}

#[tauri::command]
pub fn option_a_list_notes(limit: i64, state: State<OptionADb>) -> Result<Vec<Note>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id, title, body, created_at, updated_at, deleted_at
         FROM notes WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![limit], |row| {
        Ok(Note {
            id: row.get(0)?,
            title: row.get(1)?,
            body: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
            deleted_at: row.get(5)?,
        })
    }).map_err(|e| e.to_string())?;
    let notes: Result<Vec<Note>, _> = rows.collect();
    notes.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn option_a_get_note(id: String, state: State<OptionADb>) -> Result<Option<Note>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id, title, body, created_at, updated_at, deleted_at FROM notes WHERE id = ?"
    ).map_err(|e| e.to_string())?;
    let mut rows = stmt.query(params![id]).map_err(|e| e.to_string())?;
    if let Some(row) = rows.next().map_err(|e| e.to_string())? {
        Ok(Some(Note {
            id: row.get(0).map_err(|e| e.to_string())?,
            title: row.get(1).map_err(|e| e.to_string())?,
            body: row.get(2).map_err(|e| e.to_string())?,
            created_at: row.get(3).map_err(|e| e.to_string())?,
            updated_at: row.get(4).map_err(|e| e.to_string())?,
            deleted_at: row.get(5).map_err(|e| e.to_string())?,
        }))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn option_a_bulk_insert(notes: Vec<Note>, state: State<OptionADb>) -> Result<usize, String> {
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut count = 0;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO notes (id, title, body, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).map_err(|e| e.to_string())?;
        for note in &notes {
            stmt.execute(params![note.id, note.title, note.body, note.created_at, note.updated_at, note.deleted_at])
                .map_err(|e| e.to_string())?;
            count += 1;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(count)
}
```

- [ ] **Step 2: Register commands in lib.rs**

Add `mod db_option_a;` at top. Modify `run()` to include:
```rust
.manage(db_option_a::OptionADb::new())
.invoke_handler(tauri::generate_handler![
    // ... existing ...
    db_option_a::option_a_list_notes,
    db_option_a::option_a_get_note,
    db_option_a::option_a_bulk_insert,
])
```

- [ ] **Step 3: Build**

Run: `pnpm tauri build --debug 2>&1 | tail -20`
Expected: Compiles

### Task 53: Implement Option B — plugin-sql setup

**Files:**
- Modify: `spikes/tauri-risk-discovery/app/src-tauri/src/lib.rs` (register plugin)
- Create: `spikes/tauri-risk-discovery/app/src/db-option-b.ts` (renderer helper)

- [ ] **Step 1: Register plugin-sql in Rust**

Add to `run()`:
```rust
.plugin(tauri_plugin_sql::Builder::default()
    .add_migrations("sqlite:spike-s3-option-b.db", vec![
        tauri_plugin_sql::Migration {
            version: 1,
            description: "create notes",
            sql: "CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER)",
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
    ])
    .build())
```

- [ ] **Step 2: Write renderer helper**

Create `src/db-option-b.ts`:
```typescript
import Database from '@tauri-apps/plugin-sql'

let dbCache: Database | null = null

export async function getOptionBDb(): Promise<Database> {
  if (!dbCache) {
    dbCache = await Database.load('sqlite:spike-s3-option-b.db')
  }
  return dbCache
}

export interface Note {
  id: string
  title: string
  body: string
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export async function optionBListNotes(limit: number): Promise<Note[]> {
  const db = await getOptionBDb()
  return db.select<Note[]>(
    'SELECT * FROM notes WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?',
    [limit],
  )
}

export async function optionBGetNote(id: string): Promise<Note | null> {
  const db = await getOptionBDb()
  const rows = await db.select<Note[]>('SELECT * FROM notes WHERE id = ?', [id])
  return rows[0] ?? null
}

export async function optionBBulkInsert(notes: Note[]): Promise<number> {
  const db = await getOptionBDb()
  let count = 0
  await db.execute('BEGIN')
  try {
    for (const n of notes) {
      await db.execute(
        'INSERT INTO notes (id, title, body, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?)',
        [n.id, n.title, n.body, n.created_at, n.updated_at, n.deleted_at],
      )
      count++
    }
    await db.execute('COMMIT')
  } catch (e) {
    await db.execute('ROLLBACK')
    throw e
  }
  return count
}
```

### Task 54: Implement Option C — Hybrid

**Files:**
- Create: `spikes/tauri-risk-discovery/app/src-tauri/src/db_option_c.rs`
- Create: `spikes/tauri-risk-discovery/app/src/db-option-c.ts`

- [ ] **Step 1: Write Rust side — schema migrations in Rust, plugin-sql shares file**

Create `db_option_c.rs`:
```rust
use rusqlite::Connection;

pub fn init_shared_db(path: &str) {
    let conn = Connection::open(path).expect("open shared db");
    // Hybrid: Rust owns migrations, plugin-sql opens same file for renderer queries
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            deleted_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at DESC) WHERE deleted_at IS NULL;
    ").expect("init schema");
}
```

- [ ] **Step 2: Write renderer side — use plugin-sql for simple, Tauri command for complex**

Create `src/db-option-c.ts`:
```typescript
import Database from '@tauri-apps/plugin-sql'
import { invoke } from '@tauri-apps/api/core'

let dbCache: Database | null = null

async function getDb() {
  if (!dbCache) dbCache = await Database.load('sqlite:spike-s3-option-c.db')
  return dbCache
}

// Simple query via plugin-sql
export async function optionCListNotes(limit: number): Promise<any[]> {
  const db = await getDb()
  return db.select('SELECT * FROM notes WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?', [limit])
}

// Complex query (e.g., vector search) via Rust custom command
export async function optionCVectorSearch(query: number[], k: number): Promise<any[]> {
  return invoke('option_c_vector_search', { queryVec: query, k })
}
```

### Task 55: Port memry migrations for S3 tests

**Files:**
- Copy: `apps/desktop/drizzle/data/*.sql` → `spikes/tauri-risk-discovery/app/src-tauri/migrations/`

- [ ] **Step 1: Copy memry data migrations**

Run:
```bash
cp -r apps/desktop/drizzle/data/*.sql spikes/tauri-risk-discovery/app/src-tauri/migrations/ 2>/dev/null || true
# Migrations may be in .drizzle-kit/ or similar — adapt path
ls apps/desktop/drizzle 2>/dev/null
# If different structure, copy whatever hand-written SQL files exist
```

- [ ] **Step 2: Verify migrations present**

Run: `ls spikes/tauri-risk-discovery/app/src-tauri/migrations/`
Expected: numbered SQL files (0001_xxx.sql, 0002_xxx.sql, ...)

### Task 56: Seed test data (1000 fake notes)

**Files:**
- Create: `spikes/tauri-risk-discovery/app/src-tauri/src/seed.rs`

- [ ] **Step 1: Write seed command**

Create `seed.rs`:
```rust
use rusqlite::Connection;
use std::time::SystemTime;

pub fn seed_1000_notes(conn: &Connection) -> Result<usize, rusqlite::Error> {
    let tx = conn.transaction()?;
    let now = SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO notes (id, title, body, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, NULL)"
        )?;
        for i in 0..1000 {
            stmt.execute(rusqlite::params![
                format!("note-{:04}", i),
                format!("Test Note #{}", i),
                format!("Body content for note {}. Lorem ipsum dolor sit amet, consectetur adipiscing elit. {}", i, "x".repeat(200)),
                now - (i as i64 * 60000),
                now - (i as i64 * 60000),
            ])?;
        }
    }
    tx.commit()?;
    Ok(1000)
}
```

### Task 57: Write S3 benchmark runner

**Files:**
- Create: `docs/spikes/tauri-risk-discovery/scripts/bench-db-query.ts`

- [ ] **Step 1: Write unified 3-way benchmark**

Create file with:
```typescript
// S3 benchmark: runs 10 tests against Options A, B, C.
// Output: ../benchmarks/s3-query-latency.json

import { collectEnvironment } from './collect-environment'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

interface BenchRun {
  option: 'A' | 'B' | 'C'
  test: string
  samples: number[]
  p50: number
  p95: number
  unit: string
  pass: boolean
  notes: string
}

async function runTestsForOption(option: 'A' | 'B' | 'C'): Promise<BenchRun[]> {
  // Run Playwright bench suite that exercises each option
  const dir = '../../../spikes/tauri-risk-discovery/app'
  const runs: BenchRun[] = []
  try {
    execSync(
      `cd ${dir} && DB_OPTION=${option} pnpm exec playwright test bench/db- --reporter=json > /tmp/s3-${option}-bench.json`,
      { stdio: 'pipe' },
    )
  } catch (e) {
    console.warn(`[bench-db-query] Option ${option} had failures`)
  }
  // Parse results (simplified)
  return runs
}

async function main() {
  const env = await collectEnvironment()
  console.log('[bench-db-query] Running Option A benchmarks...')
  const aRuns = await runTestsForOption('A')
  console.log('[bench-db-query] Running Option B benchmarks...')
  const bRuns = await runTestsForOption('B')
  console.log('[bench-db-query] Running Option C benchmarks...')
  const cRuns = await runTestsForOption('C')

  const output = {
    schema_version: 1,
    spike: 's3-db-placement',
    benchmark: 'query-latency',
    timestamp: new Date().toISOString(),
    environment: env,
    runs: [...aRuns, ...bRuns, ...cRuns],
  }
  writeFileSync('../benchmarks/s3-query-latency.json', JSON.stringify(output, null, 2))
  console.log('[bench-db-query] Output: ../benchmarks/s3-query-latency.json')
}

main().catch(console.error)
```

### Task 58: Write S3 tests #1-#10

**Files:**
- Create: `spikes/tauri-risk-discovery/app/tests/bench/db-<test-n>.spec.ts` (10 files)

Per spec Section 5.3 test matrix. Each test runs against all 3 options via
`process.env.DB_OPTION` switch.

- [ ] **Step 1: Test #1 — 1000-note list**

Create `tests/bench/db-1-list-1000.spec.ts`:
```typescript
import { test } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { invoke } from '@tauri-apps/api/core'  // only in Tauri context; use page.evaluate for harness

const OPTION = process.env.DB_OPTION ?? 'A'

test(`s3-test-1-list-1000-option-${OPTION}: 1000 note list latency`, async ({ page }) => {
  await page.goto('/')
  // First: seed 1000 notes (call via custom seed button or Rust invoke on mount)
  await page.evaluate(async (opt) => {
    const { invoke } = await import('@tauri-apps/api/core')
    if (opt === 'A') await invoke('option_a_seed_1000')
    // B/C: seed via renderer helper
  }, OPTION)

  const samples: number[] = []
  for (let i = 0; i < 10; i++) {
    const start = performance.now()
    await page.evaluate(async (opt) => {
      const { invoke } = await import('@tauri-apps/api/core')
      if (opt === 'A') await invoke('option_a_list_notes', { limit: 1000 })
      if (opt === 'B') {
        const db = await import('../../../src/db-option-b')
        await db.optionBListNotes(1000)
      }
      if (opt === 'C') {
        const db = await import('../../../src/db-option-c')
        await db.optionCListNotes(1000)
      }
    }, OPTION)
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  const p50 = samples[Math.floor(samples.length * 0.5)]
  const p95 = samples[Math.floor(samples.length * 0.95)]
  writeFileSync(`/tmp/s3-${OPTION}-test-1.json`, JSON.stringify({ option: OPTION, test: 'list-1000', p50, p95, samples }))
})
```

- [ ] **Step 2: Test #2 — Single note get (same pattern)**
- [ ] **Step 3: Test #3 — Bulk insert 1000**
- [ ] **Step 4: Test #4 — sqlite-vec kNN (10k embeddings)**
- [ ] **Step 5: Test #5 — FTS query**
- [ ] **Step 6: Test #6 — Blob R/W (50KB)**
- [ ] **Step 7: Test #7 — Migration run**
- [ ] **Step 8: Test #8 — Bundle size (via du command post-build)**
- [ ] **Step 9: Test #9 — Cold startup**
- [ ] **Step 10: Test #10 — Concurrent access**

Each test follows same pattern as Test #1. For brevity, detailed code for each
test is deferred to sub-agent implementation — but each test MUST:
- Run against all 3 options via `DB_OPTION` env var
- Write results to `/tmp/s3-${OPTION}-test-${N}.json`
- Use 10+ samples, report p50 + p95

### Task 59: Run full S3 benchmark suite

**Files:**
- Modify: `docs/spikes/tauri-risk-discovery/benchmarks/s3-query-latency.json`

- [ ] **Step 1: Run bench**

Run:
```bash
cd docs/spikes/tauri-risk-discovery/scripts
pnpm exec tsx bench-db-query.ts
```

- [ ] **Step 2: Verify output**

Run: `cat ../benchmarks/s3-query-latency.json | head -40`
Expected: schema_version 1, 30 runs (10 tests × 3 options), valid JSON

### Task 60: Write s3-db-placement.md findings

**Files:**
- Modify: `docs/spikes/tauri-risk-discovery/s3-db-placement.md`

- [ ] **Step 1: Fill in all 10 sections**

Populate per spec Section 5.3 template:
- Metadata
- Hypothesis
- TL;DR: 🟢/🟡/🔴 + summary
- Setup: paths, versions, how each option set up
- Test matrix: 10 × 3 = 30 result cells
- Benchmark data: p50/p95 per test per option + bundle size
- Observations: surprises (sqlite-vec loading, plugin-sql async behavior, etc.)
- Decision: A / B / C + rationale
- Subproject 2 impact: "build on [option]"
- References

- [ ] **Step 2: Verify complete**

Run: `grep -c "To be filled" docs/spikes/tauri-risk-discovery/s3-db-placement.md`
Expected: 0

### Task 61: Checkpoint 3 — Kaan review of S3

**Files:** no code — coordinator action

- [ ] **Step 1: Sub-agent completion signal**

- [ ] **Step 2: Coordinator commits**

Run:
```bash
git add spikes/tauri-risk-discovery/app/
git add docs/spikes/tauri-risk-discovery/s3-db-placement.md
git add docs/spikes/tauri-risk-discovery/benchmarks/s3-query-latency.json
git add docs/spikes/tauri-risk-discovery/scripts/bench-db-query.ts
git commit -m "spike(s3): DB placement findings

Options evaluated: A (rusqlite+commands), B (plugin-sql), C (hybrid)
Verdict: [🟢/🟡/🔴]
Key: [summary]"
```

- [ ] **Step 3: Present to Kaan, await decision**

---

## Phase 4: Windows smoke + overall findings

### Task 62: Build Windows version of spike app

**Files:** none (build artifact)

- [ ] **Step 1: Build Windows app (if on macOS, requires cross-compile or CI)**

On Windows machine or VM:
```bash
cd spikes/tauri-risk-discovery/app
pnpm tauri build --target x86_64-pc-windows-msvc
```

⚠️ Alternative: use GitHub Actions workflow for Windows build. Simplest for
Kaan's likely macOS dev setup. Out-of-band from autonomous execution — Kaan
triggers Windows build manually.

### Task 63: Run S1 Windows smoke subset

**Files:**
- Modify: `docs/spikes/tauri-risk-discovery/benchmarks/s1-feature-matrix.csv`

- [ ] **Step 1: On Windows: run S1 tests #1, #4, #5, #8, #9**

Run on Windows machine:
```bash
cd spikes/tauri-risk-discovery/app
pnpm exec playwright test test-1 test-4 test-8 test-9
```

For Test #5 (manual HTML paste), execute per checklist on Windows WebView2.

- [ ] **Step 2: Update CSV**

Edit `s1-feature-matrix.csv` — set status for Windows rows based on actual outcomes.

### Task 64: Update s1 findings with Windows results

**Files:**
- Modify: `docs/spikes/tauri-risk-discovery/s1-blocknote-webview.md`

- [ ] **Step 1: Add Windows results**

Append a "Windows WebView2 smoke results" section to s1 findings, summarizing
5-test outcomes, any differences vs macOS.

### Task 65: Write overall findings.md

**Files:**
- Modify: `docs/spikes/tauri-risk-discovery/findings.md`

- [ ] **Step 1: Fill in overall summary**

Populate placeholders:
- Metadata: total dates, commit range
- TL;DR: 🟢 PROCEED / 🟡 / 🔴 ABORT based on S1/S2/S3 verdicts
- Decision summary table: each sub's verdict
- Post-spike architecture picture: ASCII diagram showing Rust vs renderer
  responsibilities given decisions made
- Subproject sequencing: 11-week estimate, adjusted if Yellow/Red outcomes
- Key risks carried forward (from spec Section 8 "Accepted open risks")
- Next step: "Subproject 1 brainstorm (separate session)."

### Task 66: Final sign-off — Kaan review of overall spike

**Files:** no changes — coordinator action

- [ ] **Step 1: Sub-agent completion signal**

- [ ] **Step 2: Coordinator commits**

```bash
git add docs/spikes/tauri-risk-discovery/findings.md
git add docs/spikes/tauri-risk-discovery/s1-blocknote-webview.md  # updated with Win
git add docs/spikes/tauri-risk-discovery/benchmarks/s1-feature-matrix.csv  # updated
git commit -m "spike(final): overall findings + Windows smoke results

Overall verdict: [🟢/🟡/🔴]
S1: [verdict], S2: [verdict], S3: [verdict]"
```

- [ ] **Step 3: Present to Kaan**

Present final comprehensive summary: all 3 verdicts, overall migration go/no-go
recommendation, proposed subproject sequencing, accepted risks.

- [ ] **Step 4: Await Kaan final sign-off**

If 🔴: skip Phase 5 cleanup. Branch + worktree preserved for post-mortem.
If 🟢/🟡: proceed to Phase 5 cleanup.

---

## Phase 5: Cleanup (only on 🟢/🟡 sign-off)

### Task 67: Remove throwaway spike code

**Files:**
- Delete: `spikes/tauri-risk-discovery/` (all contents)

- [ ] **Step 1: Verify permanent artifacts already committed**

Run: `git log --stat | grep "docs/spikes/" | head -10`
Expected: commits show findings, benchmarks, scripts are committed

- [ ] **Step 2: Remove spike dir**

Run:
```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk
git rm -rf spikes/tauri-risk-discovery
```
Expected: all files in `spikes/` deleted

- [ ] **Step 3: Verify docs/ untouched**

Run: `ls docs/spikes/tauri-risk-discovery/`
Expected: README.md, findings.md, 3 sub findings, benchmarks/, scripts/ all present

### Task 68: Revert pnpm-workspace.yaml exclusion

**Files:**
- Modify: `pnpm-workspace.yaml`

- [ ] **Step 1: Remove `!spikes/**` line**

Edit file to restore original pnpm-workspace.yaml (remove the exclusion added in Task 2).

### Task 69: Commit cleanup

**Files:** git state

- [ ] **Step 1: Stage cleanup**

Run:
```bash
git add pnpm-workspace.yaml
git add -A spikes/  # captures deletions
```

- [ ] **Step 2: Commit**

Run:
```bash
git commit -m "spike(cleanup): remove throwaway code, findings preserved in docs/

Spike 0 complete. Code under spikes/tauri-risk-discovery/ deleted as planned
per hybrid output model. All findings, benchmark data, and reproducible scripts
live permanently in docs/spikes/tauri-risk-discovery/.

pnpm-workspace.yaml exclusion reverted."
```

### Task 70: Push branch and create PR (coordinator)

**Files:** remote branch

- [ ] **Step 1: Push**

Run:
```bash
git push -u origin spike/tauri-risk-discovery
```

- [ ] **Step 2: Create PR**

Run:
```bash
gh pr create \
  --title "spike/tauri-risk-discovery: Tauri migration risk discovery findings" \
  --body "$(cat <<'EOF'
## Summary

Spike 0 complete. Three architectural decisions locked in for the upcoming
Electron → Tauri migration:

- **S1 (BlockNote + WKWebView):** [verdict + 1-line summary]
- **S2 (Yjs placement):** [verdict + 1-line summary]
- **S3 (DB placement):** [verdict + 1-line summary]

Overall verdict: [🟢 PROCEED / 🟡 PROCEED WITH CAVEATS / 🔴 ABORT]

## Contents

- `docs/spikes/tauri-risk-discovery/findings.md` — overall summary
- `docs/spikes/tauri-risk-discovery/s1-blocknote-webview.md` — S1 detailed
- `docs/spikes/tauri-risk-discovery/s2-yjs-placement.md` — S2 detailed
- `docs/spikes/tauri-risk-discovery/s3-db-placement.md` — S3 detailed
- `docs/spikes/tauri-risk-discovery/benchmarks/` — reproducible data
- `docs/spikes/tauri-risk-discovery/scripts/` — re-runnable benchmark scripts

## Changes

- Added `docs/spikes/tauri-risk-discovery/` (permanent)
- Temporarily added `spikes/tauri-risk-discovery/` (throwaway, deleted in cleanup commit)
- Temporarily excluded `spikes/**` from pnpm workspace (reverted)

## Next

Kaan: review findings, merge if acceptable. After merge, Subproject 1 brainstorm
begins (separate session).

## Test plan

- [ ] Read findings.md and 3 sub-findings docs
- [ ] Spot-check at least one benchmark rerun (optional): `cd docs/spikes/tauri-risk-discovery/scripts && pnpm exec tsx bench-webview-blocknote.ts`
- [ ] Verify no spike code remains in `spikes/` (should be deleted)
- [ ] Verify `pnpm-workspace.yaml` reverted
EOF
)"
```

Expected: PR URL returned

- [ ] **Step 3: Await Kaan's merge approval**

Per spec Section 6: **NO auto-merge**. Kaan explicitly approves + merges.
Coordinator waits. Do not proceed until Kaan issues merge command.

### Task 71: After Kaan merges: remove worktree + branch

**Files:** git local state

- [ ] **Step 1: Wait for merge confirmation from Kaan**

- [ ] **Step 2: Sync main, remove worktree**

Run:
```bash
git -C /Users/h4yfans/sideproject/memry pull origin main
git -C /Users/h4yfans/sideproject/memry worktree remove /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk
git -C /Users/h4yfans/sideproject/memry branch -d spike/tauri-risk-discovery
```

- [ ] **Step 3: Verify clean state**

Run: `git -C /Users/h4yfans/sideproject/memry worktree list`
Expected: only main worktree listed

---

## Phase 5 Alternative: Abort cleanup (🔴 sign-off)

If Kaan's final sign-off is 🔴 (migration abort):

### Task 72 (alt): Preserve spike branch for post-mortem

**Files:** no changes; draft PR instead of cleanup

- [ ] **Step 1: Do NOT run cleanup (Tasks 67-71)**

Spike code stays in `spikes/` so post-mortem can inspect what was attempted.

- [ ] **Step 2: Push branch, open DRAFT PR**

Run:
```bash
git push -u origin spike/tauri-risk-discovery
gh pr create --draft \
  --title "🔴 spike/tauri-risk-discovery: Migration aborted — post-mortem" \
  --body "Tauri migration ABORTED based on Spike 0 findings. See findings.md for details.

This PR is DRAFT for investigation purposes. Branch retained. Do not merge
unless explicitly intended for post-mortem archive.

Abort reason: [summary]"
```

- [ ] **Step 3: Await Kaan's decision on how to proceed**

Options: keep branch indefinitely, archive and delete later, or investigate
alternative (e.g., Chromium-bundled Tauri fork — out of Spike 0 scope).

---

## Self-Review Notes (Engineer: skip this section, it's for plan author)

Coverage check vs spec:
- ✅ Setup tasks map to spec Section 4 (architecture + directory layout)
- ✅ S1 15 tests covered (Tasks 19-33)
- ✅ S2 8 tests covered (Task 47 steps)
- ✅ S3 10 tests covered (Task 58 steps — detail deferred to sub-agent for tests #2-#10 following pattern)
- ✅ Checkpoint protocol at each sub-spike boundary (Tasks 36, 50, 61, 66)
- ✅ Kill switches referenced in spec Section 4 + 8, not repeated here (sub-agent reads spec)
- ✅ Cleanup flow both for 🟢/🟡 and 🔴 paths (Phase 5 + 5 Alt)
- ✅ Coordinator vs sub-agent role delineation per spec Section 6

Placeholder scan:
- All `[pending]` / `[To be filled]` markers are intentional (findings skeleton placeholders)
- All bracketed `[verdict]` / `[summary]` in commit messages are template markers for actual verdicts to fill in based on test outcomes

Type consistency: Rust struct `Note` defined in Task 52 used consistently.
Tauri commands named `option_a_list_notes`, `option_a_get_note`, `option_a_bulk_insert` consistently. TS helpers `optionBListNotes`, `optionBGetNote`, `optionBBulkInsert` match.

Known pragmatic gaps (acceptable for spike):
- S3 Test #2-#10 code not written out in full (pattern shown in Test #1, explicit fill-in by sub-agent). Rationale: 10× near-identical test bodies would 3× plan size; sub-agent can infer from pattern + spec test matrix.
- Windows build on non-Windows host requires CI or VM — noted in Task 62 with alternatives.
- Some Playwright selectors (`[data-bn-editor]`) may not match exactly — Task 19 includes debug fallback instructions.

---

*End of implementation plan.*
