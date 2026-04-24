# M1 Phase D — Mock IPC Layer (TDD)

Temiz session prompt. **Bu phase yoğun TDD gerektirir.** Her mock handler unit test'e sahip olmalı.

---

## PROMPT START

You are implementing **Phase D of Milestone M1** for Memry's Electron→Tauri migration. This phase creates the renderer-side mock IPC layer that feeds fake data to every page until M2+ wires real Rust commands.

### Context

**Repo:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk`
**Branch:** `spike/tauri-risk-discovery`
**Plan:** `docs/superpowers/plans/2026-04-24-m1-tauri-skeleton-and-renderer-port.md`
**Spec:** `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md`

### Prerequisite

**Phase C complete.** Verify:

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk
test -d apps/desktop-tauri/node_modules/yjs
test -d apps/desktop-tauri/node_modules/vitest
test -f apps/desktop-tauri/src/assets/main.css
```

If any fails, STOP.

### Your scope

Execute **Tasks 9, 10, 11** from the plan:

- **Task 9:** Typed `invoke<T>(cmd, args)` wrapper with mock/real router in `src/lib/ipc/invoke.ts`
- **Task 10:** 19 domain mock fixture files in `src/lib/ipc/mocks/` (notes, tasks, calendar, inbox, journal, folders, tags, bookmarks, templates, settings, vault, auth, sync, search, graph, properties, reminders, saved-filters, updater) + shared `types.ts` + `index.ts` router
- **Task 11:** Typed `listen<T>(event, callback)` wrapper in `src/lib/ipc/events.ts`

### Methodology — **TDD mandatory**

**Every file written in this phase MUST follow RED-GREEN-REFACTOR:**

1. **Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`** first.
2. **Set up Vitest config** before the first test:
   - Create `apps/desktop-tauri/vitest.config.ts`:
     ```typescript
     import { defineConfig } from 'vitest/config'
     import { resolve } from 'node:path'
     import { fileURLToPath } from 'node:url'

     const root = fileURLToPath(new URL('.', import.meta.url))

     export default defineConfig({
       test: {
         environment: 'happy-dom',
         globals: false,
         include: ['src/**/*.test.ts', 'tests/**/*.test.ts']
       },
       resolve: {
         alias: {
           '@': resolve(root, 'src')
         }
       }
     })
     ```
   - Add to `apps/desktop-tauri/package.json` scripts: `"test": "vitest run"`, `"test:watch": "vitest watch"` (already there from Task 1 — verify)

3. **For Task 9 (invoke wrapper):**
   - RED: Write `src/lib/ipc/invoke.test.ts` first with tests for:
     - `invoke('unknown_command')` throws descriptive error when mock router has no handler
     - `invoke('notes_create', input)` routes to mock router when `realCommands` set is empty
     - `invoke('real_cmd', {})` routes to Tauri when `realCommands` contains it (mock the tauri import for test)
     - Mock flag `VITE_MOCK_IPC=false` bypasses mock router even for unknown commands (falls through to Tauri)
   - Run tests → FAIL (expected, no implementation yet)
   - GREEN: Implement `src/lib/ipc/invoke.ts` per plan Task 9.1
   - Run tests → PASS
   - Commit per Task 9.2

4. **For Task 10 (mock router + fixtures):**
   - Start with `types.ts` + `index.ts`:
     - RED: `src/lib/ipc/mocks/index.test.ts` — test router throws for unknown cmd, routes to handler for known cmd
     - GREEN: write `types.ts` + `index.ts` with just notes routes wired
     - Commit
   - Then each domain mock file — **one at a time**, each test-first:
     - For `notes.ts`: write `notes.test.ts` FIRST:
       - `notes_list` returns all notes (12 fixtures)
       - `notes_list_by_folder({folderId: 'folder-1'})` filters to folder-1 notes (expect 4 per plan fixtures)
       - `notes_get({id: 'note-1'})` returns note
       - `notes_get({id: 'missing'})` rejects with NotFound error
       - `notes_create({title, body, folderId})` appends to list, returns new note with generated id + timestamps
       - `notes_update({id, title})` mutates in place, returns updated note
       - `notes_delete({id})` soft-deletes (sets deletedAt), returns `{ok: true}`
     - Run tests → FAIL
     - GREEN: implement `notes.ts` per plan Task 10.3
     - Run tests → PASS
     - Commit
   - Repeat for **each of 18 remaining domains** (tasks, calendar, inbox, journal, folders, tags, bookmarks, templates, settings, vault, auth, sync, search, graph, properties, reminders, saved-filters, updater).
   - **For each new domain:**
     - Inspect `apps/desktop/src/preload/api/` and `apps/desktop/src/renderer/src/services/` to discover which commands the renderer uses for that domain. Example: `apps/desktop/src/preload/api/vault.ts` lists all vault-* commands.
     - Derive Tauri command names: Electron `window.api.vault.openVault(path)` → Tauri `vault_open` (camelCase to snake_case, arg becomes single input object `{path}`).
     - Write test file with handlers for every command discovered.
     - Implement domain file.
     - Commit.

5. **For Task 11 (listen wrapper):**
   - RED: `src/lib/ipc/events.test.ts`:
     - `listen('test-event', cb)` returns an unlisten function
     - `listen` wraps Tauri's listen — verify by mocking tauri API
     - `listenOnce` auto-unsubscribes after first fire
   - GREEN: implement per Task 11.1
   - Run tests → PASS
   - Commit

### Critical discovery workflow

For each of the 19 domains, **you will not know all commands a priori**. The plan gives example commands for notes, tasks, folders, auth. For the remaining 15, you must:

1. Read `apps/desktop/src/preload/api/<domain>.ts` (if exists) — lists the `window.api.<domain>.*` surface
2. Read `apps/desktop/src/renderer/src/services/<domain>-service.ts` (if exists) — shows what renderer actually calls
3. Grep for `window.api.<domain>` across `apps/desktop/src/renderer/src/` to catch direct renderer→preload calls bypassing services

Use this to build the command list per domain. Minimum expected commands per domain:
- `<domain>_list` (if renderer lists the entity)
- `<domain>_get` (if renderer fetches by id)
- `<domain>_create`, `<domain>_update`, `<domain>_delete` (if renderer mutates)
- Event listeners like `<domain>_on_created` → map to Tauri event `<domain>-created`

If a domain has zero calls from renderer (unlikely), still create an empty `<domain>.ts` exporting an empty `MockRouteMap` — keeps the router stable for M2+ when commands arrive.

### Fixture sizing

Per spec Section 3 "Mock IPC layer during M1": fixtures must be **large enough to exercise each page's rendering (10+ items per collection)**. Don't stub with single-item lists — you need:
- Notes: ≥12 (plan provides this)
- Tasks: ≥15 (plan provides this)
- Folders: 3 (matches notes fixtures — plan provides)
- Calendar events: ≥20 spanning 3 weeks
- Inbox items: ≥10 with mix of statuses
- Journal entries: ≥7 spanning last 7 days
- Tags: ≥8
- Bookmarks: ≥10 (variety of domains)
- Templates: ≥5
- Settings: full settings object with realistic defaults
- Others: discover from UI needs; 5-10 items typical

Keep fixtures in a single `const <domain>Fixtures: ...[] = [...]` array inside each domain file, not extracted. Easy to iterate.

### Constraints

- **Every handler async** — even if synchronous. Mirrors Tauri invoke's async surface.
- **Errors thrown by handlers must have descriptive messages.** Future milestones will replace mocks with real backend; error messages should match what renderer UI expects.
- **Turkish character coverage:** include Turkish diacritics in at least one fixture per text-heavy domain (notes, tasks, journal). Validates UTF-8 handling from day one.
- **Coverage target:** ≥ 80% for `src/lib/ipc/**` (router + every mock file). Use `vitest run --coverage` to verify before the final commit of Task 10.

### Acceptance criteria (Phase D done when all pass)

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk

# Files exist
test -f apps/desktop-tauri/src/lib/ipc/invoke.ts
test -f apps/desktop-tauri/src/lib/ipc/events.ts
test -f apps/desktop-tauri/src/lib/ipc/mocks/types.ts
test -f apps/desktop-tauri/src/lib/ipc/mocks/index.ts
test $(ls apps/desktop-tauri/src/lib/ipc/mocks/*.ts | wc -l) -ge 21   # types + index + 19 domains

# Tests pass
pnpm --filter @memry/desktop-tauri test

# Typecheck clean
pnpm --filter @memry/desktop-tauri typecheck

# Coverage
pnpm --filter @memry/desktop-tauri exec vitest run --coverage --coverage.include='src/lib/ipc/**' 2>&1 | tail -10
# Expect lines coverage ≥ 80%

# Commits
git log --oneline | grep -c "m1(ipc)"   # expect ≥ 21 (one per mock domain + wrappers + router)
```

### When done

Report:

```
Phase D complete.
Tasks covered: 9, 10, 11
Commits: <N> (<first_hash>..<last_hash>)
Mock domains: 19
Test files: <count>
Coverage on src/lib/ipc/**: <percentage>%
Commands mocked: <count>
Verification:
  - pnpm test: all pass
  - pnpm typecheck: clean
  - Coverage ≥ 80%

Next: Phase E — prompts/m1-phase-e-renderer-utilities.md
Blockers: <none | list>
```

### Ready

1. Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`.
2. Read plan Tasks 9, 10, 11 fully.
3. Verify prerequisites.
4. Set up vitest.config.ts.
5. Start Task 9 with RED test first.

## PROMPT END
