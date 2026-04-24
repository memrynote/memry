# M1 — Tauri Skeleton + Full Renderer Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Boot a Tauri 2.x desktop app under `apps/desktop-tauri/` with every renderer file from `apps/desktop/src/renderer/src/` ported 1:1, wired to a mock IPC layer so every page renders with fake data. Visual parity with the Electron app on macOS.

**Architecture:** Two-world Tauri app: `src/` (React/Vite renderer) + `src-tauri/` (Rust backend, minimal scaffold at M1). Renderer imports paths unchanged; Electron's `window.api.*` call sites mechanically rewritten to `invoke('command_name', args)` backed by a mock router that returns canned fixtures. All existing `packages/@memry/*` imports remain functional (packages/ stays frozen until M10).

**Tech Stack:** Tauri 2.x, Rust 1.95+, Vite 7, React 19, TypeScript 5.9, Tailwind v4, pnpm workspace, tauri-specta, Vitest, Playwright WebKit.

**Parent spec:** `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md`

---

## Pre-flight checks (do these before Task 1)

- [ ] Rust toolchain installed: `rustc --version` returns 1.95+; `cargo --version` works
- [ ] Node 24.x active: `node --version` returns v24.x
- [ ] pnpm 10.x active: `pnpm --version` returns 10.x
- [ ] Current branch is `spike/tauri-risk-discovery` (or a new branch off it — confirm with Kaan)
- [ ] Working tree clean: `git status` shows no pending changes
- [ ] Electron dev build works first (baseline for visual diff at Task 20): `pnpm --filter @memry/desktop dev` opens the app

---

## File Structure

Files created in M1 (Rust backend side is minimal skeleton only):

```
apps/desktop-tauri/
├── package.json                    Task 1
├── tsconfig.json                   Task 4
├── tsconfig.node.json              Task 4
├── tsconfig.web.json               Task 4
├── vite.config.ts                  Task 3
├── index.html                      Task 3
├── .gitignore                      Task 1
│
├── src/
│   ├── main.tsx                    Task 12 (ported)
│   ├── App.tsx                     Task 12 (ported)
│   ├── assets/                     Task 8 (ported)
│   │   ├── base.css
│   │   └── main.css
│   ├── lib/                        Task 12 (ported) + Task 9-11 (ipc/ subfolder added)
│   │   ├── ipc/
│   │   │   ├── invoke.ts           Task 9
│   │   │   ├── events.ts           Task 11
│   │   │   └── mocks/
│   │   │       ├── index.ts        Task 10
│   │   │       ├── notes.ts        Task 10
│   │   │       ├── tasks.ts        Task 10
│   │   │       ├── calendar.ts     Task 10
│   │   │       ├── inbox.ts        Task 10
│   │   │       ├── journal.ts      Task 10
│   │   │       ├── folders.ts      Task 10
│   │   │       ├── tags.ts         Task 10
│   │   │       ├── bookmarks.ts    Task 10
│   │   │       ├── templates.ts    Task 10
│   │   │       ├── settings.ts     Task 10
│   │   │       ├── vault.ts        Task 10
│   │   │       ├── auth.ts         Task 10
│   │   │       ├── sync.ts         Task 10
│   │   │       ├── search.ts       Task 10
│   │   │       ├── graph.ts        Task 10
│   │   │       ├── properties.ts   Task 10
│   │   │       ├── reminders.ts    Task 10
│   │   │       ├── saved-filters.ts Task 10
│   │   │       ├── updater.ts      Task 10
│   │   │       └── types.ts        Task 10
│   │   └── (other lib/ files)      Task 12 (ported)
│   ├── components/                 Task 13 (ported)
│   ├── contexts/                   Task 12 (ported)
│   ├── data/                       Task 12 (ported)
│   ├── features/                   Task 14 (ported)
│   ├── hooks/                      Task 12 (ported)
│   ├── pages/                      Task 14 (ported)
│   ├── services/                   Task 14 (ported) + Task 15 (rewired to invoke)
│   ├── sync/                       Task 14 (ported, minimal — deeper wiring in M5/M6)
│   ├── types/                      Task 12 (ported)
│   ├── env.d.ts                    Task 3
│   └── generated/
│       └── bindings.ts             Task 17 (empty stub at M1)
│
├── src-tauri/
│   ├── Cargo.toml                  Task 2
│   ├── Cargo.lock                  (generated)
│   ├── tauri.conf.json             Task 2
│   ├── build.rs                    Task 2
│   ├── capabilities/
│   │   └── default.json            Task 2
│   ├── icons/                      Task 2 (copy from apps/desktop/build/)
│   └── src/
│       ├── main.rs                 Task 2
│       ├── lib.rs                  Task 2
│       └── commands/
│           └── mod.rs              Task 16
│
├── tests/                          (empty at M1, populated by later milestones)
├── e2e/                            (empty at M1)
└── scripts/
    ├── capability-sanity-check.ts  Task 16
    ├── generate-bindings.ts        Task 17
    ├── check-bindings.ts           Task 17
    └── port-audit.ts               Task 15 (helper for window.api site scan)

apps/desktop/README.md              Task 5 (FROZEN banner appended)
.github/workflows/electron-freeze.yml Task 5 (CI path-guard added)

pnpm-workspace.yaml                 Task 1 (apps/* glob already covers)
```

Files deleted in M1:

```
spikes/tauri-risk-discovery/        Task 6
```

---

## Task 1: Scaffold `apps/desktop-tauri/` directory + workspace integration

**Files:**
- Create: `apps/desktop-tauri/package.json`
- Create: `apps/desktop-tauri/.gitignore`
- Create: `apps/desktop-tauri/README.md`
- Modify: `pnpm-workspace.yaml` (verify `apps/*` glob present — should already be)

- [ ] **Step 1.1: Create the directory and placeholder files**

```bash
mkdir -p apps/desktop-tauri/{src,src-tauri/src/commands,src-tauri/capabilities,src-tauri/icons,tests,e2e,scripts}
mkdir -p apps/desktop-tauri/src/{assets,lib/ipc/mocks,generated}
touch apps/desktop-tauri/README.md
```

- [ ] **Step 1.2: Write `apps/desktop-tauri/package.json`**

```json
{
  "name": "@memry/desktop-tauri",
  "version": "2.0.0-alpha.1",
  "private": true,
  "license": "GPL-3.0",
  "description": "Memry desktop app (Tauri)",
  "type": "module",
  "scripts": {
    "dev": "tauri dev",
    "build": "tauri build",
    "preview": "vite preview",
    "lint": "pnpm exec eslint --cache .",
    "typecheck": "pnpm exec tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest watch",
    "test:e2e": "playwright test",
    "cargo:check": "cd src-tauri && cargo check",
    "cargo:clippy": "cd src-tauri && cargo clippy -- -D warnings",
    "cargo:test": "cd src-tauri && cargo test",
    "cargo:fmt": "cd src-tauri && cargo fmt",
    "bindings:generate": "tsx scripts/generate-bindings.ts",
    "bindings:check": "tsx scripts/check-bindings.ts",
    "capability:check": "tsx scripts/capability-sanity-check.ts",
    "port:audit": "tsx scripts/port-audit.ts"
  },
  "dependencies": {},
  "devDependencies": {
    "@tauri-apps/cli": "^2.10",
    "@tauri-apps/api": "^2.10",
    "typescript": "^5.9.3",
    "tsx": "^4.19.2"
  }
}
```

- [ ] **Step 1.3: Write `apps/desktop-tauri/.gitignore`**

```
# Tauri
src-tauri/target/
src-tauri/Cargo.lock

# Vite
dist/
dist-ssr/

# Node
node_modules/
*.log

# OS
.DS_Store

# IDE
.vscode/*
!.vscode/extensions.json
.idea/

# Logs
logs/
npm-debug.log*
yarn-debug.log*
pnpm-debug.log*

# Test artifacts
test-results/
playwright-report/
```

- [ ] **Step 1.4: Write `apps/desktop-tauri/README.md`**

```markdown
# @memry/desktop-tauri

Tauri 2.x rewrite of the Memry desktop app. See
`docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md`
for the full migration design.

## Development

```bash
pnpm install              # from repo root
pnpm --filter @memry/desktop-tauri dev
```

Vite dev server on http://localhost:1420; Tauri window attaches automatically.

## Build

```bash
pnpm --filter @memry/desktop-tauri build
```

Produces unsigned `.app` under `src-tauri/target/release/bundle/macos/`.

## Status

- **M1 (current):** Skeleton + full renderer port with mock IPC layer. Visual
  parity with Electron achieved; no real backend logic yet.
```

- [ ] **Step 1.5: Verify workspace picks up the new package**

```bash
cat pnpm-workspace.yaml
```

Expected output contains `apps/*` glob — if so, no edit needed. If not, add `apps/*` under `packages:` list.

- [ ] **Step 1.6: Install dependencies to verify package.json is valid**

```bash
pnpm install
```

Expected: No errors. New package `@memry/desktop-tauri` appears in pnpm output.

- [ ] **Step 1.7: Commit**

```bash
git add apps/desktop-tauri/
git commit -m "m1(scaffold): create apps/desktop-tauri directory structure"
```

---

## Task 2: Initialize Rust backend scaffold

**Files:**
- Create: `apps/desktop-tauri/src-tauri/Cargo.toml`
- Create: `apps/desktop-tauri/src-tauri/build.rs`
- Create: `apps/desktop-tauri/src-tauri/tauri.conf.json`
- Create: `apps/desktop-tauri/src-tauri/capabilities/default.json`
- Create: `apps/desktop-tauri/src-tauri/src/main.rs`
- Create: `apps/desktop-tauri/src-tauri/src/lib.rs`
- Create: `apps/desktop-tauri/src-tauri/icons/icon.icns` (copied from Electron build assets)

- [ ] **Step 2.1: Copy icon assets from Electron build**

```bash
# Verify Electron icons exist
ls apps/desktop/build/icon.icns apps/desktop/build/icon.png 2>/dev/null

# Copy whatever exists to Tauri icons dir; Tauri CLI generates platform-specific assets from these
cp apps/desktop/build/icon.icns apps/desktop-tauri/src-tauri/icons/icon.icns || \
  echo "No icns found — will use Tauri default until M9 packaging"
cp apps/desktop/build/icon.png apps/desktop-tauri/src-tauri/icons/icon.png 2>/dev/null || true
```

If no icons exist yet, create a 1024x1024 placeholder PNG so scaffold is valid.

- [ ] **Step 2.2: Write `apps/desktop-tauri/src-tauri/Cargo.toml`**

```toml
[package]
name = "memry-desktop-tauri"
version = "2.0.0-alpha.1"
description = "Memry desktop app (Tauri)"
authors = ["Memry"]
edition = "2021"
default-run = "memry-desktop-tauri"

[build-dependencies]
tauri-build = { version = "2.0", features = [] }

[dependencies]
# Core Tauri
tauri = { version = "2.10", features = [] }
tauri-plugin-shell = "2.10"

# Declared for later milestones — unused at M1 but compile-verified
rusqlite = { version = "0.32", features = ["bundled", "load_extension"], default-features = false }
yrs = "0.21"
dryoc = "0.7"
tokio = { version = "1.41", features = ["full"] }
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "json"] }
tracing-appender = "0.2"
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
thiserror = "2.0"
specta = { version = "2.0.0-rc.20", features = ["derive"] }
tauri-specta = { version = "2.0.0-rc.21", features = ["typescript"] }

[features]
custom-protocol = ["tauri/custom-protocol"]
```

Note: `rusqlite`, `yrs`, `dryoc`, `tokio` are declared so `cargo check` exercises them but they're not imported from any `.rs` file at M1. This surfaces version incompatibilities early.

- [ ] **Step 2.3: Write `apps/desktop-tauri/src-tauri/build.rs`**

```rust
fn main() {
    tauri_build::build()
}
```

- [ ] **Step 2.4: Write `apps/desktop-tauri/src-tauri/tauri.conf.json`**

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Memry",
  "version": "2.0.0-alpha.1",
  "identifier": "com.memry.desktop-tauri",
  "build": {
    "beforeDevCommand": "pnpm vite",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "pnpm vite build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "title": "Memry",
        "width": 1400,
        "height": 900,
        "minWidth": 800,
        "minHeight": 600,
        "decorations": true,
        "resizable": true
      }
    ],
    "security": {
      "csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' ipc: https://ipc.localhost http://localhost:1420"
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/icon.png",
      "icons/icon.icns"
    ],
    "category": "Productivity"
  }
}
```

**CSP is intentionally narrow and stays that way.** Per spec Section 5.7,
the renderer makes zero outbound HTTPS calls for the entire migration. All
third-party traffic (LLM providers, sync server, attachment uploads) is
initiated by Rust via `reqwest` / `tokio-tungstenite` and returns to the
renderer via Tauri IPC (invoke result for small payloads, `Channel<u8>` for
streams). Do NOT widen `connect-src` when later milestones introduce AI
(M8.12) or networked sync (M6) — add a Rust command instead. If a reviewer
ever proposes whitelisting `https://api.openai.com` etc. in this CSP, push
back: the design explicitly routes that traffic through the Rust boundary
so an XSS cannot exfiltrate credentials.

- [ ] **Step 2.5: Write `apps/desktop-tauri/src-tauri/capabilities/default.json`**

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Default capability grants for Memry desktop app",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:window:allow-close",
    "core:window:allow-minimize",
    "core:window:allow-maximize",
    "core:window:allow-unmaximize",
    "core:window:allow-start-dragging"
  ]
}
```

- [ ] **Step 2.6: Write `apps/desktop-tauri/src-tauri/src/main.rs`**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    memry_desktop_tauri_lib::run()
}
```

- [ ] **Step 2.7: Write `apps/desktop-tauri/src-tauri/src/lib.rs`**

```rust
pub mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|_app| {
            tracing_subscriber::fmt()
                .with_env_filter(
                    tracing_subscriber::EnvFilter::try_from_default_env()
                        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("memry=info"))
                )
                .json()
                .init();
            tracing::info!("memry desktop-tauri booting (m1 scaffold)");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 2.8: Verify Rust scaffold compiles**

```bash
cd apps/desktop-tauri/src-tauri && cargo check
```

Expected: `Finished dev [unoptimized + debuginfo] target(s)` within 60s (warm) or 3-5min (cold). No errors. Warnings about unused dependencies (`rusqlite`, `yrs`, `dryoc`) are expected.

- [ ] **Step 2.9: Verify clippy is clean**

```bash
cd apps/desktop-tauri/src-tauri && cargo clippy -- -D warnings
```

Expected: Exit 0, no warnings treated as errors. If `rusqlite`/`yrs`/`dryoc` unused-import warnings surface, silence them at crate level via `#[allow(unused_imports)]` in `lib.rs`.

- [ ] **Step 2.10: Commit**

```bash
git add apps/desktop-tauri/src-tauri/ apps/desktop-tauri/.gitignore
git commit -m "m1(scaffold): init rust tauri 2.x backend with placeholder deps"
```

---

## Task 3: Configure Vite + React for Tauri

**Files:**
- Create: `apps/desktop-tauri/index.html`
- Create: `apps/desktop-tauri/vite.config.ts`
- Create: `apps/desktop-tauri/src/env.d.ts`
- Modify: `apps/desktop-tauri/package.json` (add React + Vite deps)

- [ ] **Step 3.1: Install React 19 + Vite 7 + Tailwind v4 deps**

```bash
pnpm --filter @memry/desktop-tauri add react@^19.2 react-dom@^19.2
pnpm --filter @memry/desktop-tauri add -D @vitejs/plugin-react@^5.1 vite@^7.3 @tailwindcss/vite@^4.1 tailwindcss@^4.1 postcss@^8.5 autoprefixer@^10.4 @types/react@^19.2 @types/react-dom@^19.2
```

Expected: Dependencies added to `package.json`; `pnpm install` completes without error.

- [ ] **Step 3.2: Write `apps/desktop-tauri/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Memry</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3.3: Write `apps/desktop-tauri/vite.config.ts`**

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceRoot = resolve(appRoot, '../..')

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(appRoot, 'src'),
      '@memry/contracts': resolve(workspaceRoot, 'packages/contracts/src'),
      '@memry/domain-inbox': resolve(workspaceRoot, 'packages/domain-inbox/src'),
      '@memry/domain-notes': resolve(workspaceRoot, 'packages/domain-notes/src'),
      '@memry/domain-tasks': resolve(workspaceRoot, 'packages/domain-tasks/src'),
      '@memry/rpc': resolve(workspaceRoot, 'packages/rpc/src'),
      '@memry/shared': resolve(workspaceRoot, 'packages/shared/src'),
      '@memry/sync-core': resolve(workspaceRoot, 'packages/sync-core/src')
    }
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: false
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target: 'es2022',
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG
  }
})
```

Note: Electron's `@memry/db-schema`, `@memry/storage-data`, `@memry/storage-vault` aliases are intentionally omitted — these packages contain Node-only code that renderer never imports at runtime. If any ported file tries to import from them, typecheck will surface it in Task 12.

- [ ] **Step 3.4: Write `apps/desktop-tauri/src/env.d.ts`**

```typescript
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MOCK_IPC?: 'true' | 'false'
  readonly TAURI_ENV_PLATFORM?: string
  readonly TAURI_ENV_ARCH?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
```

- [ ] **Step 3.5: Commit**

```bash
git add apps/desktop-tauri/package.json apps/desktop-tauri/vite.config.ts apps/desktop-tauri/index.html apps/desktop-tauri/src/env.d.ts
git commit -m "m1(scaffold): wire vite 7 + react 19 + tailwind v4 for tauri"
```

---

## Task 4: TypeScript configs

**Files:**
- Create: `apps/desktop-tauri/tsconfig.json`
- Create: `apps/desktop-tauri/tsconfig.node.json`
- Create: `apps/desktop-tauri/tsconfig.web.json`

- [ ] **Step 4.1: Write `apps/desktop-tauri/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"],
      "@memry/contracts/*": ["../../packages/contracts/src/*"],
      "@memry/contracts": ["../../packages/contracts/src"],
      "@memry/domain-inbox/*": ["../../packages/domain-inbox/src/*"],
      "@memry/domain-inbox": ["../../packages/domain-inbox/src"],
      "@memry/domain-notes/*": ["../../packages/domain-notes/src/*"],
      "@memry/domain-notes": ["../../packages/domain-notes/src"],
      "@memry/domain-tasks/*": ["../../packages/domain-tasks/src/*"],
      "@memry/domain-tasks": ["../../packages/domain-tasks/src"],
      "@memry/rpc/*": ["../../packages/rpc/src/*"],
      "@memry/rpc": ["../../packages/rpc/src"],
      "@memry/shared/*": ["../../packages/shared/src/*"],
      "@memry/shared": ["../../packages/shared/src"],
      "@memry/sync-core/*": ["../../packages/sync-core/src/*"],
      "@memry/sync-core": ["../../packages/sync-core/src"]
    }
  },
  "include": ["src", "tests", "scripts", "vite.config.ts"],
  "exclude": ["node_modules", "dist", "src-tauri/target"]
}
```

- [ ] **Step 4.2: Write `apps/desktop-tauri/tsconfig.node.json`** (for scripts + vite config)

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "composite": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["node"]
  },
  "include": ["scripts/**/*.ts", "vite.config.ts"]
}
```

- [ ] **Step 4.3: Write `apps/desktop-tauri/tsconfig.web.json`** (alias of root tsconfig for parity with Electron repo convention)

```json
{
  "extends": "./tsconfig.json",
  "include": ["src"]
}
```

- [ ] **Step 4.4: Install Node types for scripts**

```bash
pnpm --filter @memry/desktop-tauri add -D @types/node@^25.0
```

- [ ] **Step 4.5: Verify typecheck succeeds on empty project**

```bash
pnpm --filter @memry/desktop-tauri typecheck
```

Expected: `error TS18003: No inputs were found in config file` — this is OK because `src/` is still empty except `env.d.ts`. The error confirms tsconfig resolution works. If a different error appears, fix tsconfig.

- [ ] **Step 4.6: Commit**

```bash
git add apps/desktop-tauri/tsconfig*.json apps/desktop-tauri/package.json
git commit -m "m1(scaffold): add typescript configs with @memry/* + @/* path aliases"
```

---

## Task 5: Freeze `apps/desktop/` with FROZEN banner + CI path-guard

**Files:**
- Modify: `apps/desktop/README.md`
- Create: `.github/workflows/electron-freeze.yml`

- [ ] **Step 5.1: Check current `apps/desktop/README.md`**

```bash
head -20 apps/desktop/README.md 2>/dev/null || echo "README missing"
```

If README doesn't exist, create one. If it exists, we'll prepend the banner.

- [ ] **Step 5.2: Prepend FROZEN banner to `apps/desktop/README.md`**

If README exists, capture current content first:

```bash
if [ -f apps/desktop/README.md ]; then
  mv apps/desktop/README.md apps/desktop/README.md.bak
fi
```

Write new `apps/desktop/README.md`:

```markdown
# ⚠️ FROZEN — Electron desktop app (being migrated to Tauri)

**Status:** Frozen as of 2026-04-24. No new commits to `apps/desktop/**` until deletion.

**Migration target:** `apps/desktop-tauri/`

**Why frozen:** Memry is migrating from Electron to Tauri 2.x as a complete
greenfield rewrite. This directory is preserved only so the Tauri build can
reference the Electron renderer for source parity during M1 (see migration
spec: `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md`).

**For emergency bug fixes to Electron:** contact Kaan. Do not push directly.

**Scheduled deletion:** At M10 of the Tauri migration.

---

(Original contents preserved in `README.md.bak` for reference during migration.)
```

If there was no prior README, delete the "Original contents preserved" sentence and skip the `.bak` reference.

- [ ] **Step 5.3: Keep the bak file out of version control**

```bash
grep -q "README.md.bak" apps/desktop/.gitignore 2>/dev/null || echo "README.md.bak" >> apps/desktop/.gitignore
```

- [ ] **Step 5.4: Write CI path-guard workflow `.github/workflows/electron-freeze.yml`**

```yaml
name: Electron Freeze Guard

on:
  pull_request:
    branches: [main]
    paths:
      - 'apps/desktop/**'

jobs:
  check-frozen:
    runs-on: ubuntu-latest
    steps:
      - name: Allow if cutover or emergency-fix label present
        id: check-labels
        uses: actions/github-script@v7
        with:
          script: |
            const labels = context.payload.pull_request.labels.map(l => l.name);
            const allowed = ['migration/m10-cutover', 'migration/emergency-fix'];
            const match = labels.find(l => allowed.includes(l));
            if (match) {
              core.info(`Allowed by label: ${match}`);
              core.setOutput('allowed', 'true');
            } else {
              core.setOutput('allowed', 'false');
            }

      - name: Fail if apps/desktop/ modified without bypass label
        if: steps.check-labels.outputs.allowed != 'true'
        run: |
          echo "::error::apps/desktop/ is FROZEN during Tauri migration."
          echo "::error::Apply label 'migration/m10-cutover' for the M10 cutover PR,"
          echo "::error::or 'migration/emergency-fix' for a rare exception."
          echo "::error::Otherwise, direct to apps/desktop-tauri/."
          echo "::error::See apps/desktop/README.md for details."
          exit 1
```

This workflow fires on any PR touching `apps/desktop/**`. The label-based
bypass encodes the spec's freeze exception policy (Section "Electron freeze
discipline"). The two recognized bypass labels are:

- `migration/m10-cutover` — applied by Kaan on the single M10 cutover PR
  that does `git rm -rf apps/desktop/`.
- `migration/emergency-fix` — applied only when a pre-production blocker
  forces a tiny Electron patch before Tauri reaches parity. Expected use
  count across the migration: 0-1.

Both labels should be configured as **protected labels** in repo settings
so only Kaan can apply them. The guard itself is deleted in the M10 cutover
PR — alongside `apps/desktop/`, the workflow file is removed.

- [ ] **Step 5.5: Verify workflow YAML is valid**

```bash
# quick lint via shell
cat .github/workflows/electron-freeze.yml | head -3
```

Expected: first line is `name: Electron Freeze Guard`. Full YAML syntax validated by GitHub on push.

- [ ] **Step 5.6: Commit**

```bash
git add apps/desktop/README.md apps/desktop/.gitignore .github/workflows/electron-freeze.yml
git commit -m "m1(freeze): mark apps/desktop as frozen + add CI path-guard

Electron codebase frozen during Tauri migration. CI blocks any PR that
modifies apps/desktop/** paths. Original README preserved as .bak."
```

---

## Task 6: Delete `spikes/tauri-risk-discovery/`

**Files:**
- Delete: `spikes/tauri-risk-discovery/` (entire directory)

Rationale: Spike 0 findings are preserved in `docs/spikes/tauri-risk-discovery/` (findings.md, s1/s2/s3 reports, benchmarks). Only the throwaway prototype code is deleted per the spike's own README ("Code here will be deleted at the end of Spike 0").

- [ ] **Step 6.1: Verify findings are preserved before deletion**

```bash
ls docs/spikes/tauri-risk-discovery/findings.md \
   docs/spikes/tauri-risk-discovery/s1-blocknote-webview.md \
   docs/spikes/tauri-risk-discovery/s2-yjs-placement.md \
   docs/spikes/tauri-risk-discovery/s3-db-placement.md
```

Expected: All four files exist. If any is missing, STOP and restore before deletion.

- [ ] **Step 6.2: Remove the prototype directory**

```bash
git rm -rf spikes/tauri-risk-discovery/
```

Expected output: deletion list ending with `rm 'spikes/tauri-risk-discovery/README.md'` or similar. Hundreds of files.

- [ ] **Step 6.3: If `spikes/` is now empty, remove the directory**

```bash
rmdir spikes 2>/dev/null || echo "spikes/ still contains other content — leaving"
```

- [ ] **Step 6.4: Commit**

```bash
git commit -m "m1(cleanup): delete spikes/tauri-risk-discovery throwaway code

Spike 0 findings preserved in docs/spikes/tauri-risk-discovery/. Prototype
code deleted per spike README. See design spec for migration plan."
```

---

## Task 7: Install all renderer dependencies

**Files:**
- Modify: `apps/desktop-tauri/package.json`

This task mirrors the `dependencies` block from `apps/desktop/package.json`, omitting Node-only packages (`better-sqlite3`, `sodium-native`, `electron-store`, `electron-log`, `electron-updater`, `electron-builder`, `keytar`, `classic-level`, `chokidar`, `sharp`, `pdf-parse`, `metascraper*`, `drizzle-orm`, `drizzle-kit`, `ws`, `@electron-toolkit/*`, `@electron/rebuild`, `electron`).

- [ ] **Step 7.1: Install renderer runtime dependencies**

Run this long block as-is — each dep version matches the Electron renderer exactly so visual/behavior parity is preserved:

```bash
pnpm --filter @memry/desktop-tauri add \
  @ai-sdk/anthropic@^3.0.58 \
  @ai-sdk/openai@^3.0.41 \
  @blocknote/code-block@^0.47.1 \
  @blocknote/core@^0.47.1 \
  @blocknote/react@^0.47.1 \
  @blocknote/server-util@0.47.1 \
  @blocknote/shadcn@^0.47.1 \
  @blocknote/xl-ai@^0.47.1 \
  @dnd-kit/core@^6.3.1 \
  @dnd-kit/modifiers@^9.0.0 \
  @dnd-kit/sortable@^10.0.0 \
  @dnd-kit/utilities@^3.2.2 \
  @emoji-mart/data@^1.2.1 \
  @emoji-mart/react@^1.1.1 \
  @headless-tree/core@^1.6.1 \
  @headless-tree/react@^1.6.1 \
  @hugeicons/core-free-icons@^4.0.0 \
  @hugeicons/react@^1.1.6 \
  @huggingface/transformers@^3.8.1 \
  @radix-ui/react-accordion@^1.2.12 \
  @radix-ui/react-alert-dialog@^1.1.15 \
  @radix-ui/react-avatar@^1.1.11 \
  @radix-ui/react-checkbox@^1.3.3 \
  @radix-ui/react-collapsible@^1.1.12 \
  @radix-ui/react-context-menu@^2.2.16 \
  @radix-ui/react-dialog@^1.1.15 \
  @radix-ui/react-dropdown-menu@^2.1.16 \
  @radix-ui/react-hover-card@^1.1.15 \
  @radix-ui/react-label@^2.1.8 \
  @radix-ui/react-popover@^1.1.15 \
  @radix-ui/react-radio-group@^1.3.8 \
  @radix-ui/react-scroll-area@^1.2.10 \
  @radix-ui/react-select@^2.2.6 \
  @radix-ui/react-separator@^1.1.8 \
  @radix-ui/react-slider@^1.3.6 \
  @radix-ui/react-slot@^1.2.4 \
  @radix-ui/react-switch@^1.2.6 \
  @radix-ui/react-tabs@^1.1.13 \
  @radix-ui/react-toggle@^1.1.10 \
  @radix-ui/react-toggle-group@^1.1.11 \
  @radix-ui/react-tooltip@^1.2.8 \
  @react-sigma/core@^5.0.6 \
  @react-sigma/layout-forceatlas2@^5.0.6 \
  @tanstack/react-query@^5.90.16 \
  @tanstack/react-table@^8.21.3 \
  @tanstack/react-virtual@^3.13.16 \
  @tiptap/extension-bubble-menu@^3.14.0 \
  @tiptap/extension-image@^3.14.0 \
  @tiptap/extension-link@^3.14.0 \
  @tiptap/extension-list@^3.14.0 \
  @tiptap/extension-placeholder@^3.14.0 \
  @tiptap/extension-table@^3.14.0 \
  @tiptap/extension-table-cell@^3.14.0 \
  @tiptap/extension-table-header@^3.14.0 \
  @tiptap/extension-table-row@^3.14.0 \
  @tiptap/extension-task-item@^3.14.0 \
  @tiptap/extension-task-list@^3.14.0 \
  @tiptap/react@^3.14.0 \
  @tiptap/starter-kit@^3.14.0 \
  @tiptap/suggestion@^3.14.0 \
  ai@^6.0.116 \
  cborg@^4.5.8 \
  class-variance-authority@^0.7.1 \
  clsx@^2.1.1 \
  cmdk@^1.1.1 \
  cobe@^0.6.5 \
  date-fns@^4.1.0 \
  emoji-mart@^5.6.0 \
  framer-motion@^12.23.26 \
  fuzzysort@^3.1.0 \
  graphology@^0.26.0 \
  graphology-layout-forceatlas2@^0.10.1 \
  graphology-types@^0.24.8 \
  gray-matter@^4.0.3 \
  idb@^8.0.3 \
  input-otp@^1.4.2 \
  jose@^6.1.3 \
  libsodium-wrappers-sumo@^0.8.2 \
  marked@^17.0.1 \
  mime-types@^3.0.2 \
  motion@^12.23.26 \
  nanoid@^5.1.6 \
  next-themes@^0.4.6 \
  openai@^6.15.0 \
  pako@^2.1.0 \
  pdfjs-dist@5.4.296 \
  qrcode.react@^4.2.0 \
  radix-ui@^1.4.3 \
  react-complex-tree@^2.6.1 \
  react-day-picker@^9.13.0 \
  react-pdf@^10.3.0 \
  react-player@^3.4.0 \
  react-tweet@^3.3.0 \
  sigma@^3.0.2 \
  sonner@^2.0.7 \
  tailwind-merge@^3.4.0 \
  tailwindcss-animate@^1.0.7 \
  tippy.js@^6.3.7 \
  y-indexeddb@^9.0.12 \
  y-prosemirror@^1.3.7 \
  y-protocols@^1.0.7 \
  yjs@^13.6.29 \
  zod@^4.3.4
```

Expected: `pnpm install` completes. Large dep count — ~200MB of node_modules.

- [ ] **Step 7.2: Install font packages (exact same versions as Electron)**

```bash
pnpm --filter @memry/desktop-tauri add -D \
  @fontsource-variable/crimson-pro@^5.2.8 \
  @fontsource-variable/dm-sans@^5.2.8 \
  @fontsource-variable/geist@^5.2.8 \
  @fontsource-variable/inter@^5.2.8 \
  @fontsource-variable/jetbrains-mono@^5.2.8 \
  @fontsource-variable/playfair-display@^5.2.8 \
  @fontsource-variable/space-grotesk@^5.2.10 \
  @fontsource/gelasio@^5.2.8
```

- [ ] **Step 7.3: Install dev deps for testing + linting**

```bash
pnpm --filter @memry/desktop-tauri add -D \
  @playwright/test@^1.57.0 \
  @testing-library/jest-dom@^6.9.1 \
  @testing-library/react@^16.3.1 \
  @testing-library/user-event@^14.6.1 \
  @vitest/coverage-v8@^4.0.16 \
  @vitest/ui@^4.0.16 \
  eslint@^9.39.2 \
  eslint-plugin-react@^7.37.5 \
  eslint-plugin-react-hooks@^7.0.1 \
  happy-dom@^20.8.9 \
  prettier@^3.7.4 \
  shadcn@^3.6.2 \
  vitest@4
```

- [ ] **Step 7.4: Verify installation is complete and lock file is updated**

```bash
pnpm --filter @memry/desktop-tauri list --depth 0 | head -40
git status apps/desktop-tauri/package.json pnpm-lock.yaml
```

Expected: package.json shows installed deps; pnpm-lock.yaml is updated.

- [ ] **Step 7.5: Commit**

```bash
git add apps/desktop-tauri/package.json pnpm-lock.yaml
git commit -m "m1(deps): install renderer dependencies matching electron versions

Copies all runtime + dev dependencies from apps/desktop/package.json except
Node-only packages (better-sqlite3, sodium-native, electron-*, drizzle-orm,
sharp, pdf-parse, metascraper, ws, keytar, classic-level, chokidar)."
```

---

## Task 8: Port Tailwind config + global CSS + font entry point

**Files:**
- Copy: `apps/desktop/src/renderer/src/assets/base.css` → `apps/desktop-tauri/src/assets/base.css`
- Copy: `apps/desktop/src/renderer/src/assets/main.css` → `apps/desktop-tauri/src/assets/main.css`

- [ ] **Step 8.1: Copy CSS assets verbatim**

```bash
cp apps/desktop/src/renderer/src/assets/base.css apps/desktop-tauri/src/assets/base.css
cp apps/desktop/src/renderer/src/assets/main.css apps/desktop-tauri/src/assets/main.css
```

- [ ] **Step 8.2: Inspect for any Electron-specific CSS references**

```bash
grep -in 'electron\|window\.api\|chrome-extension' apps/desktop-tauri/src/assets/*.css || echo "No Electron refs in CSS"
```

Expected: `No Electron refs in CSS`. If any surface, remove those lines inline.

- [ ] **Step 8.3: Tailwind v4 requires imports in CSS — verify config**

Inspect `apps/desktop/src/renderer/src/assets/main.css` for Tailwind v4 `@import "tailwindcss"` syntax. If present, nothing to change. If it uses v3 `@tailwind` directives, migrate to v4:

```css
/* Replace @tailwind base; @tailwind components; @tailwind utilities; with: */
@import "tailwindcss";
```

If changes are needed, apply them to `apps/desktop-tauri/src/assets/main.css` only (NOT the Electron source — it's frozen).

- [ ] **Step 8.4: Verify main.css compiles with Vite (quick smoke)**

Temporarily create a minimal `src/main.tsx` + `src/App.tsx` to test:

```bash
cat > apps/desktop-tauri/src/App.tsx <<'EOF'
export default function App() {
  return <div className="p-4 text-lg font-bold">Memry Tauri scaffold</div>
}
EOF

cat > apps/desktop-tauri/src/main.tsx <<'EOF'
import './assets/main.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
EOF

cd apps/desktop-tauri && pnpm exec vite build
```

Expected: Vite build succeeds, output under `dist/`. If Tailwind fails, adjust imports.

Clean up the smoke build (real `main.tsx` / `App.tsx` come from Task 12):

```bash
rm -rf apps/desktop-tauri/dist apps/desktop-tauri/src/App.tsx apps/desktop-tauri/src/main.tsx
```

- [ ] **Step 8.5: Commit**

```bash
git add apps/desktop-tauri/src/assets/
git commit -m "m1(styles): port tailwind config + global css from electron renderer"
```

---

## Task 9: Create typed `invoke` wrapper with mock router

**Files:**
- Create: `apps/desktop-tauri/src/lib/ipc/invoke.ts`

- [ ] **Step 9.1: Write the invoke wrapper**

```typescript
// apps/desktop-tauri/src/lib/ipc/invoke.ts
import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { mockRouter } from './mocks'

/**
 * Typed wrapper around Tauri's invoke.
 *
 * At M1, every call is routed through the mock router to produce fake data
 * so the ported Electron renderer can render every page. Subsequent milestones
 * (M2+) implement real Rust commands; the wrapper flips to Tauri-backed
 * invoke per-command as implementations come online.
 */
export async function invoke<TResponse = unknown>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<TResponse> {
  const useMock = shouldUseMock(cmd)

  if (useMock) {
    return mockRouter<TResponse>(cmd, args)
  }

  return tauriInvoke<TResponse>(cmd, args ?? {})
}

/**
 * Decides whether a command should be served by the mock router or routed to
 * the real Tauri backend. At M1, every command uses mock. Future milestones
 * extend the `realCommands` set with commands whose Rust implementation has
 * landed.
 */
const realCommands = new Set<string>([
  // No real commands at M1 — all mocked. M2+ adds entries here.
])

function shouldUseMock(cmd: string): boolean {
  if (import.meta.env.VITE_MOCK_IPC === 'false') {
    return false
  }
  return !realCommands.has(cmd)
}
```

- [ ] **Step 9.2: Commit**

```bash
git add apps/desktop-tauri/src/lib/ipc/invoke.ts
git commit -m "m1(ipc): add typed invoke wrapper with mock/real router"
```

---

## Task 10: Create mock IPC fixtures

**Files:**
- Create: `apps/desktop-tauri/src/lib/ipc/mocks/types.ts`
- Create: `apps/desktop-tauri/src/lib/ipc/mocks/index.ts`
- Create: `apps/desktop-tauri/src/lib/ipc/mocks/notes.ts`
- Create: `apps/desktop-tauri/src/lib/ipc/mocks/tasks.ts`
- Create: `apps/desktop-tauri/src/lib/ipc/mocks/calendar.ts`
- Create: `apps/desktop-tauri/src/lib/ipc/mocks/inbox.ts`
- Create: `apps/desktop-tauri/src/lib/ipc/mocks/journal.ts`
- Create: `apps/desktop-tauri/src/lib/ipc/mocks/folders.ts`
- Create: `apps/desktop-tauri/src/lib/ipc/mocks/tags.ts`
- Create: `apps/desktop-tauri/src/lib/ipc/mocks/bookmarks.ts`
- Create: `apps/desktop-tauri/src/lib/ipc/mocks/templates.ts`
- Create: `apps/desktop-tauri/src/lib/ipc/mocks/settings.ts`
- Create: `apps/desktop-tauri/src/lib/ipc/mocks/vault.ts`
- Create: `apps/desktop-tauri/src/lib/ipc/mocks/auth.ts`
- Create: `apps/desktop-tauri/src/lib/ipc/mocks/sync.ts`
- Create: `apps/desktop-tauri/src/lib/ipc/mocks/search.ts`
- Create: `apps/desktop-tauri/src/lib/ipc/mocks/graph.ts`
- Create: `apps/desktop-tauri/src/lib/ipc/mocks/properties.ts`
- Create: `apps/desktop-tauri/src/lib/ipc/mocks/reminders.ts`
- Create: `apps/desktop-tauri/src/lib/ipc/mocks/saved-filters.ts`
- Create: `apps/desktop-tauri/src/lib/ipc/mocks/updater.ts`

- [ ] **Step 10.1: Write shared types**

```typescript
// apps/desktop-tauri/src/lib/ipc/mocks/types.ts

export type MockHandler = (args: unknown) => Promise<unknown>

export type MockRouteMap = Record<string, MockHandler>

/**
 * Helper for deterministic mock IDs across the session.
 */
let counter = 0
export function mockId(prefix: string): string {
  counter += 1
  return `${prefix}-${counter.toString().padStart(6, '0')}`
}

export function mockTimestamp(daysAgo = 0): number {
  const now = Date.now()
  return now - daysAgo * 86_400_000
}
```

- [ ] **Step 10.2: Write the router**

```typescript
// apps/desktop-tauri/src/lib/ipc/mocks/index.ts
import type { MockRouteMap } from './types'
import { notesRoutes } from './notes'
import { tasksRoutes } from './tasks'
import { calendarRoutes } from './calendar'
import { inboxRoutes } from './inbox'
import { journalRoutes } from './journal'
import { foldersRoutes } from './folders'
import { tagsRoutes } from './tags'
import { bookmarksRoutes } from './bookmarks'
import { templatesRoutes } from './templates'
import { settingsRoutes } from './settings'
import { vaultRoutes } from './vault'
import { authRoutes } from './auth'
import { syncRoutes } from './sync'
import { searchRoutes } from './search'
import { graphRoutes } from './graph'
import { propertiesRoutes } from './properties'
import { remindersRoutes } from './reminders'
import { savedFiltersRoutes } from './saved-filters'
import { updaterRoutes } from './updater'

const routes: MockRouteMap = {
  ...notesRoutes,
  ...tasksRoutes,
  ...calendarRoutes,
  ...inboxRoutes,
  ...journalRoutes,
  ...foldersRoutes,
  ...tagsRoutes,
  ...bookmarksRoutes,
  ...templatesRoutes,
  ...settingsRoutes,
  ...vaultRoutes,
  ...authRoutes,
  ...syncRoutes,
  ...searchRoutes,
  ...graphRoutes,
  ...propertiesRoutes,
  ...remindersRoutes,
  ...savedFiltersRoutes,
  ...updaterRoutes
}

export async function mockRouter<T>(cmd: string, args?: unknown): Promise<T> {
  const handler = routes[cmd]
  if (!handler) {
    console.warn(`[mock-ipc] unimplemented command: ${cmd}`, args)
    throw new Error(`Mock IPC: command "${cmd}" not implemented`)
  }
  try {
    const result = await handler(args)
    return result as T
  } catch (err) {
    console.error(`[mock-ipc] handler error for "${cmd}":`, err)
    throw err
  }
}
```

- [ ] **Step 10.3: Write `notes.ts` mock with 12 sample notes across 3 folders**

```typescript
// apps/desktop-tauri/src/lib/ipc/mocks/notes.ts
import type { MockRouteMap } from './types'
import { mockId, mockTimestamp } from './types'

interface MockNote {
  id: string
  title: string
  body: string
  folderId: string | null
  createdAt: number
  updatedAt: number
  deletedAt: number | null
  properties: Record<string, unknown>
}

const notes: MockNote[] = [
  { id: 'note-1', title: 'Welcome to Memry (Tauri)', body: 'This is a mock note for M1 visual parity.', folderId: 'folder-1', createdAt: mockTimestamp(7), updatedAt: mockTimestamp(1), deletedAt: null, properties: {} },
  { id: 'note-2', title: 'Second note', body: 'Mock note body with **bold** and *italic*.', folderId: 'folder-1', createdAt: mockTimestamp(6), updatedAt: mockTimestamp(2), deletedAt: null, properties: {} },
  { id: 'note-3', title: 'Daily journal entry', body: '## Today\n- Task one\n- Task two', folderId: 'folder-1', createdAt: mockTimestamp(5), updatedAt: mockTimestamp(0), deletedAt: null, properties: {} },
  { id: 'note-4', title: 'Ideas list', body: 'Random brainstorm of mock content.', folderId: 'folder-2', createdAt: mockTimestamp(4), updatedAt: mockTimestamp(0), deletedAt: null, properties: {} },
  { id: 'note-5', title: 'Travel plans', body: 'Check destinations and dates.', folderId: 'folder-2', createdAt: mockTimestamp(3), updatedAt: mockTimestamp(0), deletedAt: null, properties: {} },
  { id: 'note-6', title: 'Reading notes', body: 'Book highlights.', folderId: 'folder-2', createdAt: mockTimestamp(2), updatedAt: mockTimestamp(0), deletedAt: null, properties: {} },
  { id: 'note-7', title: 'Archive draft', body: 'Older content.', folderId: 'folder-3', createdAt: mockTimestamp(30), updatedAt: mockTimestamp(29), deletedAt: null, properties: {} },
  { id: 'note-8', title: 'Meeting notes 2026-03-18', body: 'Mock meeting summary.', folderId: 'folder-3', createdAt: mockTimestamp(25), updatedAt: mockTimestamp(25), deletedAt: null, properties: {} },
  { id: 'note-9', title: 'Project Alpha overview', body: 'Mock project details.', folderId: 'folder-3', createdAt: mockTimestamp(20), updatedAt: mockTimestamp(10), deletedAt: null, properties: {} },
  { id: 'note-10', title: 'Untitled note', body: '', folderId: null, createdAt: mockTimestamp(1), updatedAt: mockTimestamp(1), deletedAt: null, properties: {} },
  { id: 'note-11', title: 'Untitled note 2', body: '', folderId: null, createdAt: mockTimestamp(0), updatedAt: mockTimestamp(0), deletedAt: null, properties: {} },
  { id: 'note-12', title: 'Türkçe başlık testi', body: 'Türkçe karakter testi için note.', folderId: 'folder-1', createdAt: mockTimestamp(0), updatedAt: mockTimestamp(0), deletedAt: null, properties: {} }
]

export const notesRoutes: MockRouteMap = {
  notes_list: async () => notes.filter(n => n.deletedAt === null),
  notes_list_by_folder: async (args) => {
    const { folderId } = (args as { folderId: string }) ?? { folderId: '' }
    return notes.filter(n => n.folderId === folderId && n.deletedAt === null)
  },
  notes_get: async (args) => {
    const { id } = args as { id: string }
    const note = notes.find(n => n.id === id)
    if (!note) throw new Error(`Note ${id} not found`)
    return note
  },
  notes_create: async (args) => {
    const { title, body, folderId, properties } = (args as Partial<MockNote>) ?? {}
    const note: MockNote = {
      id: mockId('note'),
      title: title ?? 'Untitled',
      body: body ?? '',
      folderId: folderId ?? null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      deletedAt: null,
      properties: properties ?? {}
    }
    notes.unshift(note)
    return note
  },
  notes_update: async (args) => {
    const { id, ...changes } = args as { id: string } & Partial<MockNote>
    const note = notes.find(n => n.id === id)
    if (!note) throw new Error(`Note ${id} not found`)
    Object.assign(note, changes, { updatedAt: Date.now() })
    return note
  },
  notes_delete: async (args) => {
    const { id } = args as { id: string }
    const note = notes.find(n => n.id === id)
    if (!note) return { ok: false }
    note.deletedAt = Date.now()
    return { ok: true }
  }
}
```

- [ ] **Step 10.4: Write `tasks.ts` mock (15 tasks across priorities and statuses)**

```typescript
// apps/desktop-tauri/src/lib/ipc/mocks/tasks.ts
import type { MockRouteMap } from './types'
import { mockId, mockTimestamp } from './types'

interface MockTask {
  id: string
  title: string
  status: 'todo' | 'in-progress' | 'done' | 'canceled'
  priority: 'low' | 'medium' | 'high' | 'urgent'
  projectId: string | null
  dueAt: number | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
  tags: string[]
  noteId: string | null
}

const tasks: MockTask[] = Array.from({ length: 15 }, (_, i) => {
  const status = (['todo', 'in-progress', 'done', 'canceled'] as const)[i % 4]
  const priority = (['low', 'medium', 'high', 'urgent'] as const)[i % 4]
  return {
    id: `task-${i + 1}`,
    title: `Mock task #${i + 1}`,
    status,
    priority,
    projectId: i < 10 ? 'project-1' : 'project-2',
    dueAt: i < 8 ? mockTimestamp(-1 * (i - 4)) : null,
    createdAt: mockTimestamp(10 - i),
    updatedAt: mockTimestamp(i < 5 ? 0 : 1),
    completedAt: status === 'done' ? mockTimestamp(0) : null,
    tags: i % 3 === 0 ? ['mock', 'm1'] : [],
    noteId: null
  }
})

export const tasksRoutes: MockRouteMap = {
  tasks_list: async () => tasks,
  tasks_list_by_project: async (args) => {
    const { projectId } = args as { projectId: string }
    return tasks.filter(t => t.projectId === projectId)
  },
  tasks_get: async (args) => {
    const { id } = args as { id: string }
    const t = tasks.find(x => x.id === id)
    if (!t) throw new Error(`Task ${id} not found`)
    return t
  },
  tasks_create: async (args) => {
    const input = args as Partial<MockTask>
    const task: MockTask = {
      id: mockId('task'),
      title: input.title ?? 'New task',
      status: input.status ?? 'todo',
      priority: input.priority ?? 'medium',
      projectId: input.projectId ?? null,
      dueAt: input.dueAt ?? null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: null,
      tags: input.tags ?? [],
      noteId: input.noteId ?? null
    }
    tasks.unshift(task)
    return task
  },
  tasks_update: async (args) => {
    const { id, ...changes } = args as { id: string } & Partial<MockTask>
    const t = tasks.find(x => x.id === id)
    if (!t) throw new Error(`Task ${id} not found`)
    Object.assign(t, changes, { updatedAt: Date.now() })
    return t
  },
  tasks_delete: async (args) => {
    const { id } = args as { id: string }
    const idx = tasks.findIndex(x => x.id === id)
    if (idx >= 0) tasks.splice(idx, 1)
    return { ok: true }
  }
}
```

- [ ] **Step 10.5: Write `folders.ts` with 3 folders matching notes data**

```typescript
// apps/desktop-tauri/src/lib/ipc/mocks/folders.ts
import type { MockRouteMap } from './types'
import { mockId, mockTimestamp } from './types'

interface MockFolder {
  id: string
  name: string
  parentId: string | null
  color: string | null
  icon: string | null
  createdAt: number
  updatedAt: number
}

const folders: MockFolder[] = [
  { id: 'folder-1', name: 'Inbox', parentId: null, color: '#4ade80', icon: 'inbox', createdAt: mockTimestamp(30), updatedAt: mockTimestamp(0) },
  { id: 'folder-2', name: 'Projects', parentId: null, color: '#60a5fa', icon: 'folder', createdAt: mockTimestamp(30), updatedAt: mockTimestamp(0) },
  { id: 'folder-3', name: 'Archive', parentId: null, color: '#94a3b8', icon: 'archive', createdAt: mockTimestamp(30), updatedAt: mockTimestamp(0) }
]

export const foldersRoutes: MockRouteMap = {
  folders_list: async () => folders,
  folders_get: async (args) => {
    const { id } = args as { id: string }
    const f = folders.find(x => x.id === id)
    if (!f) throw new Error(`Folder ${id} not found`)
    return f
  },
  folders_create: async (args) => {
    const input = args as Partial<MockFolder>
    const f: MockFolder = {
      id: mockId('folder'),
      name: input.name ?? 'New folder',
      parentId: input.parentId ?? null,
      color: input.color ?? null,
      icon: input.icon ?? null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    folders.push(f)
    return f
  },
  folders_update: async (args) => {
    const { id, ...changes } = args as { id: string } & Partial<MockFolder>
    const f = folders.find(x => x.id === id)
    if (!f) throw new Error(`Folder ${id} not found`)
    Object.assign(f, changes, { updatedAt: Date.now() })
    return f
  },
  folders_delete: async (args) => {
    const { id } = args as { id: string }
    const idx = folders.findIndex(x => x.id === id)
    if (idx >= 0) folders.splice(idx, 1)
    return { ok: true }
  }
}
```

- [ ] **Step 10.6: Write the remaining 16 mock files using the same pattern**

Apply the same pattern (10-20 mock items each, basic CRUD handlers) for:

`calendar.ts`, `inbox.ts`, `journal.ts`, `tags.ts`, `bookmarks.ts`, `templates.ts`, `settings.ts`, `vault.ts`, `auth.ts`, `sync.ts`, `search.ts`, `graph.ts`, `properties.ts`, `reminders.ts`, `saved-filters.ts`, `updater.ts`.

Each file exports a `<name>Routes: MockRouteMap`. For each command the Electron renderer uses on that domain, provide a handler. Commands can be discovered from `apps/desktop/src/preload/api/*` and `apps/desktop/src/renderer/src/services/*-service.ts`.

Example skeleton for one that's mostly stubs (auth):

```typescript
// apps/desktop-tauri/src/lib/ipc/mocks/auth.ts
import type { MockRouteMap } from './types'

export const authRoutes: MockRouteMap = {
  auth_status: async () => ({ state: 'unlocked', deviceId: 'mock-device-1', email: 'kaan@mock.memry' }),
  auth_unlock: async () => ({ ok: true }),
  auth_lock: async () => ({ ok: true }),
  auth_request_otp: async () => ({ ok: true, expiresInSeconds: 300 }),
  auth_submit_otp: async () => ({ ok: true }),
  auth_register_device: async () => ({ deviceId: 'mock-device-1', publicKey: 'mock-pubkey' }),
  auth_enable_biometric: async () => ({ ok: false, reason: 'not-implemented-in-m1' })
}
```

For each of the 16 remaining files, write handlers covering every command the renderer actually calls. If a command is missing, the router throws at runtime — add it then.

- [ ] **Step 10.7: Verify all mock files compile**

```bash
pnpm --filter @memry/desktop-tauri typecheck
```

Expected: No type errors in `src/lib/ipc/mocks/**`. If errors, fix inline.

- [ ] **Step 10.8: Commit**

```bash
git add apps/desktop-tauri/src/lib/ipc/mocks/
git commit -m "m1(ipc): add mock ipc fixtures for all 19 domains

Each domain exports a MockRouteMap with 10-20 fixture items and basic CRUD
handlers. Router logs unimplemented commands for discovery as the renderer
port proceeds."
```

---

## Task 11: Create typed `listen` wrapper

**Files:**
- Create: `apps/desktop-tauri/src/lib/ipc/events.ts`

- [ ] **Step 11.1: Write the events module**

```typescript
// apps/desktop-tauri/src/lib/ipc/events.ts
import { listen as tauriListen, type UnlistenFn } from '@tauri-apps/api/event'

type EventCallback<T> = (payload: T) => void | Promise<void>

/**
 * Typed wrapper around Tauri's listen. At M1, no backend events are emitted
 * (Rust stubs are empty). The wrapper registers the listener so UI code that
 * subscribes to events (e.g. `sync-progress`) doesn't crash — callbacks
 * simply never fire until M2+ emit real events.
 */
export async function listen<T = unknown>(
  event: string,
  callback: EventCallback<T>
): Promise<UnlistenFn> {
  return tauriListen<T>(event, (tauriEvent) => {
    void callback(tauriEvent.payload as T)
  })
}

/**
 * Helper: subscribe once and auto-unsubscribe after first fire.
 */
export async function listenOnce<T = unknown>(
  event: string,
  callback: EventCallback<T>
): Promise<void> {
  const unlisten = await listen<T>(event, async (payload) => {
    await callback(payload)
    unlisten()
  })
}
```

- [ ] **Step 11.2: Verify it typechecks**

```bash
pnpm --filter @memry/desktop-tauri typecheck
```

Expected: Clean.

- [ ] **Step 11.3: Commit**

```bash
git add apps/desktop-tauri/src/lib/ipc/events.ts
git commit -m "m1(ipc): add typed listen wrapper for tauri events"
```

---

## Task 12: Port renderer entry + utility modules

**Files:**
- Copy: `apps/desktop/src/renderer/src/main.tsx` → `apps/desktop-tauri/src/main.tsx` (with modifications)
- Copy: `apps/desktop/src/renderer/src/App.tsx` → `apps/desktop-tauri/src/App.tsx` (with modifications)
- Copy: `apps/desktop/src/renderer/src/lib/**` → `apps/desktop-tauri/src/lib/**` (excluding `ipc/` which was created in Task 9-11)
- Copy: `apps/desktop/src/renderer/src/hooks/**` → `apps/desktop-tauri/src/hooks/**`
- Copy: `apps/desktop/src/renderer/src/contexts/**` → `apps/desktop-tauri/src/contexts/**`
- Copy: `apps/desktop/src/renderer/src/data/**` → `apps/desktop-tauri/src/data/**` (if exists)
- Copy: `apps/desktop/src/renderer/src/types/**` → `apps/desktop-tauri/src/types/**`

- [ ] **Step 12.1: Copy the entry point files**

```bash
cp apps/desktop/src/renderer/src/main.tsx apps/desktop-tauri/src/main.tsx
cp apps/desktop/src/renderer/src/App.tsx apps/desktop-tauri/src/App.tsx
```

- [ ] **Step 12.2: Copy utility modules (preserving structure)**

```bash
# Copy lib/ but skip any subfolder the port would collide with
rsync -av --exclude='ipc/' apps/desktop/src/renderer/src/lib/ apps/desktop-tauri/src/lib/

rsync -av apps/desktop/src/renderer/src/hooks/ apps/desktop-tauri/src/hooks/
rsync -av apps/desktop/src/renderer/src/contexts/ apps/desktop-tauri/src/contexts/
rsync -av apps/desktop/src/renderer/src/data/ apps/desktop-tauri/src/data/ 2>/dev/null || true
rsync -av apps/desktop/src/renderer/src/types/ apps/desktop-tauri/src/types/
```

- [ ] **Step 12.3: Verify nothing Electron-specific snuck into `lib/ipc/` subfolder**

```bash
ls apps/desktop-tauri/src/lib/ipc/
```

Expected: Only `invoke.ts`, `events.ts`, and `mocks/` folder. If any Electron file is there, delete it (Electron had `lib/ipc-error.ts` etc. — those are already expected to ship at `lib/ipc-error.ts` NOT inside `lib/ipc/`).

- [ ] **Step 12.4: Typecheck — will fail, note the failures**

```bash
pnpm --filter @memry/desktop-tauri typecheck 2>&1 | head -60
```

Expected: Dozens of errors referencing `window.api`, `electron`, or Electron-only package imports. These are fixed in Task 15. Proceed.

- [ ] **Step 12.5: Commit partial port**

```bash
git add apps/desktop-tauri/src/
git commit -m "m1(port): copy renderer entry + lib/hooks/contexts/types from electron

Paths preserved exactly; only ipc/ subfolder is freshly authored (Task 9-11).
Typecheck fails with window.api references — fixed in Task 15."
```

---

## Task 13: Port `components/`

**Files:**
- Copy: `apps/desktop/src/renderer/src/components/**` → `apps/desktop-tauri/src/components/**`

- [ ] **Step 13.1: Copy components**

```bash
rsync -av apps/desktop/src/renderer/src/components/ apps/desktop-tauri/src/components/
```

- [ ] **Step 13.2: Verify directory tree matches Electron source**

```bash
diff <(cd apps/desktop/src/renderer/src/components && find . -type f | sort) \
     <(cd apps/desktop-tauri/src/components && find . -type f | sort)
```

Expected: Empty diff (identical file lists).

- [ ] **Step 13.3: Commit**

```bash
git add apps/desktop-tauri/src/components/
git commit -m "m1(port): copy components/ verbatim from electron renderer"
```

---

## Task 14: Port `features/`, `pages/`, `services/`, `sync/`

**Files:**
- Copy: `apps/desktop/src/renderer/src/features/**` → `apps/desktop-tauri/src/features/**`
- Copy: `apps/desktop/src/renderer/src/pages/**` → `apps/desktop-tauri/src/pages/**`
- Copy: `apps/desktop/src/renderer/src/services/**` → `apps/desktop-tauri/src/services/**`
- Copy: `apps/desktop/src/renderer/src/sync/**` → `apps/desktop-tauri/src/sync/**`

- [ ] **Step 14.1: Copy each top-level directory**

```bash
rsync -av apps/desktop/src/renderer/src/features/ apps/desktop-tauri/src/features/
rsync -av apps/desktop/src/renderer/src/pages/ apps/desktop-tauri/src/pages/
rsync -av apps/desktop/src/renderer/src/services/ apps/desktop-tauri/src/services/
rsync -av apps/desktop/src/renderer/src/sync/ apps/desktop-tauri/src/sync/ 2>/dev/null || true
```

- [ ] **Step 14.2: Confirm file counts**

```bash
echo "Electron renderer files:"
find apps/desktop/src/renderer/src -type f \( -name '*.ts' -o -name '*.tsx' \) | wc -l

echo "Tauri renderer files:"
find apps/desktop-tauri/src -type f \( -name '*.ts' -o -name '*.tsx' \) | wc -l
```

Expected: Tauri count is within a few files of Electron count (accounting for the 3 IPC files we authored + `env.d.ts`). If Tauri is significantly lower, a rsync step was missed.

- [ ] **Step 14.3: Commit**

```bash
git add apps/desktop-tauri/src/features/ apps/desktop-tauri/src/pages/ apps/desktop-tauri/src/services/ apps/desktop-tauri/src/sync/
git commit -m "m1(port): copy features/, pages/, services/, sync/ from electron renderer"
```

---

## Task 15: Rewrite `window.api.*` call sites → `invoke()`, delete Electron shims

**Files:**
- Modify: Every ported file that references `window.api.*`, `ipcRenderer`, `@electron-toolkit`, or `window.electron` (50+ files per earlier scan)
- Create: `apps/desktop-tauri/scripts/port-audit.ts` (helper script)
- Delete: Files that are pure Electron shims (e.g. anything in `lib/ipc-error.ts` that wraps electron IPC)

This is the largest task in M1. The approach is:
1. Build a script that finds every `window.api.X.Y(args)` call site and reports the command name mapping.
2. Mechanically rewrite each file.
3. Delete files that are pure Electron preload shims and have no equivalent in Tauri.

- [ ] **Step 15.1: Write the port-audit script**

```typescript
// apps/desktop-tauri/scripts/port-audit.ts
import { readFileSync, writeFileSync } from 'node:fs'
import { globSync } from 'node:fs'
import { resolve, relative } from 'node:path'

const root = resolve(__dirname, '../src')

const files = globSync('**/*.{ts,tsx}', { cwd: root, absolute: true })

interface Hit {
  file: string
  line: number
  text: string
  kind: 'window.api' | 'ipcRenderer' | 'electron-toolkit' | 'window.electron'
}

const hits: Hit[] = []
for (const file of files) {
  const content = readFileSync(file, 'utf-8')
  const lines = content.split('\n')
  lines.forEach((text, i) => {
    if (/window\.api\./.test(text)) hits.push({ file, line: i + 1, text: text.trim(), kind: 'window.api' })
    if (/\bipcRenderer\b/.test(text)) hits.push({ file, line: i + 1, text: text.trim(), kind: 'ipcRenderer' })
    if (/@electron-toolkit/.test(text)) hits.push({ file, line: i + 1, text: text.trim(), kind: 'electron-toolkit' })
    if (/window\.electron\b/.test(text)) hits.push({ file, line: i + 1, text: text.trim(), kind: 'window.electron' })
  })
}

console.log(`Total hits: ${hits.length}`)
const byKind = hits.reduce((acc, h) => {
  acc[h.kind] = (acc[h.kind] ?? 0) + 1
  return acc
}, {} as Record<string, number>)
console.log('By kind:', byKind)

const byFile = new Map<string, number>()
for (const h of hits) byFile.set(h.file, (byFile.get(h.file) ?? 0) + 1)
console.log(`Files affected: ${byFile.size}`)
console.log('\nTop 20 files by hit count:')
Array.from(byFile.entries()).sort((a, b) => b[1] - a[1]).slice(0, 20)
  .forEach(([f, c]) => console.log(`  ${c.toString().padStart(4)} ${relative(root, f)}`))
```

- [ ] **Step 15.2: Run the audit**

```bash
cd apps/desktop-tauri && pnpm port:audit
```

Expected output: ~366 hits across ~50 files (matching the earlier grep). This is the surface area to rewrite.

- [ ] **Step 15.3: Rewrite call sites in `services/` (simplest wins — these are thin wrappers)**

For each file in `apps/desktop-tauri/src/services/*-service.ts`:

1. Replace the import `import type { ... } from '@memry/rpc/...'` — keep as-is (types still live in packages/).
2. Replace the body pattern:
   ```typescript
   // BEFORE:
   return window.api.notes.create(input)
   // AFTER:
   return invoke('notes_create', input)
   ```
3. Add import at top of file:
   ```typescript
   import { invoke } from '@/lib/ipc/invoke'
   ```

Command name mapping rule: Electron `window.api.<domain>.<method>` → Tauri `<domain>_<method>` converting camelCase to snake_case. Examples:
- `window.api.notes.create(x)` → `invoke('notes_create', x)`
- `window.api.notes.listByFolder({folderId})` → `invoke('notes_list_by_folder', {folderId})`
- `window.api.calendar.getEventsForRange(range)` → `invoke('calendar_get_events_for_range', range)`
- `window.api.sync.pushNow()` → `invoke('sync_push_now')`

Work through each service file in order. After each file, run `pnpm typecheck` to confirm errors decrease.

- [ ] **Step 15.4: Rewrite call sites in `hooks/` and `contexts/`**

Same mechanical rewrite. Many hooks consume `window.api.*` directly instead of going through services — those get the same find/replace.

For `onCreated`/`onUpdated`/`onDeleted`-style listeners:
```typescript
// BEFORE:
const unsub = window.api.notes.onCreated((event) => {...})
// AFTER:
import { listen } from '@/lib/ipc/events'
const unsubscribe = await listen('note-created', (event) => {...})
```

- [ ] **Step 15.5: Rewrite call sites in remaining files (pages/, features/, components/)**

Same mechanical rewrite pattern. After rewriting all files, run:

```bash
cd apps/desktop-tauri && pnpm port:audit
```

Expected: Zero hits. If hits remain, keep rewriting.

- [ ] **Step 15.6: Delete pure-Electron shim files**

Identify files that exist only to wrap Electron APIs (no value in Tauri):

```bash
# Search for files whose entire purpose is Electron preload wiring
grep -rln 'contextBridge\|electronAPI' apps/desktop-tauri/src/ 2>/dev/null
```

Delete any hit — these are preload-layer files that shouldn't be in the renderer at all. Example likely candidates:
- Any file importing `@electron-toolkit/preload`
- Any file using `contextBridge.exposeInMainWorld`

```bash
# For each file listed by the grep above:
# git rm <file>
```

Also consider deleting/simplifying:
- `src/lib/ipc-error.ts` — if it wraps electron-specific error codes, rewrite for AppError instead (see Section 5.2 of the spec); for M1, a minimal version is sufficient:

```typescript
// apps/desktop-tauri/src/lib/ipc-error.ts (REPLACED with simpler version)
export function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message || fallback
  if (typeof err === 'string') return err
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message: unknown }).message) || fallback
  }
  return fallback
}
```

- [ ] **Step 15.7: Check that `src/preload/` is NOT present in Tauri (it never got copied, but verify)**

```bash
ls apps/desktop-tauri/src/preload 2>/dev/null && echo "ERROR: preload dir exists, should not" || echo "OK: no preload dir"
```

Expected: `OK: no preload dir`.

- [ ] **Step 15.8: Verify typecheck (expect some remaining errors from packages/ node-only imports)**

```bash
pnpm --filter @memry/desktop-tauri typecheck 2>&1 | tee /tmp/m1-typecheck.log | head -50
```

Expected behavior: Error count should drop dramatically (from hundreds to <30). Remaining errors are likely:
- Imports from `@memry/storage-data` or `@memry/storage-vault` (Node-only packages not aliased)
- References to `window.api` in files we missed
- Missing types in mock-stub returns

Fix remaining errors file by file:
- For `@memry/storage-*` imports — these should not exist in renderer code; if present, find what the file actually needs and replace the import with an inline type or a local mock.
- For any straggler `window.api` — rewrite.
- For type mismatches with mock returns — widen the mock's return type or tighten the service's expected type.

- [ ] **Step 15.9: Once typecheck is clean, commit**

```bash
cd apps/desktop-tauri && pnpm typecheck
# Expected: no errors

git add apps/desktop-tauri/src/ apps/desktop-tauri/scripts/port-audit.ts
git commit -m "m1(port): rewrite window.api call sites to invoke() mocks

366 call sites across ~50 files rewritten to invoke('<module>_<action>', args).
Event listeners rewritten from window.api.X.onEvent() to listen('event-name').
Electron preload shims deleted. Typecheck clean."
```

---

## Task 16: Rust command skeleton + capability sanity check script

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/commands/mod.rs`
- Create: `apps/desktop-tauri/scripts/capability-sanity-check.ts`
- Modify: `apps/desktop-tauri/src-tauri/src/lib.rs` (register empty command group)

- [ ] **Step 16.1: Write the empty commands module**

```rust
// apps/desktop-tauri/src-tauri/src/commands/mod.rs
//! IPC command surface exposed to the renderer.
//!
//! At M1 no commands are implemented — the renderer is fed by the JS-side
//! mock router in `src/lib/ipc/mocks/`. M2+ introduces real commands per
//! domain (notes, tasks, crypto, sync, etc.). When a domain's Rust
//! implementation lands, entries are added here and the corresponding
//! mock entry is removed from `src/lib/ipc/invoke.ts`'s realCommands set.

use tauri::Builder;

pub fn register<R: tauri::Runtime>(builder: Builder<R>) -> Builder<R> {
    builder.invoke_handler(tauri::generate_handler![])
}
```

- [ ] **Step 16.2: Wire commands module into `lib.rs`**

Modify `apps/desktop-tauri/src-tauri/src/lib.rs`:

```rust
pub mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|_app| {
            tracing_subscriber::fmt()
                .with_env_filter(
                    tracing_subscriber::EnvFilter::try_from_default_env()
                        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("memry=info"))
                )
                .json()
                .init();
            tracing::info!("memry desktop-tauri booting (m1 scaffold)");
            Ok(())
        });

    commands::register(builder)
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 16.3: Verify Rust still compiles**

```bash
cd apps/desktop-tauri/src-tauri && cargo check
```

Expected: Clean.

- [ ] **Step 16.4: Write capability sanity check script**

```typescript
// apps/desktop-tauri/scripts/capability-sanity-check.ts
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const appRoot = resolve(__dirname, '..')

interface TauriConfig {
  app?: { security?: { csp?: string } }
  plugins?: Record<string, unknown>
}

interface Capability {
  identifier: string
  permissions: (string | { identifier: string })[]
}

const conf = JSON.parse(readFileSync(resolve(appRoot, 'src-tauri/tauri.conf.json'), 'utf-8')) as TauriConfig
const cap = JSON.parse(readFileSync(resolve(appRoot, 'src-tauri/capabilities/default.json'), 'utf-8')) as Capability

const pluginsInConf = Object.keys(conf.plugins ?? {})
const permissions = cap.permissions.map((p) =>
  typeof p === 'string' ? p : p.identifier
)

// Check: every plugin in tauri.conf.json has at least one grant in capabilities
const missing: string[] = []
for (const plugin of pluginsInConf) {
  const hasGrant = permissions.some((perm) => perm.startsWith(`${plugin}:`))
  if (!hasGrant) missing.push(plugin)
}

if (missing.length > 0) {
  console.error(`❌ Capability sanity check failed.`)
  console.error(`Plugins without grants in capabilities/default.json:`)
  for (const m of missing) console.error(`  - ${m}`)
  process.exit(1)
}

console.log(`✅ Capability sanity check passed (${pluginsInConf.length} plugins, ${permissions.length} grants)`)
```

- [ ] **Step 16.5: Run the script to verify it works**

```bash
pnpm --filter @memry/desktop-tauri capability:check
```

Expected: `✅ Capability sanity check passed (0 plugins, N grants)`. With M1's empty plugins config, the check should pass trivially.

- [ ] **Step 16.6: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/commands/ apps/desktop-tauri/src-tauri/src/lib.rs apps/desktop-tauri/scripts/capability-sanity-check.ts
git commit -m "m1(backend): add empty commands module + capability sanity check

Commands module is the landing pad for M2+ Rust implementations. Capability
sanity check prevents the 'silent denial = hang' failure mode (S3 obs #11)."
```

---

## Task 17: Type generation pipeline (tauri-specta skeleton)

**Files:**
- Create: `apps/desktop-tauri/scripts/generate-bindings.ts`
- Create: `apps/desktop-tauri/scripts/check-bindings.ts`
- Create: `apps/desktop-tauri/src/generated/bindings.ts`
- Create: `apps/desktop-tauri/src-tauri/src/bin/generate_bindings.rs`
- Modify: `apps/desktop-tauri/src-tauri/Cargo.toml` (add bin entry)

- [ ] **Step 17.1: Write the empty generated bindings file**

```typescript
// apps/desktop-tauri/src/generated/bindings.ts
// !! AUTO-GENERATED BY `pnpm bindings:generate` !!
// Do not edit this file manually. It is regenerated from Rust command
// signatures in apps/desktop-tauri/src-tauri/src/commands/.
//
// At M1 there are no commands yet; this file is an empty export to preserve
// the import path for consumers. Subsequent milestones replace contents.

export {}
```

- [ ] **Step 17.2: Write Rust bindings generator binary**

```rust
// apps/desktop-tauri/src-tauri/src/bin/generate_bindings.rs
//! Writes TypeScript bindings for Tauri commands into the renderer.
//!
//! At M1 there are no commands; this binary is a no-op stub. M2+ updates
//! this with `specta::ts::export_named_datatypes` once domain structs and
//! commands exist.

use std::fs;
use std::path::PathBuf;

fn main() {
    let output = PathBuf::from("../src/generated/bindings.ts");

    let contents = r#"// !! AUTO-GENERATED BY `pnpm bindings:generate` !!
// Do not edit this file manually. It is regenerated from Rust command
// signatures in apps/desktop-tauri/src-tauri/src/commands/.
//
// At M1 there are no commands yet; this file is an empty export to preserve
// the import path for consumers. Subsequent milestones replace contents.

export {}
"#;

    fs::write(&output, contents).expect("failed to write bindings");
    println!("Wrote bindings to {}", output.display());
}
```

- [ ] **Step 17.3: Register the bin in Cargo.toml**

Append to `apps/desktop-tauri/src-tauri/Cargo.toml`:

```toml
[[bin]]
name = "generate_bindings"
path = "src/bin/generate_bindings.rs"
```

- [ ] **Step 17.4: Write the TypeScript-side runner scripts**

```typescript
// apps/desktop-tauri/scripts/generate-bindings.ts
import { execSync } from 'node:child_process'
import { resolve } from 'node:path'

const appRoot = resolve(__dirname, '..')

console.log('Running cargo to regenerate bindings.ts...')
execSync('cargo run --bin generate_bindings --quiet', {
  cwd: resolve(appRoot, 'src-tauri'),
  stdio: 'inherit'
})
console.log('✅ Bindings regenerated')
```

```typescript
// apps/desktop-tauri/scripts/check-bindings.ts
import { execSync } from 'node:child_process'
import { resolve } from 'node:path'

const appRoot = resolve(__dirname, '..')

console.log('Regenerating bindings.ts and checking for drift...')
execSync('pnpm bindings:generate', {
  cwd: appRoot,
  stdio: 'inherit'
})

try {
  execSync('git diff --exit-code -- src/generated/bindings.ts', {
    cwd: appRoot,
    stdio: 'inherit'
  })
  console.log('✅ Bindings in sync')
} catch {
  console.error('❌ Bindings drift detected')
  console.error('Run `pnpm bindings:generate` and commit the result.')
  process.exit(1)
}
```

- [ ] **Step 17.5: Run the scripts to verify they work**

```bash
pnpm --filter @memry/desktop-tauri bindings:generate
pnpm --filter @memry/desktop-tauri bindings:check
```

Expected: Both succeed. No git diff produced (since bindings.ts matches the hardcoded M1 stub).

- [ ] **Step 17.6: Commit**

```bash
git add apps/desktop-tauri/scripts/generate-bindings.ts apps/desktop-tauri/scripts/check-bindings.ts apps/desktop-tauri/src/generated/bindings.ts apps/desktop-tauri/src-tauri/src/bin/ apps/desktop-tauri/src-tauri/Cargo.toml
git commit -m "m1(tooling): add tauri-specta binding generation pipeline

Empty stub at M1. Regenerator + CI drift checker ready for M2+ to populate
with real command + type definitions."
```

---

## Task 18: First `pnpm dev` smoke run — boot, navigate all routes, fix blockers

**Files:** None (verification task; may require small fixes to ported files as runtime issues surface)

- [ ] **Step 18.1: Start the dev server**

```bash
cd apps/desktop-tauri && pnpm dev
```

Expected: Tauri window opens showing the Memry renderer. Vite dev server on port 1420 serves the app.

If it fails to boot, common causes:
- Vite build error — fix import path / syntax error shown in terminal.
- Rust compile error — fix in `src-tauri/src/lib.rs`.
- WebView blank — check DevTools (Cmd+Opt+I) for JS errors; likely mock command not implemented.

- [ ] **Step 18.2: Open DevTools (Cmd+Opt+I) and check for console errors**

Expected: Some warnings about `[mock-ipc] unimplemented command: X` for any command not yet in the mock router. This is expected — add missing commands to the appropriate mock file and hot-reload.

- [ ] **Step 18.3: Walk through every route**

Navigate through the app sidebar / tabs, visiting each major area:
- Notes (all folders, create/delete a note, open an existing note)
- Tasks (task list, create a task)
- Calendar (month/week view)
- Inbox
- Journal
- Graph
- Settings (all tabs)
- Templates
- Bookmarks
- Search / command palette

For each route, check:
- Does it render?
- Do fonts load?
- Do icons appear?
- Are colors/theme correct?

Record any broken routes in a TODO list; fix blockers.

- [ ] **Step 18.4: Fix blockers discovered during walkthrough**

For each broken route:
1. Open DevTools, read the error.
2. If it's a missing mock command, add it to the appropriate `mocks/*.ts`.
3. If it's a type error in a component, fix the type.
4. If it's a runtime error from packaging (e.g., missing CSS import), add the import.
5. Reload the page (Cmd+R inside the Tauri window).

Iterate until every route renders.

- [ ] **Step 18.5: Test basic interactions**

- [ ] Type into the BlockNote editor — characters appear, no crash
- [ ] Theme toggle (usually in settings) — light/dark mode switches
- [ ] Command palette (Cmd+K or Cmd+P) — opens
- [ ] Keyboard shortcuts behave as expected (at least open palette, close modal)

- [ ] **Step 18.6: Commit any runtime fixes**

```bash
git add apps/desktop-tauri/
git commit -m "m1(port): fix runtime issues surfaced by first dev boot

- Added missing mock commands: <list from fixes>
- Fixed <ported file>: <issue>
- Patched <ported file>: <issue>"
```

---

## Task 19: Visual parity smoke + production build verification

**Files:** None (verification; screenshots saved to `docs/spikes/tauri-risk-discovery/benchmarks/m1-parity/`)

- [ ] **Step 19.1: Open Electron dev build in parallel**

In one terminal:

```bash
cd apps/desktop && pnpm dev
```

Keep the Electron window open.

- [ ] **Step 19.2: Open Tauri dev build**

In a second terminal:

```bash
cd apps/desktop-tauri && pnpm dev
```

- [ ] **Step 19.3: Side-by-side visual comparison**

Place both windows side by side. For each route (notes list, task list, calendar, inbox, journal, graph, settings, templates), compare:
- Sidebar / nav layout
- Typography (font family, size, weight, line height)
- Colors (primary, accent, borders, text)
- Spacing (padding, margins)
- Icons and avatars
- Buttons (style, hover states)
- Cards (shadows, borders)
- Tables (row height, header style)
- Animations (visible on theme toggle, modal open)

Record per-route notes of any visible diffs. Save screenshots (macOS: Cmd+Shift+4 then click window) to `docs/spikes/tauri-risk-discovery/benchmarks/m1-parity/` for reference.

If diffs exist:
- Missing font → check `main.tsx` font imports match Electron exactly
- Wrong color → check CSS ported correctly (`assets/main.css`, `assets/base.css`)
- Wrong spacing → check Tailwind theme tokens ported correctly
- Wrong icon → check icon library installed + rendered correctly

Fix diffs inline.

- [ ] **Step 19.4: Type-check and clippy after fixes**

```bash
pnpm --filter @memry/desktop-tauri typecheck
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy
```

Expected: All clean.

- [ ] **Step 19.5: Run production build**

```bash
pnpm --filter @memry/desktop-tauri build
```

Expected: Tauri build completes; `.app` bundle written to `src-tauri/target/release/bundle/macos/Memry.app`. Build time: 3-5 minutes cold.

- [ ] **Step 19.6: Smoke-test the production bundle**

```bash
open apps/desktop-tauri/src-tauri/target/release/bundle/macos/Memry.app
```

Expected: App opens. Navigate through routes — same as dev but with production CSS/JS. If anything looks broken in prod that worked in dev, it's likely a Vite prod-mode asset issue (Risk #22); fix by adjusting `vite.config.ts` asset handling.

- [ ] **Step 19.7: Run the port audit one final time to confirm clean port**

```bash
pnpm --filter @memry/desktop-tauri port:audit
```

Expected: `Total hits: 0`. If any surface, rewrite them (Task 15 pattern).

- [ ] **Step 19.8: Run all verification gates**

```bash
cd apps/desktop-tauri
pnpm typecheck
pnpm lint
pnpm cargo:check
pnpm cargo:clippy
pnpm capability:check
pnpm bindings:check
```

Expected: Every command exits 0.

- [ ] **Step 19.9: Final commit**

```bash
git add docs/spikes/tauri-risk-discovery/benchmarks/m1-parity/
git commit -m "m1: achieve visual parity with electron on macos

- Side-by-side screenshot comparison documented in benchmarks/m1-parity/
- All routes navigable with mock data; dev + prod builds verified
- Typecheck, lint, cargo check, clippy, capability check, bindings check: all green
- Port audit: 0 window.api hits remaining

Ready for M2 (DB + schemas + migrations)."
```

---

## Final acceptance gate (before declaring M1 done)

Run this checklist before moving to M2:

- [ ] `pnpm --filter @memry/desktop-tauri typecheck` exits 0
- [ ] `pnpm --filter @memry/desktop-tauri lint` exits 0
- [ ] `pnpm --filter @memry/desktop-tauri cargo:check` exits 0
- [ ] `pnpm --filter @memry/desktop-tauri cargo:clippy -- -D warnings` exits 0
- [ ] `pnpm --filter @memry/desktop-tauri capability:check` exits 0
- [ ] `pnpm --filter @memry/desktop-tauri bindings:check` exits 0
- [ ] `pnpm --filter @memry/desktop-tauri port:audit` reports 0 hits
- [ ] `pnpm --filter @memry/desktop-tauri dev` opens a window with every route renderable
- [ ] `pnpm --filter @memry/desktop-tauri build` produces an unsigned `.app`
- [ ] Production `.app` opens and renders the same as dev
- [ ] Side-by-side screenshot comparison with Electron shows no visible diff
- [ ] BlockNote editor boots and accepts typing (no persistence expected at M1)
- [ ] Theme toggle switches light/dark
- [ ] Command palette opens
- [ ] `apps/desktop/` directory is untouched (git log shows no changes after Task 5)
- [ ] `spikes/tauri-risk-discovery/` is deleted; `docs/spikes/tauri-risk-discovery/` preserved
- [ ] All 19 tasks are committed with `m1(<scope>)` prefixed messages

If all items pass, M1 is complete. File a PR; M2 starts on the next branch.

---

## Next step

After M1 merges, invoke `superpowers:writing-plans` again with the M2 spec section (DB + schemas + migrations) as input. M2 plan will include the 29 migration ports from Drizzle to hand-written SQL, rusqlite state setup, per-table struct definitions, and the first real Rust commands — at which point the renderer begins swapping mocks for real data per Section 4 "Mock swap model for M2–M8" in the spec.
