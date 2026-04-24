# M1 Phase C — Renderer Dependencies + Global Styles

Temiz session prompt. Phase B tamamlandıktan sonra başlat.

---

## PROMPT START

You are implementing **Phase C of Milestone M1** for Memry's Electron→Tauri migration.

### Context

**Repo:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk`
**Branch:** `spike/tauri-risk-discovery`
**Plan:** `docs/superpowers/plans/2026-04-24-m1-tauri-skeleton-and-renderer-port.md`

### Prerequisite

**Phase B complete.** Verify:

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk
test -f apps/desktop-tauri/package.json                 # Phase A
head -3 apps/desktop/README.md | grep -q "FROZEN"       # Phase B
test ! -d spikes/tauri-risk-discovery                    # Phase B
```

If any fails, STOP.

### Your scope

Execute **Tasks 7, 8** from the plan:

- **Task 7:** Install all renderer dependencies (React 19 runtime deps, fonts, dev deps for testing/linting). Three `pnpm add` blocks in the plan — run each verbatim.
- **Task 8:** Port `apps/desktop/src/renderer/src/assets/base.css` and `main.css` into `apps/desktop-tauri/src/assets/`. Verify Tailwind v4 compile succeeds via a smoke Vite build.

### Methodology

1. **Invoke `superpowers:using-superpowers`** first.
2. **Read Tasks 7 and 8** from the plan file verbatim.
3. **No substitutions.** Every package name + version in Task 7.1, 7.2, 7.3 must match exactly. If `pnpm add` fails for a package (network issue, version taken down), STOP and report — do not downgrade/swap without approval.
4. **Task 8.3 Tailwind version detection:** Read the Electron source (`apps/desktop/src/renderer/src/assets/main.css`). If it uses Tailwind v4 `@import "tailwindcss"` syntax, nothing to rewrite. If it uses v3 `@tailwind base;` etc., migrate to v4 syntax **in the Tauri copy only** — NEVER edit the Electron source.
5. **Task 8.4 smoke build:** The plan creates temporary `main.tsx` + `App.tsx` to test Vite builds correctly. After the smoke verifies, delete these files. Do not skip cleanup.

### TDD notes

Phase C is package install + CSS copy — no logic to unit test. Verification gates:

- After Task 7.1: `pnpm --filter @memry/desktop-tauri list | grep -c '@blocknote'` returns at least 5 (core, react, shadcn, xl-ai, code-block)
- After Task 7.2: `pnpm --filter @memry/desktop-tauri list | grep -c '@fontsource'` returns 8 (7 variable + 1 gelasio)
- After Task 7.3: `pnpm --filter @memry/desktop-tauri list | grep -E 'vitest|playwright'` shows both
- After Task 8.4: `pnpm --filter @memry/desktop-tauri build 2>&1` reports Tailwind compile success, then cleanup leaves no temp files

### Constraints

- **Do not install Node-only packages** that the spec excludes: `better-sqlite3`, `sodium-native`, `electron`, `electron-*`, `drizzle-orm`, `drizzle-kit`, `sharp`, `pdf-parse`, `metascraper*`, `ws`, `keytar`, `classic-level`, `chokidar`, `@electron-toolkit/*`. If the plan includes one by mistake, DO NOT install it — report to user.
- **Versions match Electron exactly** for visual parity. Do not "upgrade while you're at it."
- **Cross-check installed deps against** `apps/desktop/package.json` — after Task 7, spot-check 10 random renderer deps and confirm same version pinning.

### Known gotcha

`pnpm install --ignore-workspace` regression mentioned in Spike 0 (S2/S3 observation #8). The `.npmrc` flag alone is not always enough on pnpm 10.30.x. If `pnpm add` behaves strangely (installs into workspace root instead of app), add `--ignore-workspace` CLI flag.

### Acceptance criteria (Phase C done when all pass)

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk

# Deps installed
test -d apps/desktop-tauri/node_modules/@blocknote/core
test -d apps/desktop-tauri/node_modules/@fontsource-variable/geist
test -d apps/desktop-tauri/node_modules/yjs
test -d apps/desktop-tauri/node_modules/vitest
test -d apps/desktop-tauri/node_modules/@playwright/test

# CSS ported
test -f apps/desktop-tauri/src/assets/base.css
test -f apps/desktop-tauri/src/assets/main.css

# No Electron-only deps leaked
! pnpm --filter @memry/desktop-tauri list 2>/dev/null | grep -q 'better-sqlite3\|electron-store\|keytar'

# pnpm-lock updated
git status --short pnpm-lock.yaml | grep -q "M"

# Commits landed
git log --oneline | grep -c "m1(deps)"    # ≥ 1
git log --oneline | grep -c "m1(styles)"  # ≥ 1
```

### When done

Report:

```
Phase C complete.
Tasks covered: 7, 8
Commits: 2 (<first_hash>..<last_hash>)
Installed packages: ~100 runtime + ~8 fonts + ~15 dev
CSS assets: base.css, main.css (Tailwind v4 verified compiling)
Verification:
  - All @blocknote, @fontsource, @radix, @tanstack packages present
  - No Electron-only packages installed
  - pnpm-lock.yaml updated

Next: Phase D — prompts/m1-phase-d-mock-ipc.md
Blockers: <none | list>
```

### Ready

1. Invoke `superpowers:using-superpowers`.
2. Read plan Tasks 7 and 8.
3. Verify prerequisites.
4. Start Task 7.

## PROMPT END
