# Common Gotchas

Issues you'll hit while working on memrynote, and the canonical fixes.

## better-sqlite3 NODE_MODULE_VERSION Mismatch

Symptom: `ERR_DLOPEN_FAILED`, `NODE_MODULE_VERSION X but expecting Y`.

Two fix paths depending on the target:

| Target                 | Fix                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Node tests**         | `pnpm rebuild better-sqlite3` (or `bash apps/desktop/scripts/ensure-native.sh node`)                       |
| **Electron app / E2E** | `bash apps/desktop/scripts/ensure-native.sh electron` (or `pnpm --filter @memry/desktop rebuild:electron`) |

> Using the Node fix for Electron leaves `autoOpenLastVault` silently failing with `ERR_DLOPEN_FAILED`. The app never opens the test vault, and E2E waits for workspace surfaces time out.

## `electron-rebuild -o classic-level` is a silent no-op

Symptom: no `ERR_DLOPEN_FAILED`. The native binding loads, the LevelDB store opens, and the **first write** access-violates (`0xC0000005` on win32) or hangs its callbacks. Windows shipped this way from v2026.705.1 through v2026.903.2 (#1583, #1988): every packaged build carried `build/Release/better_sqlite3.node` and `build/Release/keytar.node`, and no `build/Release` for classic-level at all.

`@electron/rebuild` skips classic-level for two independent reasons:

- Its module walker only descends into `<module>/node_modules`. Under pnpm, y-leveldb's `level` -> `classic-level@1.4.x` sits in a sibling directory inside `.pnpm`, so the copy the CRDT store actually loads is never visited. The only walkable `classic-level` is the dev-only 3.x, which electron-builder then prunes out of the package.
- Even when visited, `Prebuildify.findPrebuiltModule` accepts an existing `prebuilds/<platform>/node.napi.node` and short-circuits the compile. `--force` does not override that; only `--build-from-source` does.

`apps/desktop/scripts/ensure-native.sh` (dev/test) and `apps/desktop/scripts/build-packaged-app.js` (packaging) both handle this by driving each `.pnpm/classic-level@*` copy directly with `--build-from-source --module-dir`. macOS hides a regression here — pnpm's install-time `node-gyp-build` compiles classic-level from source on darwin, so only the Windows build job proves the packaging path. Never treat the plain `-o ...,classic-level` flag as proof the rebuild happened. The only proof is a `build/Release/*.node` inside the classic-level package, which `check-packaged-runtime-deps.js` asserts on every packaged build.

For the same reason, `pnpm check:native` does not `require('classic-level')`. classic-level is N-API, so a wrong-runtime binary loads cleanly and the require would pass on exactly the broken build. The check instead opens a throwaway y-leveldb store in a temp directory, writes an update, reads it back, clears it and closes — through `y-leveldb`, because the CRDT store reaches classic-level via `level` and a bare `require('classic-level')` resolves a different copy. `better-sqlite3` and `keytar` are NODE_MODULE_VERSION addons and keep their plain `require()` probes, which still report the compiled-vs-expected ABI pair.

## First `pnpm dev` in a worktree rebuilds native modules

Symptom: `pnpm dev` sits for minutes on `[native] rebuilding better-sqlite3,keytar,classic-level for Electron...` right after a fresh `git worktree add` + `pnpm install`.

The desktop `postinstall` used to call `electron-rebuild` directly. That did the work but never wrote `apps/desktop/node_modules/.native-build-target`, the stamp `ensure-native.sh` keys off, so `predev` redid the whole rebuild.

The desktop `postinstall` now runs the root `scripts/warm-native.mjs --background --target electron`: a detached warm-up that drives `ensure-native.sh` (and therefore writes the stamp) while `pnpm install` returns immediately.

| Command         | What it does                                        |
| --------------- | --------------------------------------------------- |
| `pnpm warm`     | Run the warm-up in the foreground                   |
| `pnpm warm:bg`  | Re-run it detached                                  |
| `pnpm warm:log` | Print the log path plus `.native-warm.log` contents |

A healthy first `pnpm dev` prints `[native] already built for electron — skipping`. If dev starts while the warm-up is still running it prints `[native] another native build is running (pid N) — waiting...`, blocks on `apps/desktop/node_modules/.native-build.lock`, then re-checks the stamp — it never starts a second concurrent rebuild. A lock left behind by a dead process is detected and cleared on the next run.

`SKIP_ELECTRON_REBUILD=1` skips the warm-up entirely, and `CI` forces it to run blocking instead of detached; CI workflows keep calling `ensure-native.sh` explicitly.

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

## Migrations Are Hand-Written

Drizzle's meta snapshots stop at `0021` for the data DB and `0020` for the index DB, so `pnpm --filter @memry/desktop db:generate` proposes unrelated renames. **Hand-write the SQL and the journal entry** instead of running the generator.

Workflow:

1. Update the schema in `packages/db-schema/src` (`data-schema.ts` or `index-schema.ts`).
2. Add the next migration file, `apps/desktop/src/main/database/drizzle-data/NNNN_description.sql`, or its `drizzle-index/` equivalent.
3. Append its entry to that folder's `meta/_journal.json`. The entry's `when` must be greater than every earlier `when`, or existing installs skip the migration without an error. `migrate-journal.test.ts` checks this.
4. Open a vault. `runMigrations` and `runIndexMigrations` (`src/main/database/migrate.ts`) apply pending migrations when the vault's databases open.

Real users run memrynote on real data, so data DB migrations only add. A migration keeps existing rows valid and never drops, renames, or rewrites a table or column that holds user data. Deleting a vault or its data DB is never a recovery path. The index DB is a cache that rebuilds from the vault.

`pnpm --filter @memry/desktop db:push` is not part of this workflow. It runs `drizzle-kit push` against the scratch databases named in `config/drizzle-data.config.ts` and `config/drizzle-index.config.ts`, which bypasses the migrations entirely.

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

The refresh only helps if the index already holds the new paths. `renameFolder` moves the index rows of everything under the folder itself (`moveIndexedNotesWithFolder`, `src/main/vault/folder-move-index.ts`) before it returns. It used to leave that to the watcher's per-file unlink + add, so a missed watcher event kept the folder at its old path until a restart (#2513). Once the rows have moved, the watcher's events for those files do nothing. Rows whose journal date the move would change are still left to the watcher.

An empty folder cannot produce a phantom, so this class of bug hides until a folder has notes in it — the first rename after creating a folder always looks correct.

Related: folder expanded state is keyed by the `folder-<path>` node id and persisted, in both renderers. A path change must **remap** those keys (`remapExpandedFolderIds`, exposed as `renameNode` on both tree handles), or the folder and everything open inside it collapse on rename and the dead ids linger in storage.

## Case-Only Folder Renames on Case-Insensitive Disks

macOS (APFS) and Windows (NTFS) are case-insensitive by default, so after `Supernotes` becomes `SuperNotes` the old spelling still opens every file. chokidar keeps reporting files and subfolders under the old spelling (`change Supernotes/x.md`, `addDir Supernotes/Sub`). No row has that exact path, so the watcher used to index each file again under a new id, record the old-case folder again, and queue a sync create for every note. The sidebar then showed both folders, only one existed on disk, and the server received thousands of duplicate notes.

The rules that keep this closed:

- The watcher spells every add, change and addDir path the way the disk does (`diskCaseOf`, `src/main/vault/disk-case.ts`, built on the native `realpathSync`) before it looks up a row. A change with no row at the disk's spelling goes to a row at the event's own spelling before it falls back to an add. An outside case-only file rename can land inside the change debounce, so the disk already spells `Apple.md` while the row is still at `apple.md` until the rename's unlink and add match. Adding the new spelling listed the note under a fresh id, and the unmatched unlink then synced a delete of the original (#5247).
- A case twin's write to the file the twins share is recorded under the twin's own spelling (`recordAppWrite`), and the watcher's event carries the disk's. The watcher takes an event as the echo of the app's own write when the file holds bytes recorded under the disk's spelling or under any twin's spelling on that file (`isOwnWrite` in `watcher.ts`, `listCaseTwinPaths` in `src/main/vault/note-sync.ts`). The change path asks whether twins share the file before it reads the file and again after, and keeps the bytes out of the index and the doc when either answer is yes. A twin delete, rename or move that ran between the read and the check left the file unshared, and the other twin took the bytes read (#5624). `listCaseTwinPaths` reads the disk only when another row folds to the path, so a file with no twin costs no I/O per event. A write that lands supersedes the landed records of every spelling of its file (`recordAppWrite` in `src/main/vault/app-writes.ts` groups spellings by folded path and confirms one file by `stat`), so one twin's earlier bytes, put back from outside after the other twin wrote, are an edit and not an echo. The echo check runs inside each handler's `try`, so a failed twin lookup reaches `onError` and the locked-file guard instead of rejecting an add that nobody awaits.
- The watcher pairs a rename's unlink with its add by the index row's content hash, but that hash trails an outside edit until the change debounce has run. Each `change` event's identity key (device, inode, birthtime, size, mtime; `buildFileIdentityKey`) is kept until the file's unlink, or 500 ms after its debounced change ran (chokidar's `atomic` holds an unlink 100 ms). The pending delete carries it, so a rename right after an edit still matches (a rename keeps all five), and the renamed note takes the edit under its own id. Without this, the edit-then-rename synced a delete plus a create, and links, tasks and history tied to the old id were lost (#5518). Size + mtime alone is not enough: same-mtime files are common (1-2 s mtime filesystems, `cp -p`, `rsync -t`, unzip, sync clients), and an unrelated file then took over a deleted note. Inode alone is not enough either: ext4 hands a freed inode to the next file, which then differs only by birthtime. A filesystem that reports inode 0 or no birthtime gets no key and keeps the hash-only match. Where Linux has no statx (kernel before 4.11, or a seccomp filter that blocks it), libuv reports the ctime as every file's birthtime, so a probe at watcher start moves a temp file's ctime and, when the birthtime follows it, keys no file (`probeBirthtime`). Until the probe answers, or when it cannot tell, a birthtime equal to the ctime counts as none. The probe runs once per process and its answer is never checked again: libuv also falls back for the rest of the process the first time any statx fails with EINVAL or EOPNOTSUPP, which can depend on the filesystem (libuv names DVS-exported ones), so a vault on such a mount can switch stat to the ctime stand-in after the probe found real birthtimes. Keys then carry the ctime as the birthtime, and with 1 s timestamps a file written on a deleted note's freed inode the same second shares its whole key. A rename moves the file's ctime, except a file created and renamed within one timestamp tick, so on Linux an add whose birthtime equals its ctime gets no key (`buildAddedFileIdentityKey`): under the fallback no add pairs by identity, and a stale probe answer can only miss a rename, never hand a deleted note to an unrelated file. Do not judge a change's key per file: with statx, a file written right after its creation on ext4 or tmpfs has a birthtime equal to its ctime, and dropping its key sent a quick recreate-then-rename back to the hash-only match. chokidar holds a `change` until the write finishes (100 ms stable), and a rename inside that wait never gets one, so the watcher also stats the file after its raw fs events and keeps that key for 1 s (`RecentFileIdentities`). Without it, a rename 20 ms after an outside edit synced a delete plus a create (#5549). One write reports about three raw events, so each file is stat'ed once per event-loop turn, right after the turn's fs events (`setImmediate`); a rename that beats the stat keeps the hash-only match. The renamed note re-reads its body only when its pre-rename row had a hash that differs; a row the index never read stays unread.
- On macOS libuv watches a file with kqueue and a folder with FSEvents. chokidar's unlink of a renamed file comes from the file's watcher, at once, and the add of its new name from the folder's, which a loaded machine delivers seconds later or never. The add missed the 500 ms rename window, and an outside rename synced a delete plus a create under a new id. The file's own raw `rename` event names the new file, so the watcher keeps that name for the unlink (`RenameTargets`, `src/main/vault/rename-targets.ts`), and the unlink adds that file itself (`addRenamedFile` in `watcher.ts`) instead of waiting for the folder. chokidar's own add of the file, when it comes, waits for that one: `handleFileAdd` runs one add per path at a time. Two adds of one path that both missed the row failed the second on the path's unique row, or broke the rename. A plain delete reports the old name and keeps the 500 ms window. The event names a basename only, which the watcher reads in the old file's folder. A move to another folder under the same name reports the old name, and one under a new name finds no file of that name in the old folder, so both keep the 500 ms window. When the old folder does hold a file of the new name, only that file's add may take the delete (`checkForRename`), and once that add ran without taking it, any add may for the rest of the window (`forgetRenameTarget`). An unrelated file there never claims the note, and the moved file's own add still can.
- chokidar reads a folder before it watches it, and on macOS the folder's FSEvents watch starts later still, so a file written in that gap reports nothing. The read-only lock's attachment watch (`src/main/vault-locks/attachment-watch.ts`) reads each folder it adds again 2 s later and protects the files it finds, and for the attachments root each note's folder. Without it, a file added to a locked note's attachments folder right after the lock, or in a note folder just created, stayed writable.
- While the app runs its own folder rename, the watcher skips the add and change events for notes the app already moved.
- A delayed unlink is dropped when the data DB shows the note now lives at another path. The index catches up in batches, so on Linux an unlink of the old path can arrive after the data DB moved the note.
- `moveNotesInCache` moves every data-DB row in one synchronous pass, then updates the index in batches of 500 with a flush between them. One update per note used to overflow the 2,000-event projection queue, and the overflow left notes at the old path for good.
- The notes list refetch from note events is throttled (`use-notes-query.ts`). One refetch per moved note pinned main for minutes on a large folder.
- The watcher and the vault-open indexer find a file's row with `findCanonicalNoteForFile` (`src/main/vault/note-sync.ts`), never with an exact path match. A vault whose server copy holds both `SuperNotes/` and `Supernotes/` puts both folders' files into one folder on a fresh macOS device. Sync applies a note at `SuperNotes/a.md`, and the disk reports `Supernotes/a.md`. The lookup matches that row, and the watcher moves it to the disk's spelling under the same id and pushes nothing. An exact match listed each such file again under a new id and pushed it as a create (#5261). The case-insensitive candidates come from `listNoteMetadataByFoldedPath` (`packages/storage-data`), an in-memory index of `note_metadata` keyed by the folded path. It is only a cache: the exact path is looked up in SQL first, each candidate is re-read by id, and `diskCaseOf` proves the match. A write to `note_metadata` that bypasses the repository on the same connection is invisible to it until another connection commits.
- Two distinct rows whose paths differ only in case (case twins) share one file, and the file holds only one twin's body. `findCanonicalNoteForFile` reports `sharesFile` when more than one row resolves to this file on disk (`diskCaseOf`), including a row at the exact path. Rows that only share a fold key are not twins: on APFS `ılık.md` and `Ilık.md` are two files. `refusesCaseTwinFile` (same file) is the one rule that keeps a shared file's body out of a doc. The watcher's change path, the write-back's outside-edit branch, and the provider's file read for a seed or an owed file body (`openNoteFile` in `crdt-provider.ts`) all ask it first. The write-back does not overwrite a shared file either, and it does not re-queue the owed full state of a twin whose file the take refuses. Taking it pushed one note's body into the other on every device (#5297).

Vaults already damaged by the old behavior heal at vault open (`case-variant-heal.ts`). Rows whose paths differ only in case and point to the same file collapse onto the row that matches the disk's spelling, but only when the dropped row is a real copy: the index read the same body for it as for the kept row, and it has no change waiting to sync (`readLocalBodyFacts`). The index hash says only what the file held when indexed, so a row with a queued body or record change, a record change not yet queued (a clock and no sync since the last change), an owed file body, or a refused push stays until that change is sent, and a later vault open drops it. Sync off queues nothing, so the heal also reads the row's saved doc (the open editor's, or the CRDT store's): a row whose doc body is not empty, differs from the kept row's (block ids aside), and holds a change the server has not taken (`pushedStateVector` does not cover it) holds an edit the shared file lacks and stays. A copy whose differing doc the server already holds goes, so a pre-#5297 copy is not kept forever. `pushedStateVector` records only this device's own pushes, and nothing on the device records what else the server holds. A peer's edit pulled into a copy's doc, or a doc built from a pulled snapshot, therefore looks the same as text typed here and never sent, and that copy stays: a duplicate in the sidebar, with no text lost. The heal waits for the CRDT store only when some row is a copy, and it decides each drop with no await after its last doc read, so a keystroke made during the read keeps the row. While the doc store is not open (an in-memory session), no note row is dropped. A row with its own body is a distinct case twin, whether it ever synced or not. The heal keeps it, so `refusesCaseTwinFile` keeps both twins' bodies apart (#5297). Moving a block into a case twin fails with an error, and a rename leaves a twin's links to the renamed note stale. Deleting a case twin, locally (`deleteNote`) or from a peer's tombstone (`noteHandler.applyDelete`), drops its row and leaves the shared file to the other twin (#5495). The owner is `case-twin-file.ts`, and nothing durable happens before the delete's own step. `prepareCaseTwinLeave` converts the survivor's doc into its file body, and `planCaseTwinLeave` does every read and check. Then one synchronous step writes the survivor's own file (`writeNoteFileNow`), records it as the survivor's baseline, and drops the leaving row. A local delete also queues its tombstone in that step (`deleteNote` runs it inside `syncNoteDelete`). So a file that cannot be read or a doc that cannot be converted aborts the delete with both rows intact and nothing queued for peers, and a crash after the step finds the survivor's own bytes. Bytes that are not the survivor's never become its baseline. Bytes neither twin holds (an outside edit no doc has) are kept as one of the survivor's versions; the deleted twin's own bytes are its doc's and stay out of the survivor's history. A lone note's delete that finds a twin arrived on its file while it awaited changes nothing and asks for a retry when the twin is there before the tombstone is queued, and drops only its row, leaving the file to the twin, when the twin arrives after. The survivor's header is rebuilt from its index rows: header tags, properties, aliases, and the cover ref. Properties come back as the file held them (`getNoteFileProperties`): a list or map from its JSON text and a date as a date, so the serializer writes them as YAML lists, maps and dates instead of quoted strings (#5558). A value in the twin's own last header that stores as the row's text keeps its YAML type, so a quoted string that spells a date or JSON stays a string. That header comes from the twin's version (`note_snapshots`) that holds the bytes its baseline names, never from the shared file, whose header may be the other twin's. With no such version the row's type stands, and the quoted string comes back as a date or a list (#5721). An image cover's framing and credit live only in the file, so the rebuilt file has the bare ref. Its `unframed:<ref>` cover marker keeps the next push from sending the cover until it changes on this device, so peers keep the framing. A cover removal built for push and not yet acked (`removal-pending`) stays pending through the rebuild, so its retry still sends the `null`. A desktop build from v2026-10-14 on that predates the marker (#5499) reads it as no marker. When such a build opens the vault, its next push of the note sends the bare cover with default framing, so peers drop the cover's credit and reset all of its framing, `coverFocus` included. Builds before v2026-10-14 sync no cover. This is a known limitation, and nothing on the server can stop it: desktop sends no `x-memry-client` header, and the client gate gives a write without one full access (`apps/sync-server/src/middleware/client-gate.ts`, protocol chapter 11 §11.3), so a client version floor never applies to desktop. A survivor with an empty doc keeps its header alone. A binary survivor (`isBinaryNoteRow`) has no doc to rebuild a file from, so its leave keeps the shared file's bytes as they are; a markdown survivor of a binary twin gets its own file rebuilt as usual (#5562). A peer's delete (`noteHandler.applyDelete`, synchronous) throws `CaseTwinLeaveNotReadyError`, a `PendingSyncIntentError`, until the survivor's body is prepared, no page apply owes the file a write (`hasPendingVaultFileOp`), and no write-back turn of the deleted twin runs (`hasWritebackTurn`); the pull retries it. A local delete waits that turn out before its step, and when a save that started while the delete awaited stops the step, the delete runs once more after that save's turn (`deleteCaseTwin`). A pass past its checks would land the deleted twin's body on the survivor's file after the step and re-create its row after the tombstone (#5559). Renaming or moving a twin, locally (`renameNote`, `moveNote`) or from a peer's update (`noteHandler.applyUpsert`), goes through the same owner (`planCaseTwinMove`): in one step the shared file becomes the other twin's own, and the moving twin's own file, its bytes on disk when they are its own or else its doc's body under a header rebuilt from its index rows, lands at the new path with its row. The move has the delete's write-back fence: a peer's throws `CaseTwinLeaveNotReadyError` while a write-back turn of the moving twin runs, and a local one waits that turn out, because a pass past its checks writes the old path after the step, putting the moving twin's body over the survivor's file and its row back on the shared file (#5610). The step moves the row in one data-DB transaction, so a throw there leaves the row on the shared file, and a throw after the moving twin's file is written removes that file, which no row then names. A write-back takes the note's path from its index row, so a peer's step moves the index row's path in that transaction too, last, and a local move publishes its index event once the transaction commits (VERIFY-5618). A peer's frontmatter-only update (tags, properties, aliases, cover) of a twin whose bytes are not the shared file's goes to its index rows only, the header a split writes to the twin's own file, and leaves the file as it is. Its body tags come from its own doc, so an update of its tags throws `PendingSyncIntentError` until the doc's body is converted, and the pull retries it. A doc that cannot be converted leaves its body tag rows as indexed, and the update lands: holding it until the doc converts held it for good (VERIFY-5618). The twin whose bytes are there takes the update in the file (`updateCaseTwinOffFile`, #5561). A local header edit of such a twin (properties panel, tags, aliases, template, tag rename) goes the same way: `updateNote` rebuilds its own file from its doc's body and its index rows (`caseTwinOwnFile`), applies the edit there, and indexes the result without writing the shared file, so a later split writes the edited header with its other properties and their YAML types. A body edit of such a twin through `updateNote` is refused before the doc takes it (#5742). A cover edit of such a twin is refused the same way (`assertOwnHeaderCoverUnchanged`): its push leaves out `cover`, and a peer's cover still applies. The renderer shows each refusal as an error and keeps the typed text. A twin rename that would make it a journal, and a binary twin's, are refused. Binary twins (attachment notes) have no doc to rebuild a file from. A change to a binary file two twins share is not pushed as either twin's attachment: the watcher logs it, holds it, and records the hold in `sync_state` (`caseTwinHeldChanges`, #5522). A peer's rename or move of a binary twin (`noteHandler.applyUpsert`, through `planBinaryCaseTwinMove`) leaves the shared file with the other twin and copies it to the moving twin's new path in the same synchronous step as the row move; a copy that fails fails the item with nothing moved (#5560). A peer's delete of a binary twin leaves the survivor the same file. Either way a file may then hold the other twin's bytes, so each twin's own attachment is asked for onto its file (the survivor through `planBinarySurvivor`), recorded as owed in `attachment_download_failures` so the re-driver asks again when no downloader took it (no token, sync restarting). That download runs with attachment auto-download off too, and the re-driver's pass while the setting is off asks only for these (`downloadsInBackground`, `askForHeldOwnBytes`, #5580): until it lands the file holds bytes that are not its own and none of its changes sync. Until it lands, the note has a `caseTwinForeignBytes:<noteId>` row in `sync_state` with the sha256 its file had (an older build's single `caseTwinForeignBytes` object moves to these rows on first touch), and no watcher path pushes the file, nor does the attachment backfill (`holdsBinaryUpload`): the change path, the add path that adopts a row under the disk's spelling, and the add path that claims a row the index lacks all ask `holdsBinaryChange`. A pulled record update of such a note asks for its attachment again, which may be a new one. The landing (`landCaseTwinDownload`, the downloader's `beforeFileLands`) puts a download asked for at a path the note has since left at its file now, and first keeps the file's bytes as a new file next to it, `<name> (conflict copy)`, which the vault takes in as a note of its own, when they hold a change on no server: one the watcher held before the split, bytes that differ at the split from the ones a download last landed on the shared file (`caseTwinLandedHashes`: an edit made while the app was closed, or whose event is on the way, whatever its size; with no landing recorded the bytes count as changed), or any change since the mark (#5585). A twin's download that lands on a file the twins still share (a peer gave it a new attachment) keeps the file's bytes the same way when they differ from the ones a download last landed there, or when no landing is recorded (#5594), and forgets a change the watcher held to the file. The first bytes to land where twins' rows name no file yet (a fresh device) are recorded as landed, so the other twin's landing keeps no copy of them. Bytes equal to the ones landing are not copied. A kept copy is recorded with its path under the file's folded path (`caseTwinKeptCopies`), and a later landing on that file, before or after a split, counts its bytes as kept only while that copy still holds them. So a landing whose rename fails and retries keeps one copy, and a copy moved back over the file, changed, deleted, or unreadable leaves the bytes to be kept again (VERIFY-5602R2). The split never counts kept bytes as known: a file that holds them and not the last landed bytes is marked as changed, so a copy that goes between the split and the landing never takes the edit with it. `recordDownloadedFileSize` then clears the mark. A peer's move marks the moving twin's copy the same way as the file it copies, so a change on no server is kept from the copy too, even after the user changes the shared file again (VERIFY-5602R3). A dangling symlink at a conflict copy's path counts as taken (`generateUniquePathSync`), so the copy goes to the next free name instead of failing every retry. A twin with no attachment, or kept local only, has no other copy of its bytes, so its file is the best copy there is: it is not marked, stays pushable, and the split logs a warning. A download the server no longer has keeps the file held. A folder rename that would leave a twin spelled with the folder in another case behind is refused (#5498). A folder rename runs inside the write-back turn of every note in the folder (`moveFolderHoldingWritebacks`, #5671): it waits out a pass in flight and holds the turns until the rows are at their new paths. A pass that read a twin's row before the move wrote the old path after it, making the folder again with that twin's body alone, and the file the other twin kept held bytes that were not its own, which its next read took in (#5643). A folder delete runs only when the disk spells the folder as asked, in case and Unicode form, and no note spelled with the folder in another case has its file in it (#5642, `assertFolderDeleteKeepsCaseTwins`). The sidebar draws a folder for each spelling the rows have, and the recursive delete of one spelling removed the one folder on disk that holds them all. The delete first reads the path as rows name the folder (`vaultFolderPath`: `./Supernotes/` and `Supernotes\` are `Supernotes`), so the guard and the delete see one folder, and it refuses the vault itself and any path outside it (#5653). On Windows it also refuses a folder whose name ends in a dot or a space (`windowsTrimsFolderName` in `packages/storage-vault/src/vault-folder.ts`, which the CLI's folder commands share): Windows reads a peer's `Work.` as `Work`, so the recursive delete would remove that folder. The refusal is `errors:folder.deleteWindowsName`, which tells the user to delete the notes in the folder one by one, and the MCP `vault_delete_folder` schema refuses the same names before the approval gate. The sidebar's delete dialog asks main for the refusal (`notes:check-folder-delete`) before it deletes the paired note or the rest of the selection. The heal is local only: it touches no file and syncs no delete, because a case-insensitive peer can hold the duplicate and the real note in one file, and a synced delete would unlink the real note there. Duplicates that were already pushed stay on the server and on other devices. A folder_config row is dropped only when it never entered sync (no clock) and its icon is null or the kept row's; a synced folder twin stays, and the folder list reads the row the disk spells (#5327). On Linux each spelling is its own file, so the heal changes nothing. The specs for this path run only where the file system folds case (`fileSystemIgnoresCase()`), so the ubuntu unit job skips them; the nightly `case-insensitive-unit` job in `nightly-platform-smoke.yml` runs them on macOS.

A binary note's `caseTwinForeignBytes:<noteId>` and `binarySyncedHash:<noteId>` rows in `sync_state` go with its row (`removeCanonicalMetadata` in `note-sync.ts`): a delete here, a peer's delete this device applies, a case twin's leave, or any other path that drops the row. Each of these removes the file or leaves it to another row, and the pull does not re-create an id while this device's delete of it is pending, so the marks protect nothing once the row is gone. A download of the note's own attachment that finishes after the row drops is dropped before it lands (`assertOwnAttachmentLands` throws `SupersededDownloadError`) and records no hash, so the deleted note's file does not come back as a new note (REVIEW-5662). Without this, `sync_state` grew by a row per deleted note, and an id a peer re-created inherited the old hold: its file downloaded with attachment auto-download off, and its changes stayed unsynced until then. A delete that does not drop the row keeps both: a peer's tombstone that loses to this device's newer clock, or a local delete whose queueing fails. Sign-out and the emergency wipe keep the case twin rows (`caseTwinForeignBytes`, `caseTwinHeldChanges`, `caseTwinLandedHashes`, `caseTwinKeptCopies`): they describe this device's files, not the session, and with the holds wiped the watcher pushed a twin's bytes as the note's own after the next sign-in (#5754). The emergency wipe is a session reset: the integrity teardown after it keeps the vault files and the CRDT store, so it deletes only `sessionState()` rows too. The keep-set lives in `sync/device-local-state.ts`, with a row per key in `session-teardown-device-local.test.ts`. The hold readers (`holdsBinaryChange`, `holdsBinaryUpload`) live in `case-twin-hold.ts`, apart from the marks in `case-twin-bytes.ts`, because they read the rows on a file through `note-sync.ts`.

## Windows: The Vault Watcher Locks Every Folder That Has a Subfolder

chokidar watches the vault with one `fs.watch` per directory, and on Windows each of those is an open directory handle. Windows refuses to rename a directory while anything beneath it is open, so `fs.rename` of any vault folder that contains a subfolder fails `EPERM` for as long as the watcher runs. Retrying never helps. A folder with no subfolder renames fine, which makes the failure look like it only hits "certain folders" (#2206).

Move vault folders with `moveDirectory` (`src/main/vault/move-directory.ts`), never a bare `fs.rename`. It falls back to an entry-by-entry move into a dot-named staging directory, which the watcher ignores, and renames that into place last, so the watcher still sees one complete folder appear and keeps each note's identity. The canvas folder store (`canvas/folder-store.ts`) still uses `renameSync` and has the same exposure.

The entry-by-entry move unlinks each file long before the folder reappears, often for seconds. Run every app folder move or delete inside `withAppFolderChange` (`src/main/vault/app-folder-changes.ts`): the rename tracker holds a pending delete under such a folder until the change ends, and an unlink that outlived the 500 ms rename window there was once synced as a delete of every moved note (#5695). The fallback also records itself in `.memry/moves/` (the records the Tauri app also sweeps) until it ends. When it fails and cannot undo, or the app quits mid-move, the source folder stays held, and the next vault open puts the staged entries back before the removal replay. That roll-back merges a subfolder the move had split and never replaces a file. A record whose staging directory is gone belongs to a move that finished, so the open only drops the record and the replay re-keys each row to its moved file. The record is the Tauri app's format, `{"version":1,"from":…,"staging":…}` (`crates/memry-desktop/src/vault/move_journal.rs` on `feat/tauri-v2`), so either app recovers a move the other left.

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

## A Closing Menu Still Steals Focus from the Field It Just Opened

A Radix menu is not gone when it closes. `Presence` keeps it mounted for its exit animation — roughly 150ms — and it keeps answering pointer events for that whole window. A pointer leaving an item runs the menu's `onItemLeave`, which focuses the menu content; a pointer moving over an item focuses the item. Both are normal menu behaviour, and both are fatal to a "Rename" item that opens an inline field on the row underneath: the field focuses itself a frame after the click, the menu takes focus back a beat later, and because a blur commits and closes these fields, the rename ends before a key is pressed. Nothing throws, so no telemetry fires.

It reads as random on macOS because it only happens when the pointer moves during the fade. On Windows it happens on nearly every click. The likely trigger is the mouse move Windows delivers right after a click even when the mouse stayed put: in Chromium, one zero-distance `pointermove` on the chosen item is enough. The same theft closes a popover the item opened, such as the row **Set Icon** picker (#2340): the popover reads focus moving into the menu as an outside interaction and dismisses itself.

The guard lives in the menu items. `inertWhileMenuCloses` (`components/ui/closing-menu.ts`) wraps `onPointerMove` and `onPointerLeave` on every item, checkbox item, radio item, and sub-trigger of `ContextMenu` and `DropdownMenu`. When the enclosing menu content is `data-state="closed"`, it calls `preventDefault()`, and Radix skips its own item handler for a default-prevented event. A fading menu can no longer take focus.

The `data-[state=closed]:pointer-events-none` class on the content does not do this on its own. A modal menu's `DismissableLayer` keeps an inline `pointer-events: auto` on the content until it unmounts, and an inline style beats the class, so the closing menu stays hit-testable. Adding `!important` is worse: hit-testing then flips under a still pointer, and the browser fires a `pointerleave` on the chosen item at once.

`handleInlineRenameBlur` (`lib/inline-rename-focus.ts`) stays on the inline rename fields as a backstop: a blur whose `relatedTarget` sits inside a menu already marked `data-state="closed"` is focus theft, so the field takes focus back instead of committing. It deliberately ignores menus that are still open: a menu the user opens over an active field owns focus, and taking it back there fights the menu's own focus trap forever.

The separate `onCloseAutoFocus` → `preventDefault()` in `components/ui/context-menu.tsx` covers a _different_ path: the focus restore Radix runs when the content unmounts. Do not mistake one for the other.

**Testing this needs a moving pointer.** `page.click()` parks the mouse where it clicked, so a spec that clicks a menu item and then asserts is blind to this whole class. `tests/e2e/sidebar-folder-rename.e2e.ts` and `tests/e2e/sidebar-icon-picker-context-menu.e2e.ts` keep the pointer moving for about 150ms after the click (`clickMenuItemAndMoveOn`). jsdom sees it only when a stylesheet gives the menu content an exit `animation-name`, because `Presence` otherwise unmounts the menu in the same commit. `components/icon-picker-button.context-menu.test.tsx` and `components/ui/dropdown-menu.test.tsx` do that.

## A Hidden Vault's Menus Must Hide With It

`VaultStack` in `App.tsx` keeps recently visited vaults mounted inside a hidden `<Activity>`. React hides an Activity by setting `display: none` on its top-level DOM nodes. Before React 19.3 that did not reach portals, and Radix menus, dialogs, and tooltips portal to `<body>`, outside the hidden tree.

That broke switching from the vault menu (#2504). Picking a vault closes the menu with a short exit animation and starts the switch. When the switch landed before the animation ended, the old workspace was hidden and its effects torn down, `Presence` included, so the menu never saw `animationend` and never unmounted. Floating UI lost its anchor and parked the menu in the window's top-left corner. Its rows sat there at opacity 0 and still took clicks, so a click on the rail or on the Settings back button switched to whichever vault's row lay under it.

React 19.3 hides portal contents with their Activity (facebook/react#35091), so keep `react` and `react-dom` at `^19.3.0` or later. A portal container placed outside a workspace's Activity brings the bug back. Regression coverage: `App.test.tsx`, "hides a menu the leaving vault has open along with its workspace, and brings it back".

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

## Virtualized UI Tests

`@tanstack/react-virtual` + jsdom = zero items rendered (because jsdom doesn't compute scroll heights). Cover virtualized calendar, week-view, and long-list UIs at the **Playwright E2E layer only**.

## CRDT Sign-Out / Sign-In Ordering

When working in `apps/desktop/src/main/sync/runtime.ts`:

```
engine.start()                      # pull from server FIRST
  └─ seedExistingCrdtDocs()         # fire-and-forget, only fills orphans
```

Reversing the order causes split brain. See [CRDT & Notes Sync](/architecture/crdt) for full reasoning.

## Journal Properties Are One Record

`updateJournalEntry` (`src/main/journal/update-entry.ts`), behind IPC `journal:updateEntry` and the agent's `journal.update`, takes `properties` as the entry's whole record and writes it over the file's. It does not merge keys. A body update that also sets tags or properties writes them again in the entry's write-back turn (#5479): the tags as the edit it made, the properties as the whole record. A tags save that lands while the update waits for that turn keeps its tags, but a properties save in the same spot loses the keys the update's record lacks. This is accepted (#5247): the later writer's record wins whole. To change single keys, call `patchJournalProperties` (`src/main/journal/properties.ts`, behind `mergeEntityProperties`). It sets them on the record the file holds, in the entry's turn.

## Logging

Log through `createLogger('Scope')`, from `src/main/lib/logger.ts` in main and `@/lib/logger` in the renderer. Both wrap electron-log. Never call `console.*`; the pre-commit renderer guard rejects it in renderer files.

## DevTools Startup

The desktop app does not open DevTools automatically in development or production. Open them manually from the View menu or with the Electron DevTools shortcut when debugging startup.

## User-Facing Errors

Always strip Electron IPC noise from error messages before display:

```ts
import { extractErrorMessage } from '@/lib/ipc-error'

toast.error(extractErrorMessage(err, 'Could not save note'))
```

## RTL-Safe Tailwind

New code must use logical properties (`ms-*`, `pe-*`, `start-*`, `text-start`, `border-s`, `rounded-s-*`) instead of physical ones (`ml-*`, `pr-*`, `left-*`, `text-left`, `border-l`, `rounded-l-*`).

oxlint does not check this. The pre-commit renderer guard (`scripts/check-staged-renderer-guards.mjs`) rejects physical direction classes in staged renderer source files, and it scans each whole staged file, not just new hunks. If you touch a file that still has physical direction classes, convert them to logical equivalents before committing.

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
