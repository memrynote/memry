# Common Gotchas

Issues you'll hit while working on memrynote, and the canonical fixes.

## better-sqlite3 NODE_MODULE_VERSION Mismatch

Symptom: `ERR_DLOPEN_FAILED`, `NODE_MODULE_VERSION X but expecting Y`.

Two fix paths depending on the target:

| Target                 | Fix                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------ |
| **Node tests**         | `pnpm rebuild better-sqlite3` (or `bash apps/desktop/scripts/ensure-native.sh node`) |
| **Electron app / E2E** | `bash apps/desktop/scripts/ensure-native.sh electron` (or `pnpm rebuild:electron`)   |

> Using the Node fix for Electron leaves `autoOpenLastVault` silently failing with `ERR_DLOPEN_FAILED`. The app never opens the test vault, and E2E waits for workspace surfaces time out.

## Electron binary re-downloads on every worktree

`bash apps/desktop/scripts/ensure-native.sh electron` (and the E2E fixtures, when
`path.txt` is missing) fetch the ~115 MB Electron release zip from GitHub releases.
Every fresh worktree pays that again, and the download is the single most common
reason the install fails outright: `curl: (56) Connection died, tried 5 times before
giving up`.

Set `MEMRY_ELECTRON_CACHE_DIR` to reuse one copy across worktrees:

```bash
export MEMRY_ELECTRON_CACHE_DIR="$HOME/.cache/memry-electron"
```

The installer stores the verified zip there and, on later runs, restores it instead of
downloading. Restored artifacts are not trusted: each one is hashed against the
`checksums.json` shipped inside the `electron` npm package before extraction, and a
mismatch deletes the entry and falls back to a normal download. Leaving the variable
unset keeps the previous always-download behaviour.

Desktop CI sets this automatically via `.github/actions/cache-electron-binary`, keyed
by the locked Electron version plus the runner's OS and arch.

## Electron major upgrade — native ABI + V8 API removals

Bumping the `electron` major (e.g. 39 → 43) is more than a version change:

- **Rebuild both native targets.** Every `.node` addon (`better-sqlite3`, `keytar`, `classic-level`) must be rebuilt for the new ABI, and the Node-test ABI differs from the Electron-runtime ABI (see the NODE_MODULE_VERSION gotcha above). A Node rebuild is not proof for the Electron runtime, or vice-versa.
- **`node-abi` can lag the release.** `@electron/rebuild` fails with `Could not detect abi for version <X>` when its transitive `node-abi` predates the new Electron; the repo's `minimumReleaseAge` gate can also hold `node-abi` at an older version. Fix: pin `node-abi` in `pnpm-workspace.yaml` `overrides` to a version that maps the target Electron, and add that version to `minimumReleaseAgeExclude`.
- **V8 API removals only surface in E2E.** V8 15 (Electron 43) removed the legacy `Intl.Locale#textInfo` getter; reading it threw at renderer boot → a blank white window. Vitest cannot catch this (Node's V8 still exposes the old shape) — only E2E on the bundled Electron proves the renderer boots. Feature-detect new APIs (e.g. `getTextInfo()`) and keep a fallback.

### Release verification checklist (E43 and every future major)

The biggest residual risk of a major bump is the **auto-update transition** from the previous major's production build. CI cannot exercise a real prod→new-major update, so run these by hand before promoting the draft release:

- **Real auto-update dry run from the previous prod major → new major**, per platform:
  - **macOS, both arches.** A real E39-prod x64 install and a real E39-prod arm64 install must each self-update. electron-updater's `MacUpdater` picks the `files[]` zip whose `url` includes `arm64` for arm64 hosts and the non-arm64 zip for x64 hosts, so both arch zips must survive the per-arch → merged `latest-mac.yml` step. That merge is now guarded by `scripts/validate-mac-update-manifest.mjs` (fails the release if either arch's `url`/`sha512` is missing), but still confirm a live update on both arches.
  - **Windows (NSIS)** via `latest.yml` — one prod install updates through the differential path (`.blockmap` present next to the `.exe`).
  - **Linux (AppImage)** via `latest-linux.yml`.
- **Packaged native smoke green on all 3 platforms.** `apps/desktop/scripts/check-packaged-runtime-deps.js` runs in the build jobs, but also open each downloaded artifact and confirm no `ERR_DLOPEN_FAILED` on `better-sqlite3` / `keytar` / `classic-level` (native ABI must match the new Electron runtime, not the Node-test ABI).
- **macOS notarization.** `notarize: true` (in `apps/desktop/config/electron-builder.yml`) must succeed and staple; a fresh download opens without Gatekeeper prompts.
- **Blockmaps present** alongside every installer/zip in the release assets (delta updates depend on them).
- **Stage the first new-major release.** Roll it out to a canary slice and watch update-error telemetry before making it `latest` for everyone — the prod→new-major hop is the one thing CI can't prove.

## Zod v4

`z.record(z.unknown())` throws in `safeParse` under Zod v4. Use:

```ts
z.record(z.string(), z.unknown())
```

This caught Phase 3 sync schemas — a few places still use the old form on legacy branches.

## Drizzle Nullable JSON Columns

Drizzle's `.values()` insert distinguishes `null` from `undefined`. For nullable JSON columns, pass `null` explicitly:

```ts
db.insert(tasks).values({
  id,
  fieldClocks: null,    // ← required for nullable JSON
  ...
})
```

Passing `undefined` produces an `INSERT` that omits the column, then SQLite errors on `NOT NULL` columns or returns wrong rows.

## Migrations Are Hand-Written Since 0020

`pnpm db:generate` proposes unrelated renames because Drizzle's meta snapshots stop at `0020`. **Hand-write the SQL and journal entry** instead of running the generator.

Workflow:

1. Update the schema in `packages/db-schema`.
2. Add a new migration file (`migrations/00xx_description.sql`).
3. Append a journal entry in `migrations/meta/_journal.json`.
4. Run `pnpm db:push` to apply.

## Submit Buttons That Disable Mid-Click

If `onClick` calls a handler that synchronously sets state which adds `disabled={isSubmitting}` to the button, the browser **suppresses the click** between `pointerdown` and `click`. The user thinks they clicked but nothing happens.

Fix: fire submit from `onPointerDown`. Keep `onClick` as a keyboard-activation fallback:

```tsx
<button
  onPointerDown={() => void submit()}
  onClick={() => void submit()} // keyboard / accessibility fallback
  disabled={isSubmitting}
>
  Save
</button>
```

See `calendar-quick-create-dialog.tsx` for the canonical version.

## Anchor Rects From Virtualized Scrollers Are Not Viewport Coordinates

The calendar week grid is an **infinitely virtualized day strip**: the grid element is roughly 4.5 million pixels wide, and once it is scrolled to today its own left edge sits about 2.6 million pixels outside the window. Using that element's rect as a popover anchor — for example as a fallback when the day column element cannot be measured — places the popover far off-screen. It still reports as visible and enabled, so a click on it retries until the test or the user gives up.

Two rules when anchoring floating UI on a virtualized grid:

1. Anchor on the **column** element, and derive the column offset (`gridRect.x + columnIndex * columnWidth`) when that element is not measurable. Never collapse onto the strip's own left edge.
2. Clamp the computed position into the viewport on **both** axes, so a bad anchor can never push an action row out of reach.

`computePopoverPosition` in `popover-position.ts` owns the clamp for every calendar popover (task, note, event, inbox-snooze, quick-create).

## The Notes Sidebar Has Two Renderers, and Row Features Must Land in Both

`notes-tree.tsx` swaps components wholesale at `VIRTUALIZATION_THRESHOLD` (100 tree items, `lib/virtualized-tree-utils.ts`): below it a plain `TreeProvider` tree renders every row inline, at or above it `VirtualizedNotesTree` renders its own rows. Any row-level interaction — inline rename, badges, hover actions, drop targets — has to be implemented in **both**, or it silently works only for small vaults.

Inline rename shipped this way: the virtualized tree offered a "Rename" context-menu item that set `renamingFolderPath` / `renamingNoteId` but rendered no input reading them, so above 100 items renaming a folder or note did nothing at all, and a folder created from the sidebar (which enters rename mode immediately) could never be named. Nothing threw, so no telemetry fired either.

Two rules:

1. When adding a row feature, grep both `notes-tree.tsx` and `virtualized-notes-tree.tsx`. Parent-owned state reaches the virtualized rows only if it is prop-drilled through `VirtualizedNotesTreeProps` → `FolderRow` / `NoteRow`.
2. A virtualized row that is scrolled out of view **is not mounted**. State that expects a row to be on screen (rename mode, focus) must also reveal it — expand ancestors, then `virtualizer.scrollToIndex` on the next frame, the way `revealRow` does.

Tests must exercise the real component: `notes-tree.test.tsx` pins `shouldVirtualize` to `false` **and** stubs `VirtualizedNotesTree`, so it can never catch this class of gap. `notes-tree-virtualized-rename.test.tsx` renders the real tree on both sides of the threshold; follow that shape.

## The Notes Sidebar Tree Is the Union of Two Data Sources

`buildTreeFromNotes` (`notes-tree-utils.tsx`) draws a folder node from **either** source, independently:

1. the folder list read off disk — `getFolders` → `listDirectories`
2. every folder path it synthesizes from the `path` of each note in the index

They are backed by different queries (`notesKeys.folders()` and `notesKeys.lists()`), so refreshing one and not the other makes the tree render a folder that exists in only one of them.

Moving a folder rewrites the note paths, so **every folder-path mutation must refresh both**. Renaming a folder used to `await refreshFolders()` alone: the folder list already said `New`, the notes list still said `Old/…`, and the tree drew both — the real, now-empty `New`, plus a phantom `Old` carrying every note. The phantom is a normal row wired to the same handlers, so the next action targets a directory that no longer exists: `deleteFolder` is `rm -rf` with `force: true` and no-ops silently, `renameFolder` is `fs.rename` and throws `ENOENT`, which is caught, toasted, and skips the refresh — so the row appears to revert to its old name.

`useNoteTreeActions.refreshFolderTree()` refreshes both and is what rename, delete and drag-move call. Folder **creation** does not move note paths, so it still refreshes folders alone.

An empty folder cannot produce a phantom, so this class of bug hides until a folder has notes in it — the first rename after creating a folder always looks correct.

Related: folder expanded state is keyed by the `folder-<path>` node id and persisted, in both renderers. A path change must **remap** those keys (`remapExpandedFolderIds`, exposed as `renameNode` on both tree handles), or the folder and everything open inside it collapse on rename and the dead ids linger in storage.

## Editor-Zone Mousedown Handlers Steal Focus from BlockNote Menus

BlockNote's shadcn menus (drag-handle menu, side menu, toolbars and their nested dropdowns) render **inline inside `.bn-container`, not portaled**. Any editor-zone mousedown handler — such as the "click the marquee zone to focus the editor at end" handler in `note.tsx` / `journal.tsx`, or the marquee selection hook — therefore also sees clicks on menu items. If such a handler focuses the editor on mousedown, the menu unmounts between `pointerdown` and `pointerup`, so the item's click never lands and the action silently does nothing (for example, drag-handle Colors/Delete appear to do nothing).

Fix: bail before touching focus when the target is inside menu UI:

```ts
if (
  target.closest(
    '.bn-side-menu, .bn-formatting-toolbar, .bn-suggestion-menu, .bn-link-toolbar, .bn-drag-handle-menu, .bn-menu-dropdown, [role="menu"]'
  )
)
  return
```

This mirrors `shouldStartMarquee` in `components/note/content-area/marquee-hit-test.ts`. Regression coverage: `tests/e2e/editor-drag-handle-menu.e2e.ts`.

## Global Keydown Listeners Must Not Depend on Render State

`useKeyboardShortcuts` (`hooks/use-keyboard-shortcuts-base.ts`), `useChordShortcuts` and `useInboxKeyboard` each bind exactly one `window` `keydown` listener per mount. The handler reads the shortcut list — and the tab/inbox state it acts on — from a ref refreshed after every render, so it always sees fresh values without re-registering.

Keep it that way when editing these hooks:

- Do not put render-derived values (shortcut arrays, tab state, list items, callbacks) in the registration effect's dependency array. Every tab open/close/switch and every inbox refetch would then detach and reattach the listener.
- Do not close over that state inside the registered listener either. Read it through the ref, or the shortcut acts on the state from the first render.
- Callers may keep building a fresh shortcut array on every render; the hook absorbs the churn.

## Timers and rAF Handles Scheduled from Callbacks

A `setTimeout` fired from an event handler or a `useCallback` has no owner: the handle is unreachable, so nothing can cancel it. The pending callback keeps its closure — and every value that closure captured — alive until it fires, then runs `setState` on a component that may already be gone.

Use `useTrackedTimeout` (`hooks/use-tracked-timeout.ts`) for delayed work scheduled from a callback. It returns a stable `(callback, delayMs) => void` that remembers each pending handle and clears the set on unmount:

```ts
const scheduleTimeout = useTrackedTimeout()
scheduleTimeout(() => setCopied(false), 2000)
```

Two cases stay hand-rolled:

- A timer created **inside** an effect belongs to that effect — hold it in an effect-scoped variable and `clearTimeout` it in the effect's own cleanup, so it also dies when the effect re-runs, not just on unmount.
- A timer already tracked in a ref (a debounce that each new call replaces) only needs the missing unmount cleanup: `useEffect(() => () => clearTimeout(ref.current), [])`.

`requestAnimationFrame` has the same rule: keep the id and `cancelAnimationFrame` it in the cleanup. A queued auto-focus frame that survives its own teardown will steal focus from whatever replaced it.

Regression coverage: `hooks/timer-raf-cleanup.test.tsx` asserts `vi.getTimerCount() === 0` after unmount, which only passes when the handle was really cleared.

## Cross-Platform Env Vars in package Scripts

`VAR=value cmd` is POSIX-only. pnpm runs package scripts through cmd on Windows, where `MEMRY_ENV=production pnpm ...` fails with `'MEMRY_ENV' is not recognized`. This broke the Windows release build (`apps/desktop` `build` script). Use `cross-env` for any inline env var that must work on Windows too:

```jsonc
"build": "cross-env MEMRY_ENV=production pnpm typecheck && cross-env MEMRY_ENV=production electron-vite build"
```

The macOS and Linux release builds run scripts via `sh`, so the bug only surfaces in the Windows release job.

## Lazy URL Resolution in http-client

The HTTP client resolves URLs **per-call**, not at module-import time. This avoids tests crashing on import when env vars are absent. If you add a new client, follow the same pattern: read env inside the function, not in module scope.

## Pre-Existing Type Errors

These files have known type errors unrelated to runtime behavior. Ignore them when running `pnpm typecheck`:

- `apps/desktop/src/main/sync/websocket.test.ts`
- `apps/desktop/src/main/folders/folders.test.ts`
- `apps/desktop/src/main/sync/sync-telemetry.ts`

For non-contract changes, use `pnpm typecheck:node && pnpm typecheck:web` to skip the flaky `ipc:check` pre-hook and the pre-existing `sync-telemetry.ts` error.

## Virtualized UI Tests

`@tanstack/react-virtual` + jsdom = zero items rendered (because jsdom doesn't compute scroll heights). Cover virtualized calendar, week-view, and long-list UIs at the **Playwright E2E layer only**.

## CRDT Sign-Out / Sign-In Ordering

When working in `apps/desktop/src/main/sync/runtime.ts`:

```
engine.start()                      # pull from server FIRST
  └─ seedExistingCrdtDocs()         # fire-and-forget, only fills orphans
```

Reversing the order causes split brain. See [CRDT & Notes Sync](/architecture/crdt) for full reasoning.

## Logging

Always use `createLogger('Scope')` from electron-log — never `console.*`. A pre-commit hook flags raw `console.*` calls.

## DevTools Startup

The desktop app does not open DevTools automatically in development or production. Open them manually from the View menu or with the Electron DevTools shortcut when debugging startup.

## User-Facing Errors

Always strip Electron IPC noise from error messages before display:

```ts
import { extractErrorMessage } from '@/lib/ipc-error'

toast.error(extractErrorMessage(err, 'Could not save note'))
```

## RTL-Safe Tailwind

New code must use logical properties (`ms-*`, `pe-*`, `start-*`, `text-start`, `border-s`, `rounded-s-*`) instead of physical ones (`ml-*`, `pr-*`, `left-*`, `text-left`, `border-l`, `rounded-l-*`). The lint config allows physical classes only in pre-existing files.

The staged renderer guard scans whole staged renderer files, not just new hunks. If you touch a file that still has physical direction classes, convert those nearby classes to logical equivalents before committing.

## Security Scan Patterns

GitHub code scanning and the local staged-secret hook are intentionally conservative. When fixing or adding security-sensitive code:

- Compare URL hosts through `new URL(...).hostname` or a DOM anchor fallback, not `string.includes()`.
- Write generated files and vault payloads through exclusive temporary files plus `rename`, not predictable temp paths.
- Use `mkdtemp` for tests that need temporary directories.
- Keep log output sanitized. Do not print signing paths, API responses with headers, or raw error objects that may include request data.
- Invoke package-manager CLIs through a resolved Node/Corepack entry point instead of relying on `PATH`.
- For generated TypeScript, prefer data tables plus runtime assembly over interpolating dynamic keys into code snippets.
- In fixtures, avoid object fields named `token`, `secret`, or `apiKey` when the value is runtime data. Use a neutral field name and keep the real header name only at the request boundary.

`scripts/check-staged-secrets.mjs` treats an assignment as credential-shaped only when a sensitive keyword (`SECRET`, `TOKEN`, `PASSWORD`, `API_KEY`, …) is a whole word in the key: `ACCESS_TOKEN`, `refreshToken`, and `APIToken` are scanned, while identifiers that merely contain one inside a longer word — fts5's `tokenize='porter unicode61'`, `tokenizer`, `passwordless` — are not. `scripts/check-staged-secrets.test.mjs` covers both directions and runs in the Secret scan CI job; extend it when you change the rules rather than reformatting the code that trips them.

## Pre-Production Database

memrynote is pre-production and the DB schema is **resettable**. There are no backward-compat constraints on schema changes within the desktop app. If a migration is messy, deleting the local vault is a valid recovery.
