# Prompt — Exhaustive E2E tests for the Home Dashboard (Playwright + Electron)

Use this as an implementer prompt (subagent-driven or inline). It produces Playwright E2E coverage for **every shipped Home Dashboard behavior, one case at a time**, plus a reusable per-widget template for widgets that ship later.

---

## Context

The Home Dashboard (branch `home-dashboard`, Plan 1) adds a customizable `'home'` tab: multiple boards, each holding draggable / resizable (preset S/M/L) widget cards persisted in `data.db`. Plan 1 ships the board engine + **two widgets**: Recently edited and Bookmarks. Spec: `docs/superpowers/specs/2026-06-20-home-dashboard-design.md`. Plan: `docs/superpowers/plans/2026-06-20-home-dashboard.md`.

**Scope of THIS task — test only what Plan 1 actually ships:**

- Foundation: default landing, first-run seed, board switcher (select + create only), add/remove/resize/reorder widgets, layout persistence (reload + full restart), multi-board.
- Widgets: Recently edited, Bookmarks — every case.
- **Do NOT** write tests for unbuilt features: Tasks/Inbox/Folder embed widgets, Quick actions, Today, Most-used tags (Plans 2–4), board rename/delete/reorder UI (hook exists, UI not wired), and cross-device sync (Plan 3). Add them later using the per-widget template at the end.

**Coverage boundary to state in the test file header:** every E2E test runs against a **fresh temp vault** (see fixtures), so the migration-skip bug we just fixed (0032 journal `when`) is NOT reproducible here — it only manifests on a vault already migrated to 0031. That case is covered by the unit test `apps/desktop/src/main/database/migrate-journal.test.ts`. Do not try to reproduce it in E2E.

---

## Infrastructure (use these — do not invent)

- Test files live in `apps/desktop/tests/e2e/`, named `*.e2e.ts`, run via `pnpm --filter @memry/desktop test:e2e` (Playwright config `config/playwright.config.ts`, `fullyParallel: false`).
- Import: `import { test, expect } from './fixtures'`. Fixtures provide `page`, `electronApp`, `testVaultPath` (a fresh temp vault dir with `.memry/`, `notes/`, `journal/`).
- Helpers in `tests/e2e/utils/electron-helpers.ts`: `waitForAppReady(page)`, `waitForVaultReady(page)`, `navigateTo(page, view)`, `dismissFirstRunOnboarding(page)`. **`navigateTo` does NOT support `'home'`** — extend it (see Step 1) or click the Home nav entry directly.
- Seed **notes** by writing markdown files into `<testVaultPath>/notes/` with `gray-matter` frontmatter before/while the app runs, exactly as `tests/e2e/folder-view.e2e.ts` does (`matter.stringify`, `fs.writeFileSync`). Vary `modified`/`created` timestamps to control recency ordering.
- Seed **bookmarks** (no file representation — they live in `data.db`) via the renderer API from within the app:
  `await page.evaluate(({ itemType, itemId }) => window.api.bookmarks.toggle({ itemType, itemId }), { itemType: 'note', itemId })`.
  You may likewise read/seed boards via `window.api.homePages.*` through `page.evaluate` when driving the full UI flow is unnecessarily slow — but prefer real UI interactions for the behaviors under test.
- Many existing E2E files start with `// @ts-nocheck` — match the surrounding convention.

---

## Step 1 (prerequisite) — add stable selectors

The Home components have no `data-testid`s. Add these (keep existing aria-labels too). Use them in tests instead of i18n text where possible.

| Element                                | File                                                 | Attribute                                                                                                       |
| -------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Home page root                         | `pages/home.tsx`                                     | `data-testid="home-page"`                                                                                       |
| Board switcher bar                     | `components/home/board-switcher.tsx`                 | `data-testid="board-switcher"`                                                                                  |
| Board chip                             | board-switcher.tsx                                   | `data-testid="board-chip"` + `data-board-id={b.id}` + `data-active={b.id === activeBoardId}`                    |
| New-board button                       | board-switcher.tsx                                   | `data-testid="board-new"` (already has `aria-label` "New board")                                                |
| Board grid                             | `components/home/board-grid.tsx`                     | `data-testid="board-grid"`                                                                                      |
| Add-widget gallery                     | `components/home/widget-gallery.tsx`                 | `data-testid="widget-gallery"`; each option `data-testid="widget-gallery-item"` + `data-widget-type={def.type}` |
| Widget card (frame)                    | `components/home/widget-frame.tsx`                   | `data-testid="widget"` + `data-widget-type` + `data-widget-size={widget.size}` + `data-widget-id={widget.id}`   |
| Resize buttons                         | widget-frame.tsx                                     | each: `data-testid={`widget-size-${s}`}` + `aria-label={`Resize to ${s}`}` (also fixes the known a11y gap)      |
| Recently-edited row                    | `components/home/widgets/recently-edited-widget.tsx` | `data-testid="recent-note"` + `data-note-id={n.id}`                                                             |
| Bookmark row                           | `components/home/widgets/bookmarks-widget.tsx`       | `data-testid="bookmark-item"` + `data-item-id` + `data-item-type`                                               |
| Home sidebar nav entry (if one exists) | sidebar component                                    | `data-testid="nav-home"`, and extend `navigateTo`'s union + map to include `'home'`                             |

Run `pnpm --filter @memry/desktop typecheck:web` and `eslint` on touched files after adding these. Keep RTL-safe logical Tailwind classes; no behavior change.

---

## Step 2 — write the E2E specs

Create these files (split for focus, mirroring the one-file-per-area convention):

- `tests/e2e/home-dashboard.e2e.ts` — landing, seed, switcher, add/remove/resize/reorder, persistence, multi-board, edge cases (groups A–E, H).
- `tests/e2e/home-widget-recently-edited.e2e.ts` — group F.
- `tests/e2e/home-widget-bookmarks.e2e.ts` — group G.

Each `test()` covers ONE case. Use `test.describe` per group. Begin each interaction with `await waitForAppReady(page); await waitForVaultReady(page); await dismissFirstRunOnboarding(page)`.

### Group A — Landing & first-run seed

- A1: Fresh vault → app lands on the Home tab (`home-page` visible without manual navigation).
- A2: Fresh vault → a default board named **"Home"** is auto-seeded (one `board-chip` with text "Home").
- A3: The seeded board renders exactly the two default widgets — one `widget[data-widget-type="recently-edited"]` and one `widget[data-widget-type="bookmarks"]`.
- A4: Seed runs **once** — reload the window; still exactly one "Home" board (no duplicate), still 2 widgets.
- A5: Home is a singleton tab — attempting to open Home again focuses the existing tab (assert only one Home tab in the tab strip).

### Group B — Board switcher & multi-board

- B1: Switcher shows one `board-chip` per board, ordered by `position`.
- B2: Click `board-new` → a new chip appears (board count +1).
- B3: The new board is **empty** (its `board-grid` has zero `widget` cards) — matches `createBoard('New board')` seeding nothing.
- B4: Click a different `board-chip` → `board-grid` swaps to that board's widgets (assert via `data-active` + widget set).
- B5: Active board persists across reload — select board 2, reload, assert board 2 still active (`data-active=true`), grid shows board 2's widgets.
- B6: Active-board fallback — via `page.evaluate` clear `localStorage['memry-home-active-board']`, reload → first board (position 0) is active.
- B7 (FUTURE — not in Plan 1): rename / delete / reorder boards. Skip with `test.skip` + a comment until the switcher wires these.

### Group C — Add widget (gallery)

- C1: `widget-gallery` lists an item per registered type (`widget-gallery-item[data-widget-type="recently-edited"]` and `...="bookmarks"`).
- C2: Click a gallery item → a new `widget` of that type appears in `board-grid`.
- C3: Add the same type twice → two `widget` cards of that type (instances allowed).
- C4: Added widget persists across reload.

### Group D — Widget frame controls (run against a known widget instance)

- D1: Remove — click the widget's "Remove widget" control → card disappears; persists across reload.
- D2: Resize — click `widget-size-S` (or M) → `data-widget-size` updates and the card's grid span changes; persists across reload.
- D3: Allowed sizes only — recently-edited/bookmarks expose **S and M only** (no `widget-size-L`); assert L control absent.
- D4: Reorder — drag one widget's "Drag widget" handle past another (Playwright `dragTo`/manual mouse steps) → DOM order of `widget` cards changes; new order persists across reload.

### Group E — Layout persistence (integration)

- E1: Compose a layout (add a 2nd recently-edited, resize one to M, reorder, remove one) → reload → exact widget set, sizes, and order restored.
- E2: Full restart — repeat E1 but close and relaunch the Electron app (new `electronApp`, same `testVaultPath`) instead of a window reload; assert layout restored from `data.db` (not just localStorage).
- E3: Per-board isolation — board 1 layout ≠ board 2 layout; switching back and forth preserves each board's own widgets/sizes/order.

### Group F — Recently edited widget

- F1: No notes → widget renders an empty/non-crashing state (no `recent-note` rows; no error).
- F2: Seed 8 notes with distinct `modified` timestamps → rows appear in **descending modified order**; assert the top row is the most recently modified.
- F3: Size→limit — at size **S** show ≤3 rows, at size **M** show ≤6 rows (resize and assert row count).
- F4: Click a `recent-note` → opens that note in a note tab (assert tab title / active note matches `data-note-id`).
- F5: Recency updates — edit an older note (rewrite its file with a newer `modified`), trigger a refresh (reload) → it moves to the top.
- F6 (optional, visual): very long title truncates within the card (CSS `truncate`).

### Group G — Bookmarks widget

- G1: No bookmarks → empty/non-crashing state.
- G2: Seed a note, bookmark it (`window.api.bookmarks.toggle({itemType:'note', itemId})`), refresh → a `bookmark-item[data-item-type="note"]` appears with the note title.
- G3: itemType variants — bookmark a journal entry and (if present) a task; assert each appears with correct `data-item-type`.
- G4: Click a `bookmark-item` → opens the correct tab (note → note tab; task → tasks tab). Assert per type.
- G5: Size→limit — S ≤3, M ≤6 rows.
- G6 (optional): when a bookmarked item's title is null, the row shows the "Untitled" fallback (force by bookmarking an item with no title if feasible; else skip).
- G7: Un-bookmark (`toggle` again or remove via UI) → row disappears after refresh.

### Group H — Edge cases / robustness

- H1: Unknown widget type — via `page.evaluate` write a board whose `widgets` includes `{type:'does-not-exist',...}` through `window.api.homePages.update`, reload → board renders without crashing and the unknown widget is skipped (other widgets still render).
- H2: Empty `widgets` array board → `board-grid` renders empty, `widget-gallery` still usable, no error.
- H3: Rapid reloads right after seed → never more than one "Home" board.

---

## Per-widget template (reuse for each future widget — Plans 2–4)

When a new widget ships (Tasks, Inbox, Folder, Quick actions, Today, Most-used tags), add `tests/e2e/home-widget-<name>.e2e.ts` covering, one case each:

1. **Add** — appears in the gallery; adding it places a card of `data-widget-type="<name>"`.
2. **Empty state** — with no underlying data, renders gracefully.
3. **Populated** — seed the widget's data source; assert the widget reflects it (content + ordering rules from the spec).
4. **Per-size behavior** — for each size the widget declares, assert layout/limit/visible content is correct (and disallowed sizes are absent).
5. **Primary interaction** — the widget's main action (click-through to open, inline check/triage/capture, embed toolbar action) works and affects the right target.
6. **Config (if the widget has a `ConfigEditor`)** — open config, change each option (e.g. Tasks: project / date range / status; Inbox: filter; Folder: folder + view + sort/filter), assert the widget re-renders to match, and the config **persists** across reload.
7. **Multiple instances** — two of the same widget with different configs coexist and each shows its own data.
8. **Persistence** — the widget + its config survive reload and full restart.
9. **Remove** — removing it leaves the rest of the board intact.

---

## Run & acceptance

- Run: `pnpm --filter @memry/desktop test:e2e -- home-dashboard.e2e.ts home-widget-recently-edited.e2e.ts home-widget-bookmarks.e2e.ts` (or all e2e). E2E is **not** `fullyParallel` and is slow — expect minutes.
- Also keep green: `typecheck:web`, `eslint` on touched files (the new `data-testid`s + any helper changes), and the existing unit/renderer suites.
- **Acceptance:** every case A1–A5, B1–B6, C1–C4, D1–D4, E1–E3, F1–F5, G1–G5, G7, H1–H3 has a passing `test()` (B7/F6/G6 may be `test.skip` with a reason). No flaky waits — prefer `expect(locator).toBeVisible()`/`toHaveCount()` polling over `waitForTimeout`. Each test isolates its own vault state (fixtures already give a fresh vault per test).
- Commit E2E specs and the selector additions separately from feature code, scoped (`git add` explicit paths — never `git add .`; unrelated untracked WIP is present). Suggested messages: `test(home): add data-testids for e2e` and `test(home): e2e coverage for dashboard + widgets`.
