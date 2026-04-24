# M1 Phase J — Dev Smoke + Playwright E2E + Visual Parity + Production Build

Temiz session prompt. Phase I tamamlandıktan sonra başlat. **Son phase — M1 acceptance gate burada kapatılır.** Playwright e2e zorunlu.

---

## PROMPT START

You are implementing **Phase J of Milestone M1** — the final phase. This closes M1's acceptance gate by running dev boot smoke, writing Playwright WebKit e2e tests for every route, validating visual parity with Electron, and confirming production build works.

### Context

**Repo:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk`
**Branch:** `spike/tauri-risk-discovery`
**Plan:** `docs/superpowers/plans/2026-04-24-m1-tauri-skeleton-and-renderer-port.md`
**Spec:** `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md` Section 4 M1 acceptance gate, Section 6.1 (carried-forward risks from Spike 0).

### Prerequisite

**Phase I complete.** Verify:

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk
pnpm --filter @memry/desktop-tauri typecheck
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy
pnpm --filter @memry/desktop-tauri capability:check
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri port:audit 2>&1 | grep -q 'Total hits: 0'
pnpm --filter @memry/desktop-tauri test
```

All must exit 0. If any fails, STOP and fix before Phase J.

### Your scope

Execute **Tasks 18, 19** from the plan, plus **mandatory Playwright e2e test suite** covering every route.

- **Task 18:** First `pnpm dev` run, DevTools inspection, walk every route, fix blockers (missing mocks, ported-file runtime errors)
- **Task 19 + E2E addition:** Visual parity side-by-side with Electron, Playwright WebKit tests for every route, production build verification

### Methodology

**Invoke `superpowers:using-superpowers`** first. For test writing, invoke `superpowers:test-driven-development`. For systematic debugging of runtime errors, invoke `superpowers:systematic-debugging`.

### Step-by-step

#### Step J.1 — First dev boot (Task 18.1)

```bash
cd apps/desktop-tauri && pnpm dev
```

Expected: Tauri window opens with Memry UI. If fails:
- **Rust compile error:** check terminal, fix in `src-tauri/src/lib.rs`
- **Vite error:** check terminal, fix in `vite.config.ts` or ported file
- **Blank webview:** open DevTools (Cmd+Opt+I), look for JS errors. Most likely: missing mock command surfaced as unhandled promise rejection.

Do NOT declare dev boot working until you see the full UI (sidebar, main area, any content).

#### Step J.2 — Console audit (Task 18.2)

With DevTools open, scroll through the console. Expected warnings:
- `[mock-ipc] unimplemented command: X` — add X to appropriate `src/lib/ipc/mocks/<domain>.ts`
- Any genuine JS errors (undefined variable, etc.) — debug and fix

For each missing mock command:
1. Determine the correct domain
2. Add handler returning a sensible default value
3. Reload webview (Cmd+R)
4. Verify command now works

#### Step J.3 — Route walk (Task 18.3)

Navigate to every major route via the app sidebar/tabs. For each route, verify:
- Page renders (not blank, not error)
- Fonts load
- Icons appear
- Colors/theme correct

Minimum route list:
- Notes (all folders, open a note, create a new note)
- Tasks (task list + kanban if applicable)
- Calendar (month + week view)
- Inbox
- Journal
- Graph
- Settings (every settings tab)
- Templates
- Bookmarks
- Search / command palette

For every broken route, invoke `superpowers:systematic-debugging`, find root cause, fix, commit with `m1(port): fix <specific issue>` message.

**Iterate until every route renders.** Do not proceed to Step J.4 with broken routes.

#### Step J.4 — Interaction smoke (Task 18.5)

- Type into BlockNote editor — characters appear
- Theme toggle — light/dark switches
- Command palette (Cmd+K) — opens
- Create a note via mock — appears in list

Fix any blocker.

#### Step J.5 — Playwright E2E test suite (mandatory, spec Section 6.1)

Set up Playwright for Tauri WebKit and write e2e tests covering every route.

**Setup:**

1. Install Playwright browsers:

```bash
pnpm --filter @memry/desktop-tauri exec playwright install webkit
```

2. Create `apps/desktop-tauri/playwright.config.ts`:

```typescript
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e/specs',
  timeout: 30_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:1420',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] }
    }
  ],
  webServer: {
    command: 'pnpm vite',
    url: 'http://localhost:1420',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000
  }
})
```

This runs tests against the Vite dev server (not the full Tauri app). At M1, backend is mock-only anyway, so Vite-only is sufficient. Real Tauri runtime testing comes in M5+ when backend commands matter.

3. Create helper: `apps/desktop-tauri/e2e/fixtures/test-base.ts`:

```typescript
import { test as base, expect } from '@playwright/test'

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.goto('/')
    await use(page)
  }
})

export { expect }
```

**Write e2e tests — one spec per route, TDD-style:**

For each route, write a test that:
1. Navigates to the route (via sidebar click or direct URL)
2. Asserts a known element is visible (page-specific)
3. Asserts no console errors fired during navigation
4. Screenshots for visual regression baseline

Example `apps/desktop-tauri/e2e/specs/notes.spec.ts`:

```typescript
import { test, expect } from '../fixtures/test-base'

test.describe('Notes route', () => {
  test('notes list renders with mock fixtures', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })

    // Navigate (adjust selector for actual sidebar button)
    await page.getByRole('link', { name: /notes/i }).first().click()

    // Assert at least one note title is visible (mock has 12)
    await expect(page.locator('.bn-editor, [data-testid="note-item"]').first()).toBeVisible()

    // No console errors
    expect(consoleErrors).toEqual([])

    // Baseline screenshot
    await expect(page).toHaveScreenshot('notes-list.png', { maxDiffPixels: 100 })
  })

  test('note editor opens on click', async ({ page }) => {
    await page.getByRole('link', { name: /notes/i }).first().click()
    await page.locator('[data-testid="note-item"]').first().click()
    await expect(page.locator('.bn-editor')).toBeVisible()
  })

  test('BlockNote accepts typing', async ({ page }) => {
    await page.getByRole('link', { name: /notes/i }).first().click()
    await page.locator('[data-testid="note-item"]').first().click()
    await page.locator('.bn-editor').click()
    await page.keyboard.type('e2e test input')
    await expect(page.locator('.bn-editor')).toContainText('e2e test input')
  })
})
```

**Write one spec per route. Minimum specs:**
- `e2e/specs/notes.spec.ts`
- `e2e/specs/tasks.spec.ts`
- `e2e/specs/calendar.spec.ts`
- `e2e/specs/inbox.spec.ts`
- `e2e/specs/journal.spec.ts`
- `e2e/specs/graph.spec.ts`
- `e2e/specs/settings.spec.ts`
- `e2e/specs/templates.spec.ts`
- `e2e/specs/bookmarks.spec.ts`
- `e2e/specs/command-palette.spec.ts`
- `e2e/specs/theme-toggle.spec.ts`

Each spec contains 2-4 tests covering render + one key interaction. Aim for 20-30 e2e tests total.

**Known constraints (S1 findings):**
- WebKit Playwright cannot use clipboard API (S1 tests 4, 6) — skip paste tests or use manual clipboard workaround
- DataTransfer synthesis broken (S1 test 7) — skip drag-drop or use `setInputFiles` workaround
- BlockNote selector: `.bn-editor` (S1 verified)

**TDD: Write spec file first, run, see failure ("route not found" or similar), then fix render if broken, then verify green.**

**Run:** `pnpm --filter @memry/desktop-tauri test:e2e`

All tests must pass before moving to J.6.

#### Step J.6 — Side-by-side visual parity (Task 19.1-19.3)

Open Electron dev build: `pnpm --filter @memry/desktop dev`
Open Tauri dev build: `pnpm --filter @memry/desktop-tauri dev`

For each route, compare:
- Typography
- Colors
- Spacing
- Icons
- Button styles
- Card shadows
- Table layouts
- Animations

Screenshot both windows on identical routes via macOS Cmd+Shift+4 (window capture). Save pairs to `docs/spikes/tauri-risk-discovery/benchmarks/m1-parity/` with names like `notes-electron.png` + `notes-tauri.png`.

If diffs exist, fix them:
- Missing font → check `src/main.tsx` imports match Electron's
- Wrong color → check CSS ported correctly (`assets/base.css`, `assets/main.css`)
- Wrong spacing → check Tailwind theme tokens

Iterate until zero visible diffs. Commit fixes with `m1(parity): fix <specific thing>`.

#### Step J.7 — Production build (Task 19.5-19.6)

```bash
pnpm --filter @memry/desktop-tauri build
```

Expected: 3-5 min build time, produces `.app` at `src-tauri/target/release/bundle/macos/Memry.app`.

Open the .app:

```bash
open apps/desktop-tauri/src-tauri/target/release/bundle/macos/Memry.app
```

Walk every route again — confirm no asset path issues (Risk #22 in spec). If prod build shows missing fonts/icons that dev has, investigate Vite asset handling.

#### Step J.8 — Final acceptance gate (Task 19.8)

Run the full verification suite:

```bash
cd apps/desktop-tauri
pnpm typecheck
pnpm lint
pnpm cargo:check
pnpm cargo:clippy
pnpm capability:check
pnpm bindings:check
pnpm port:audit
pnpm test
pnpm test:e2e
```

All must exit 0. If any fails, fix and re-run.

#### Step J.9 — Final commit + handoff (Task 19.9)

```bash
git add apps/desktop-tauri/playwright.config.ts apps/desktop-tauri/e2e/ docs/spikes/tauri-risk-discovery/benchmarks/m1-parity/
git commit -m "m1(e2e): add playwright webkit e2e suite + visual parity baselines"

git add -A
git commit -m "m1: close acceptance gate — visual parity achieved

- <N> e2e specs covering every route
- Side-by-side screenshot diff vs electron: zero visible diff
- Production build verified
- All gates green (typecheck, lint, cargo, clippy, capability, bindings, port-audit, unit, e2e)

Ready for M2 (DB + schemas + migrations)."
```

### Acceptance criteria (Phase J done when all pass)

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk

# All gates green
pnpm --filter @memry/desktop-tauri typecheck
pnpm --filter @memry/desktop-tauri lint
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy
pnpm --filter @memry/desktop-tauri capability:check
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri port:audit
pnpm --filter @memry/desktop-tauri test
pnpm --filter @memry/desktop-tauri test:e2e

# E2E suite present
test -f apps/desktop-tauri/playwright.config.ts
test $(ls apps/desktop-tauri/e2e/specs/*.spec.ts | wc -l) -ge 10

# Visual parity baselines saved
test -d docs/spikes/tauri-risk-discovery/benchmarks/m1-parity
test $(ls docs/spikes/tauri-risk-discovery/benchmarks/m1-parity/*.png 2>/dev/null | wc -l) -ge 10

# Production build exists
test -d apps/desktop-tauri/src-tauri/target/release/bundle/macos/Memry.app

# Final commit landed
git log --oneline -1 | grep -q "m1:"
```

### When done

Report:

```
Phase J complete — M1 milestone closed.
Tasks covered: 18, 19 + Playwright e2e addition
Commits: <N> (<first_hash>..<last_hash>)

Verification gates:
  ✅ typecheck, lint
  ✅ cargo check, clippy (no warnings)
  ✅ capability:check, bindings:check
  ✅ port:audit (0 hits)
  ✅ unit tests: <N> passing
  ✅ e2e tests: <N> passing across <M> spec files
  ✅ Production build: .app created successfully
  ✅ Visual parity: <N> route pairs screenshotted, zero visible diffs

Artifacts:
  - docs/spikes/tauri-risk-discovery/benchmarks/m1-parity/: <N> screenshot pairs
  - apps/desktop-tauri/e2e/specs/: <N> spec files

M1 acceptance gate: ALL GREEN

Next milestone: M2 (DB + schemas + migrations)
  → Invoke superpowers:writing-plans with M2 section from spec
Blockers: <none | list>
```

### If blockers surface

Visual parity diffs that persist after 3-4 iterations of fixes may indicate:
- Font rendering differences between WebKit and Chromium (acceptable — document + move on)
- Tailwind v4 config subtle mismatch (fix at config level)
- Missing CSS file (investigate)

Acceptable carve-outs: document deviations in the final commit message. Zero-diff target is aspirational; <5 distinct differences across 10 routes is shippable.

E2E flakiness: run test 3 times before marking flaky. Real flake fix beats `.skip()`.

### Ready

1. Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`.
2. Read plan Tasks 18 and 19 fully.
3. Read spec Section 6.1 (Spike carried-forward risks for Playwright WebKit gotchas).
4. Verify prerequisites.
5. Start Step J.1 (first dev boot).

## PROMPT END
