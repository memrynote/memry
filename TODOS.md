# TODOS

Captured during the M1 Tauri migration ship review (2026-04-25). 48 total findings across three review passes (3 pre-landing, 35 specialist, 10 adversarial). All deferred to M2+ per explicit M1 design intent.

Priority legend: **P0** = blocks M2 start, **P1** = before M2 PR lands, **P2** = before first real command activates, **P3** = M3+ hardening, **P4** = nice to have.

---

## IPC Wrapper (apps/desktop-tauri/src/lib/ipc/)

### P1 — subscribeEvent silently drops events fired before listen() resolves
**File:** `apps/desktop-tauri/src/lib/ipc/forwarder.ts:69-88`
**Priority:** P1
**Source:** Adversarial (confidence 9/10)
subscribeEvent returns the unsubscribe handle synchronously while `tauriListen` registers in the background via a fire-and-forget `void` promise. Any event Rust emits between the sync return and the async register tick vanishes. Electron's `ipcRenderer.on` was sync-register, so every renderer call site that assumed sync registration is now a latent race. Concretely in `src/sync/yjs-ipc-provider.ts:35-43`, `connect()` subscribes + immediately calls `openDoc()` + `performSyncHandshake()` — if Rust emits `crdt-state-changed` before the listener attaches, the update is permanently lost → CRDT split-brain with no error.
**Fix:** either buffer events fired before listener attaches, or provide an `awaitableSubscribeEvent` that returns after listen() resolves and migrate ordering-sensitive callers (yjs-ipc-provider, sync-context) to await it before any invoke that could trigger the event.

### P1 — packArgs is wrong for multi-arg and single-scalar Rust commands
**File:** `apps/desktop-tauri/src/lib/ipc/forwarder.ts:34-44`
**Priority:** P1
**Source:** Adversarial (confidence 9/10)
Packs multi-arg / scalar calls as `{ args: [...] }`, but Tauri commands expect named-param JSON (`{ id, title }`, not `{ args: [...] }`). Works today only because no real commands exist. First M2 Rust command with multiple args fails with "missing required key `id`".
**Fix:** either require all renderer services to pass single-object args (refactor `rename(id, title)` → `rename({ id, title })`) or generate per-command arg-mangling shims from tauri-specta bindings.

### P1 — camelToSnake produces wrong snake_case for acronyms
**File:** `apps/desktop-tauri/src/lib/ipc/forwarder.ts:8-10`, test at `forwarder.test.ts:39-42`
**Priority:** P1
**Source:** Adversarial + Testing specialist (confidence 9/10)
`getHTTPStatus` → `get_h_t_t_p_status`, not `get_http_status`. Any Rust command with an acronym (`getOTP`, `verifyJWT`, `checkURL`) will fail to map. The test asserts the broken behavior as expected.
**Fix:** `s.replace(/([a-z\d])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase()`. Update forwarder.test.ts:39-42 acronym assertion.

### P1 — invoke.ts missing isTauriRuntime guard (vite preview will crash post-M2)
**File:** `apps/desktop-tauri/src/lib/ipc/invoke.ts:33-38`
**Priority:** P1
**Source:** Adversarial (confidence 8/10)
events.ts guards against non-Tauri contexts; invoke.ts does not. Once `realCommands` has entries (M2+), `pnpm preview` / opening the Vite build in Chrome will crash on `__TAURI_INTERNALS__.transformCallback`.
**Fix:** mirror events.ts `isTauriRuntime()` guard in `shouldUseMock`; outside Tauri, force-mock regardless of `realCommands`. Or delete the `preview` script from package.json.

### P1 — events.ts listen wrapper silently swallows async callback rejections
**File:** `apps/desktop-tauri/src/lib/ipc/events.ts:34`
**Priority:** P1
**Source:** Pre-landing + Testing specialist (confidence 8/10)
`void callback(tauriEvent.payload as T)` drops rejected promises. No test exercises a throwing/rejecting callback — the `awaits async callbacks` test only covers the happy path. Production callbacks throwing vanish without logs.
**Fix:** `callback(...).catch((err) => createLogger('ipc-events').error('handler threw', { event, err }))`. Add tests for sync throw + async reject.

### P1 — forwarder subscribeEvent missing .catch on listen() promise
**File:** `apps/desktop-tauri/src/lib/ipc/forwarder.ts:73`
**Priority:** P1
**Source:** Pre-landing (confidence 7/10)
Tauri listen rejection surfaces as unhandled promise rejection, silently breaks subscribers.
**Fix:** add `.catch((err) => logger.error('listen failed for', eventName, err))`.

### P2 — isTauriRuntime lets null sentinel pass the guard
**File:** `apps/desktop-tauri/src/lib/ipc/events.ts:13-18`
**Priority:** P2
**Source:** Testing specialist (confidence 8/10)
`window.__TAURI_INTERNALS__ !== undefined` lets `null` through. If a host environment ever sets the sentinel to null, the guard passes and tauriListen crashes inside.
**Fix:** `typeof window.__TAURI_INTERNALS__ === 'object' && window.__TAURI_INTERNALS__ !== null`. Add null-sentinel test.

### P2 — invoke.ts VITE_MOCK_IPC=false sharp edge
**File:** `apps/desktop-tauri/src/lib/ipc/invoke.ts:29-37`
**Priority:** P2
**Source:** Pre-landing (confidence 6/10)
When `VITE_MOCK_IPC=false` and `realCommands` is empty (M1 state), every invoke() goes to a Tauri backend with zero handlers → hard failure.
**Fix:** warn once when `VITE_MOCK_IPC=false` and `realCommands.size === 0`.

### P2 — Missing Zod validation at mock boundary
**File:** `apps/desktop-tauri/src/lib/ipc/mocks/*.ts`
**Priority:** P2
**Source:** Adversarial (confidence 8/10)
Mock routes mutate in-memory state without shape validation. When M2 flips on real Rust commands, every shape mismatch explodes simultaneously (`serde::de::Error` avalanche).
**Fix:** add a Zod schema per command (derived from `@memry/contracts` where possible) and validate at mock dispatch. Emit a dev-only warning for drift.

### P2 — subscribeEvent double-cleanup edge case untested
**File:** `apps/desktop-tauri/src/lib/ipc/forwarder.ts:81`
**Priority:** P2
**Source:** Testing specialist (confidence 8/10)
Calling cleanup() twice is a no-op (correct), but no test pins that behavior or covers cleanup-after-listen-resolves branch.
**Fix:** add tests for (1) cleanup after resolve → exactly one detach, (2) cleanup called twice → still one detach, no throw.

### P2 — mockRouter error branch untested
**File:** `apps/desktop-tauri/src/lib/ipc/mocks/index.ts:67-73`
**Priority:** P2
**Source:** Testing specialist (confidence 9/10)
Handler-throws try/catch has zero test coverage. Any future change that accidentally swallows errors won't be caught.
**Fix:** add test that registers throwing handler, calls mockRouter, asserts rejection propagates and console.error fires with cmd name + error.

### P2 — packArgs null/undefined/falsy edge cases untested
**File:** `apps/desktop-tauri/src/lib/ipc/forwarder.ts:34`
**Priority:** P2
**Source:** Testing specialist (confidence 8/10)
`only && typeof only === 'object'` short-circuits on falsy values. Renderer code passing `invoke('notes_list_by_folder', null)` hits untested path.
**Fix:** add `packArgs([null])`, `packArgs([undefined])`, `packArgs([''])`, `packArgs([0])`, `packArgs([false])` tests.

### P3 — Forwarder Proxy allocates fresh arrow on every property access
**File:** `apps/desktop-tauri/src/lib/ipc/forwarder.ts:52-58`
**Priority:** P3
**Source:** Performance specialist (confidence 8/10)
Every `notesService.list` property access creates a new function reference. Destructured methods in React deps arrays fire effects on every render.
**Fix:** cache method bindings in a `Map<string, Function>` inside the Proxy closure.

### P3 — invoke.ts reads env var per call
**File:** `apps/desktop-tauri/src/lib/ipc/invoke.ts:33`
**Priority:** P3
**Source:** Performance specialist (confidence 6/10)
Vite inlines `import.meta.env.VITE_MOCK_IPC` at build time, so it's not a runtime lookup — but the string equality check still runs on every IPC call.
**Fix:** hoist `const MOCK_DISABLED = import.meta.env.VITE_MOCK_IPC === 'false'` to module scope.

### P3 — snakeToCamel exported but unused
**File:** `apps/desktop-tauri/src/lib/ipc/forwarder.ts:15`
**Priority:** P3
**Source:** Maintainability specialist (confidence 6/10)
Exported + tested but never called outside tests. Speculative export.
**Fix:** delete until M2 has a real consumer, or document the intended caller in the docstring.

### P4 — Tauri runtime sentinel may rename in future minor versions
**File:** `apps/desktop-tauri/src/lib/ipc/events.ts:12-18`
**Priority:** P4
**Source:** Adversarial (bonus note, confidence 6/10)
`__TAURI_INTERNALS__` is an internal symbol. Tauri 2.11+ renaming silently flips the wrapper into permanent noop mode.
**Fix:** switch to `@tauri-apps/api/core`'s published runtime probe or `window.isTauri` once stable.

---

## Mock routes (apps/desktop-tauri/src/lib/ipc/mocks/)

### P1 — Module-scoped mutable state leaks across tests and HMR
**File:** `apps/desktop-tauri/src/lib/ipc/mocks/notes.ts:21`, `types.ts:10`, `inbox.ts:155`, `vault.ts:37-72`, `settings.ts` (+ several more)
**Priority:** P1
**Source:** Testing + Adversarial (confidence 9/10)
Module-scope arrays + counter (`let counter = 0` in types.ts) persist across vitest tests in the same file. Test A creates a note → test B's "12 seeded notes" assertion fails under reordering. In the live renderer, Vite HMR reload produces non-reproducible fixture state — reload notes.ts re-seeds, reload types.ts resets the counter, reload neither drifts.
**Fix:** expose `__reset__()` per mock, call in vitest `beforeEach`. Long-term, refactor mocks to accept a `seed()` factory invoked at dispatch time rather than module load.

### P2 — inbox_stats and inbox_get_stats are byte-identical
**File:** `apps/desktop-tauri/src/lib/ipc/mocks/inbox.ts:243-248`, `255-260`
**Priority:** P2
**Source:** Maintainability specialist (confidence 9/10)
Alias routes duplicate the body. If stats logic changes, one site updates and the other lies.
**Fix:** extract `computeStats()`, return from both routes.

### P2 — saved-filters and bookmarks fixtures unreachable
**File:** `apps/desktop-tauri/src/lib/ipc/mocks/saved-filters.ts:14-69`, `bookmarks.ts:31-41`
**Priority:** P2
**Source:** Maintainability specialist (confidence 8/10)
Both files' `_list` routes hard-return `{ ...: [] }` due to contract drift. 55+6 lines of fixture data are never surfaced to the renderer.
**Fix:** reshape fixtures to match real `*ListResponse` envelope OR trim to 1-2 items + note they exist only for unit-test surface.

### P2 — Magic numbers 3_600_000 and 86_400_000 duplicated
**File:** `apps/desktop-tauri/src/lib/ipc/mocks/calendar.ts:55` (+ others)
**Priority:** P2
**Source:** Maintainability specialist (confidence 8/10)
`mockTimestamp` abstracts days; no equivalent for hours. `3_600_000` / `86_400_000` literals appear across mock files.
**Fix:** add `MS_PER_HOUR` and `MS_PER_DAY` constants (or `mockHours(n)` helper) to `mocks/types.ts`.

### P2 — inbox_get_stats filter array 4× over same array
**File:** `apps/desktop-tauri/src/lib/ipc/mocks/inbox.ts:243`, `tasks.ts:117-120`
**Priority:** P2
**Source:** Performance specialist (confidence 7/10)
Four full-array scans + four intermediate arrays to count. Trivial at fixture scale but the pattern mirrors the real M2 backend contract.
**Fix:** single-pass reducer.

### P2 — notes toListItem allocates Date + runs regex split per call
**File:** `apps/desktop-tauri/src/lib/ipc/mocks/notes.ts:155`
**Priority:** P2
**Source:** Performance specialist (confidence 7/10)
Every list call re-allocates. Fresh object identity defeats React Query structural sharing.
**Fix:** memoize `toListItem` keyed on `(id, updatedAt)`; store wordCount on MockNote at definition time.

### P3 — mockRouter uses raw console.warn/error (project mandates createLogger)
**File:** `apps/desktop-tauri/src/lib/ipc/mocks/index.ts:64, 71`
**Priority:** P3
**Source:** Maintainability specialist (confidence 7/10)
apps/desktop/CLAUDE.md mandates `createLogger('Scope')` from electron-log. Raw `console.*` bakes in a later grep+port pass and pollutes test output.
**Fix:** wire a renderer-side logger abstraction (Tauri equivalent), or gate behind `if (import.meta.env.DEV)` and mark as sanctioned site.

### P3 — CRUD pattern duplicated across 9 mock files
**File:** `apps/desktop-tauri/src/lib/ipc/mocks/folders.ts:52` (pattern repeated in tasks, bookmarks, reminders, saved-filters, templates, tags, journal, calendar)
**Priority:** P3
**Source:** Maintainability specialist (confidence 7/10)
~200 lines of near-identical find/update/delete logic. Adding soft-delete at M2+ requires editing 9 files.
**Fix:** extract `createInMemoryCrud<T>(name, store)` factory returning get/create/update/delete handlers.

---

## Cargo.toml / Rust backend

### P1 — rusqlite load_extension feature unused at M1 expands attack surface
**File:** `apps/desktop-tauri/src-tauri/Cargo.toml:22`
**Priority:** P1
**Source:** Security specialist (confidence 8/10)
`features = ["bundled", "load_extension"]` exposes `sqlite3_load_extension` → arbitrary native code execution if attacker-influenced strings reach SQLite via future IPC. Defense-in-depth: drop until needed.
**Fix:** `features = ["bundled"]`. Re-add `load_extension` with explicit threat-model note when sqlite-vec / extension lands.

### P2 — Cargo.toml deps declared unused but compile-verified (intentional design)
**File:** `apps/desktop-tauri/src-tauri/Cargo.toml:22-34`
**Priority:** P2 (honor M1 intent, but narrow)
**Source:** Performance specialist + Security specialist
tokio (`features = ["full"]`), rusqlite, yrs, dryoc, thiserror, specta, tauri-specta, tracing-appender all declared at M1 with zero usage. Comment on line 21 says "Declared for later milestones — unused at M1 but compile-verified". The trade-off is verified compile-compat vs cold-build time (~4-5x baseline) and ~250 transitive crates.
**Fix for M2:** move deps behind `[features]` gates (`crdt = ["yrs"]`, `crypto = ["dryoc"]`, `db = ["rusqlite"]`) so CI verifies compile-compat via `cargo check --all-features` while local dev checks run against the bare default. Narrow `tokio` features to actually-used surface when tokio usage lands.

### P1 — tauri-plugin-shell registered without any M1 use case
**File:** `apps/desktop-tauri/src-tauri/src/lib.rs:6`, `apps/desktop-tauri/src-tauri/Cargo.toml:19`
**Priority:** P1
**Source:** Security specialist (confidence 7/10)
Plugin code (process spawn, URL open) compiled in as dead reachable code. Capabilities/default.json grants nothing to shell so invocations are blocked at runtime — but a future bug that bypasses capability check exposes shell immediately.
**Fix:** remove `.plugin(tauri_plugin_shell::init())` from lib.rs:6 and the Cargo.toml entry until a milestone needs `open URL` / reveal-in-Finder. Re-add behind an explicit `shell:allow-open` grant.

### P2 — Tauri version uses caret-style loose pin
**File:** `apps/desktop-tauri/src-tauri/Cargo.toml:18-19`
**Priority:** P2
**Source:** Security specialist (confidence 7/10)
`tauri = "2.10"`, `tauri-plugin-shell = "2"` let `cargo update` auto-roll minors on fresh clones. Cargo.lock pins resolution today, but a regenerated lockfile widens the blast radius for a security-critical runtime dep.
**Fix:** `tauri = "=2.10.x"` and document upgrade cadence in the migration plan.

### P3 — tracing-appender pulled in but never wired
**File:** `apps/desktop-tauri/src-tauri/Cargo.toml:28`
**Priority:** P3
**Source:** Performance specialist (confidence 6/10)
lib.rs uses `tracing_subscriber::fmt().with_env_filter(...).json().init()` — no file rotation / non-blocking writers. tracing-appender brings in crossbeam-channel + time crates for nothing.
**Fix:** drop until M3+ wires file logging.

---

## Tauri config / Security

### P1 — CSP allows dev URL in production builds
**File:** `apps/desktop-tauri/src-tauri/tauri.conf.json:25`
**Priority:** P1
**Source:** Security specialist + Adversarial (confidence 6/10 sec, 8/10 adv)
`connect-src ... http://localhost:1420` ships in prod CSP. Also `https://*.youtube.com` is listed in `connect-src` but YouTube embeds go through `frame-src` — unused grant signals intent for arbitrary YouTube subdomain XHR.
**Fix:** split CSP via Tauri dev/prod config mechanism. Strip `http://localhost:1420` from prod. Remove unused `https://*.youtube.com` from `connect-src`. Track `style-src 'unsafe-inline'` removal (nonce/hash-based) for M5.

### P2 — Freeze-workflow bypass-label governance undocumented
**File:** `.github/workflows/electron-freeze.yml:40`, `apps/desktop/README.md`
**Priority:** P2
**Source:** Security specialist (confidence 6/10)
Any collaborator with `pull_requests: write` can apply a bypass label and skip the freeze without a separate gate.
**Fix:** (a) CODEOWNERS-gated label rules, or (b) audit-comment step that posts to the PR when a bypass label is applied, or (c) document reviewer-ack requirement in apps/desktop/README.md.

### P2 — Freeze-workflow path filter missing workspace root files
**File:** `.github/workflows/electron-freeze.yml:17-29`
**Priority:** P2
**Source:** Adversarial (confidence 9/10)
`pnpm-lock.yaml`, root `package.json`, `turbo.json`, `tsconfig*.json` can all silently change `apps/desktop` runtime behavior (resolved deps, build routing) while the workflow doesn't trigger.
**Fix:** add `pnpm-lock.yaml`, `package.json`, `turbo.json`, `tsconfig*.json`, and `.github/workflows/electron-freeze.yml` itself (catch PRs that weaken the guard) to the `paths:` filter.

### P2 — CI uses floating `actions/github-script@v7`
**File:** `.github/workflows/electron-freeze.yml:36`
**Priority:** P2
**Source:** Security specialist (confidence 9/10)
Floating tag is rewritable. March 2025 tj-actions/changed-files attack hit exactly this pattern.
**Fix:** pin by SHA: `uses: actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea # v7.0.1`.

---

## Build / Tooling / CI

### P1 — capability-sanity-check misses plugins registered in Rust code
**File:** `apps/desktop-tauri/scripts/capability-sanity-check.ts:36-53`
**Priority:** P1
**Source:** Adversarial (confidence 9/10)
Scanner reads `tauri.conf.json` plugins but tauri-plugin-shell is registered in `lib.rs` — escapes detection. Spike 0 obs #11 was specifically "missing capability grants present as silent hangs"; today's sanity check doesn't catch the most common form.
**Fix:** extend scanner to scan `src-tauri/src/**/*.rs` for `tauri_plugin_*::init()` invocations. Flag any plugin loaded in Rust without a matching `<plugin>:` permission in capabilities/default.json.

### P1 — bindings:check false-positive (generator is a no-op)
**File:** `apps/desktop-tauri/src-tauri/src/bin/generate_bindings.rs`, `apps/desktop-tauri/scripts/check-bindings.ts`
**Priority:** P1
**Source:** Adversarial (confidence 9/10)
Generator writes a fixed `export {}` string. `check-bindings` diffs the generated file against git — will always pass. When M2 adds a `#[tauri::command]` without wiring the generator, CI will say "✅ in sync" while the file contains nothing.
**Fix:** generate_bindings.rs must walk registered command handlers via tauri-specta's `collect_commands!` and fail loudly if zero commands when `realCommands` is non-empty. Alternative: gate `bindings:check` on `cargo check` output comparing command count.

### P2 — .githooks/pre-commit MAX_LINES effectively disabled
**File:** `.githooks/pre-commit:7`
**Priority:** P2
**Source:** Maintainability specialist (confidence 9/10)
Bumped to 100,000,000. Header comment still claims guard is active ("Keeps module boundaries honest").
**Fix:** revert to realistic threshold (~2000 to accommodate largest ported file, with per-path overrides for generated files), or delete the hook if intentionally disabled. Add a TODO with the milestone where the limit is restored.

### P2 — landing.spec.ts reinvents isAllowedConsoleNoise helper
**File:** `apps/desktop-tauri/e2e/specs/landing.spec.ts:47-51`
**Priority:** P2
**Source:** Maintainability specialist (confidence 10/10)
Inline `allowNoise` arrow duplicates the shared fixture helper. Every other spec imports from `../fixtures/helpers`.
**Fix:** `import { bootApp, isAllowedConsoleNoise } from '../fixtures/helpers'` and reuse.

### P2 — "no console errors" spec body duplicated across 6 files
**File:** `apps/desktop-tauri/e2e/specs/calendar.spec.ts:14` (+ inbox, journal, notes, settings, sidebar-smoke, tasks)
**Priority:** P2
**Source:** Maintainability specialist (confidence 7/10)
Same 4-line body repeated in 6 spec files. Every new route copy-pastes.
**Fix:** add `expectNoConsoleErrors(page, consoleErrors, { route })` helper to `e2e/fixtures/helpers.ts`. Each spec collapses to one line.

### P2 — visual-baseline.spec.ts uses waitForTimeout for animations
**File:** `apps/desktop-tauri/e2e/specs/visual-baseline.spec.ts:86`
**Priority:** P2
**Source:** Testing specialist (confidence 8/10)
Raw `waitForTimeout(400/800/200)` before screenshots. On slow CI runners, modal may not be settled.
**Fix:** wait for animation-complete signals: `page.locator('[role=dialog][data-state=open]').waitFor()`, transitionend events, or poll on CSS opacity/transform.

### P3 — mockTimestamp test uses real Date.now with 1000ms tolerance
**File:** `apps/desktop-tauri/src/lib/ipc/mocks/index.test.ts:42`
**Priority:** P3
**Source:** Testing specialist (confidence 7/10)
Flaky under CI load: if the gap between mockTimestamp() and assertion's Date.now() exceeds 1000ms (GC pauses, slow workers), test fails.
**Fix:** `vi.useFakeTimers()` with a fixed system time, assert exact equality against the frozen clock.

---

## Docs

### P0 — M2 plan doc has incorrect migration mapping table
**File:** `docs/superpowers/plans/2026-04-25-m2-db-schemas-migrations.md:818`
**Priority:** P0 (blocks M2 start)
**Source:** Data migration specialist (confidence 7/10)
Mapping table mislabels `0017_spotty_mongu` as "property_definitions" — that migration only adds field_clocks columns (per MEMORY.md Phase 8). property_definitions actually lives in `0022_notes_journal_vault.sql`. Plan also proposes a self-contradictory net-new `0029` ALTER for the same field_clocks columns, risking double-application. 29 placeholder entries hard-coded in the EMBEDDED manifest (line 543) will reflect the wrong file names.
**Fix before M2 starts:** grep each Electron migration .sql file for `CREATE TABLE` and reconstruct the mapping table. Specifically: 0017_spotty_mongu → `0018_field_clocks_tasks_projects.sql` in Tauri, 0022_notes_journal_vault owns property_definitions. Drop the speculative 0029 unless a real net-new migration exists. Update the 29-entry manifest count accordingly.

---

## Completed

(nothing yet — all M1 work is covered in CHANGELOG)
