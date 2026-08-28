# Local Storage (Dual SQLite)

memrynote stores all workspace data locally in two SQLite databases via better-sqlite3 and Drizzle ORM.

## Why Two Databases

- **Data DB** — primary, durable storage. Notes, journals, tasks, projects, inbox items, templates, settings, and metadata.
- **Index DB** — derived, rebuildable. Full-text search, link graph, tag indexes, and embedding vectors.

Splitting them buys three properties:

1. **Crash isolation.** Rebuilding the index database never threatens user data.
2. **Cheap reset.** The index can be dropped and rebuilt without re-uploading anything to sync.
3. **Performance.** Heavy read indexes and FTS triggers don't compete with the write path on the data DB.

## Vault Markdown Files

Vault `.md` files carry no MemryNote-managed frontmatter. The app reads only `tags` and
`aliases` from a note's frontmatter; every other key is a plain user property. A note with
no user keys has no YAML block at all.

- **The file path is the note's identity.** The internal note id and created/modified dates
  are stored in canonical `note_metadata` in the data DB, keyed by vault-relative path — never
  written into the files. Legacy keys older versions wrote (`id`, `title`, `created`, `modified`)
  are treated as plain user properties: never interpreted, never rewritten.
- **The filename is the title.** The verbatim basename (without `.md`) round-trips to the note
  title exactly.
- **Rebuilds don't re-identify notes.** Indexing an unknown path adopts the canonical id from
  `note_metadata` by path before minting a fresh one, so dropping and rebuilding the index DB
  preserves note identity.
- **External renames match by content hash.** The file watcher pairs a delete with a following add
  inside a short window using the cached content hash (identical-content collisions match FIFO),
  since files carry no embedded id to match on.

## Derived State Projections

Index-DB state is not written inline by the code that changes a note. Write paths persist
canonical data (the file plus `note_metadata` in the data DB) synchronously, then publish a
projection event; projectors apply it to the index DB — `note_cache` and the link/tag tables,
the FTS tables, and the embedding vectors.

**Every projector has its own queue.** Each one still receives events in publish order, but a
slow projector only delays itself. This matters because the embedding projector awaits a
multi-second model load inside `project()`: on a single shared queue that stalled every other
projector head-of-line, which left `note_cache` holding a renamed note's _old_ path long enough
for reads of that note to resolve a file that no longer existed and come back `null` — a live
note appearing deleted throughout the renderer.

Two consequences worth knowing:

- **Ordering between projectors is not guaranteed.** A projector must work from the event
  payload, never from another projector's output.
- **Index reads are eventually consistent.** They settle a microtask after the canonical write,
  not synchronously with it. Callers needing the index to reflect a write immediately must
  `await flushProjectionEvents()`, which drains every _foreground_ lane.

A lane whose output nothing reads back in the same turn marks itself `background`, and
`flushProjectionEvents()` does not wait for it. Only the embedding lane does: it awaits a ~23MB
model load plus per-note CPU inference, and the indexer flushes once per file, so waiting for it
put that cost in front of every file the indexer touched. A background lane still receives every
event in publish order and still drains on its own — only the barrier is lifted.

**Closing a vault does not wait out the whole backlog.** `closeVault()` drains the projections
before closing the databases, but the drain stops accepting new events first (so a lane that is
still being refilled cannot keep it alive) and gives up after a few seconds. Whatever is still
queued at that point is derived state; the next open re-derives it. The event already inside
`project()` is always awaited, so the databases never close underneath a running projector.

**Reconcile passes run one at a time and are all cancellable.** Alongside the event queues,
projectors expose a reconcile pass that repairs derived state wholesale. More than one can be
requested at once — opening a vault fires a full pass in the background, and a reindex or a
structural config change fires an embedding-only pass on top of it — so the passes are chained
and run sequentially rather than concurrently over the same index database. Every outstanding
pass receives a cancellation signal when the vault closes, and the close waits for all of them
to unwind before the databases are closed; a pass requested after the close has started never
reaches a projector. This keeps vault switching and app quit bounded no matter how many repairs
are in flight.

## Where the Files Live

Inside the vault directory (chosen during [first run](/guide/first-run)):

```
<vault>/
├─ data.db           # primary database
├─ data.db-wal       # write-ahead log
├─ index.db          # derived database
├─ index.db-wal
├─ attachments/      # file payloads
├─ canvases/         # one .excalidraw file per canvas + library.excalidrawlib
└─ leveldb/          # y-leveldb store for Yjs CRDTs
```

## Vault Config Cache

`<vault>/.memry/config.json` holds the vault's exclude patterns, default note folder, journal
folder and date format, and attachments folder. `getConfig()` reads it on most vault operations
— note IO, folder listing, journal resolution, embed resolution, indexing, inbox filing and the
per-note sync handler — so the parsed result is cached per vault in the main process rather than
re-read and re-parsed on every call.

The cache is validated against the file itself, not against a list of known writers:

- Every read stats `config.json` and reuses the cached value only when the **inode, size and
  nanosecond mtime** all match. Any change on disk is therefore picked up on the next call,
  whether it came from the app, from sync, or from editing the file by hand.
- The inode check specifically covers atomic replacement (write temp file, then rename), which
  is how the preferences writer updates `config.json`.
- In-app writes through `writeVaultConfig` drop the entry outright, so back-to-back writes stay
  correct even on filesystems whose timestamps are too coarse to separate them.
- Opening and closing a vault clears the whole cache, so one vault never serves another's
  config.

The on-disk format is unchanged; the cache is purely a runtime concern.

## App Config File

App-level state that must be readable before any vault opens lives in a single JSON file,
`<userData>/memry-config.json` (`src/main/store.ts`): the known-vault list, current vault,
locale, sync state, cached entitlement, capture allowlist, updater preferences and the last
main-window geometry.

It is read once into an in-memory cache and every `store.set` rewrites the **whole**
pretty-printed file synchronously. That makes the file cheap to read but expensive to write,
so high-frequency writers must batch.

### Window Geometry

The main window's size and position are persisted so the next launch (or macOS dock reopen)
restores them. `resize`, `move`, `maximize` and `unmaximize` all feed one trailing debounce
(`createWindowBoundsPersister` in `src/main/window-bounds.ts`,
`WINDOW_BOUNDS_PERSIST_DELAY_MS` = 1500 ms), so a continuous drag settles into a single
config write instead of rewriting the file throughout the gesture. The persister also drops
writes whose geometry matches the previous one — `maximize`/`unmaximize` each fire alongside
their own `resize`, and a window nudged back to where it started re-emits `move` unchanged.
The window `close` handler flushes the pending write so the final geometry is never lost to
a timer that never fired.

The persister is deliberately free of Electron imports (it takes `read`/`write` callbacks) so
the debounce can be unit tested with fake timers.

## Canvas Files

A canvas is a plain `.excalidraw` document in `<vault>/canvases/`, the same way a note is a
`.md` file: **the file is the source of truth, the `canvases` table is an index** that carries
identity, title, timestamps and sync state (`file_path` points at the document).

- **Nothing is encrypted at rest.** Canvas scenes used to live in an encrypted
  `snapshot_ciphertext` column keyed by the vault key. That tied the ink to one machine's
  master key, so it was lost whenever the key changed — a local-only user turning on sync gets
  a brand-new account master key — or when the vault folder was copied to another machine,
  since the key lives in the OS keychain, not in the folder. Everything else in the folder
  (notes, journals, attachments) is already plaintext, so the encryption protected nothing.
- **The file is self-describing.** A `memry` key (`{ id, createdAt, updatedAt }`) rides along
  inside the document. Excalidraw ignores unknown top-level keys, so the file still opens in
  excalidraw.com, and a single copied file keeps its identity.
- **Canonical text.** Scenes are written with a fixed key order (unknown keys, including the
  `memryAssets` image sidecar, are preserved and sorted). Two devices emit identical bytes for
  identical ink, which is what the sync conflict-copy comparison relies on.
- **Paths are portable.** `file_path` is always stored forward-slashed (`canvases/Plan.excalidraw`)
  and re-joined natively at read time, the same convention `normalizeRelativePath` uses for notes —
  a vault written on Windows has to open on macOS. Filenames avoid what only Windows rejects
  (reserved device names like `CON`, trailing dots/spaces), and "same file?" comparisons are
  case- and Unicode-insensitive (`canvasPathKey`), because macOS and Windows are case-insensitive
  and macOS hands back decomposed (NFD) filenames for the composed names we write.
- **Vault open reconciles.** `canvas/reconcile.ts` migrates any legacy encrypted snapshot to a
  file once, and adopts documents that arrived with the folder (USB, git, Dropbox) — a file
  with no index row becomes a canvas, and a file renamed outside the app re-points its row
  instead of duplicating. Rows whose file is missing are reported, never tombstoned.
- **Unreadable is explicit.** A legacy snapshot this device holds no key for keeps its
  ciphertext and is served as `unreadable`; the editor refuses to mount rather than autosave an
  empty scene over recoverable ink.
- **Sync is unchanged on the wire.** Push reads the file, apply writes it; transport encryption
  still wraps a per-item key under the vault key, so the server never sees plaintext.

The shapes library is one `canvases/library.excalidrawlib` in Excalidraw's own format. It is
not a sync type — the file is the only store.

## Schemas

Drizzle schemas live in `packages/db-schema`. Tables of note:

- `notes`, `journals`, `tasks`, `projects`, `inbox_items`, `templates`
- `canvases` (index over the vault's `.excalidraw` files: `file_path`, title, clock)
- `vault_metadata` (stable vault UUID singleton)
- `agent_conversations`, `agent_messages` (encrypted agent chat history)
- `tags`, `tag_links`, `note_links` (graph)
- `properties`, `property_values`
- `sync_items`, `sync_pull_cursor`, `sync_outbox` (sync state)
- `field_clocks` JSON column on tasks and projects (per-field vector clocks)

### Graph Queries

`apps/desktop/src/main/database/queries/graph.ts` answers two different questions with two
different query shapes:

- **Whole graph** (`getGraphData`) scans every markdown note, tag, unarchived task, unarchived
  project, wikilink, relation ref and task↔note row. The graph view asks for all of it, so it
  costs what it costs.
- **Local graph** (`getLocalGraph`) walks outwards from one note, one hop at a time, with
  indexed lookups on both sides of every relationship. It reads the neighbourhood, not the
  vault, so a note's local graph costs the same on a 5,000-note vault as on a small one.

The local traversal still enumerates the edges touching its outermost ring without following
them, because a node's `connectionCount` is its degree in the whole graph rather than inside the
returned slice.

## Migrations

```bash
pnpm db:generate    # propose SQL from schema diff
pnpm db:push        # apply pending migrations
pnpm db:studio      # open GUI
```

> Migrations are hand-written from `0020` onward — see [Common Gotchas](/contribute/gotchas).

## Vault Markdown Files

Notes are plain `.md` files in the vault, and the write path is built around byte preservation: no write happens without a semantic change.

- Every save site compares against the on-disk bytes first; identical content skips the write entirely — no mtime churn, no watcher echo, no sync item, no snapshot.
- The raw frontmatter block is captured at parse time and re-emitted verbatim unless a property/tag edit actually happened; only then is the block re-stringified.
- CRLF vs LF and the presence of a final newline are detected per file and preserved. New files get LF with a single trailing newline.

A golden round-trip test suite (`apps/desktop/src/main/vault/byte-preservation.golden.test.ts`) holds this contract against adversarial files (YAML comments/anchors, CRLF, BOM, missing final newline, Obsidian syntax).

Atomic writes retry transient `EBUSY`/`EPERM`/`EACCES` failures with bounded backoff before surfacing an error — cloud-sync clients (Koofr, OneDrive, Dropbox) and antivirus scanners hold short-lived locks on vault files, especially on Windows.

## Serving Vault Files to the Renderer (memry-file)

Attachments and vault media reach the renderer through the custom `memry-file://local/<absolute path>` protocol, never `file://`.

- URLs are built in the renderer by `toMemryFileUrl` (`src/renderer/src/lib/memry-file-url.ts`): backslashes normalized to slashes, a guaranteed leading slash before Windows drive letters (`memry-file://local/C:/...`), and per-segment percent-encoding so spaces and non-ASCII filenames round-trip. Building URLs by string concatenation is a Windows-fatal bug — the drive letter gets parsed as the URL host and the handler receives a relative path.
- The main-process handler decodes the path and serves it only if it resolves inside an allowlist (the open vault and `userData`). Containment is checked with the platform separator (`isPathInsideDirs` in `src/main/lib/external-url.ts`); a plain `startsWith(dir + '/')` never matches Windows backslash paths.
- `window.open` on a memry-file URL never opens a window or reaches `shell.openExternal`: the main process resolves the path with the same rules and, if it passes the directory check, opens the file in the OS default app via `shell.openPath`.
- In-window navigation is guarded the same way: a `will-frame-navigate` listener on every window's webContents (`src/main/index.ts`, policy in `src/main/lib/frame-navigation.ts`) pins the main frame to the local app document (the packaged `file://` page, or the dev-server origin in dev) plus `memry-file:`. External `http(s)`/`mailto` links cancel the navigation and open in the OS browser; `javascript:`, `data:`, `file:` and unknown schemes are denied outright. Subframes stay permissive for `http(s)` — the CSP `frame-src` directive is the origin gate for embeds like youtube-nocookie — while local and script schemes remain blocked there too.

### Identifying the embedder for http(s) embeds

The packaged renderer is loaded with `loadFile()`, so the note document's origin is `file://`, and Chromium sends no `Referer` from a `file://` document to an https subframe. YouTube refuses to configure its player for an embedder it cannot identify: the embed HTML comes back carrying `ERROR_CODE_EMBEDDER_IDENTITY_MISSING_REFERRER`, and the player renders "Error 153 — Video player configuration error" instead of the video.

An `onBeforeSendHeaders` handler (`src/main/index.ts`, policy in `src/main/lib/embed-referer.ts`) names the app's own site as the embedder — `Referer: https://memrynote.com/` — on a youtube-nocookie request that carries no referrer of its own. Only the `file://` subframe load arrives bare: the dev-server document's `http://localhost` origin, and every request the player itself makes from inside the loaded frame, keep their own referrer and are left untouched. That asymmetry is also why the bug is unreachable in dev.

### What a note stores for an attachment

A note never stores the absolute `memry-file://` URL — that carries one machine's vault path, so the same note on a second device resolves it to nothing. What lands in the markdown is a path relative to the note itself:

- `![caption](../attachments/<noteId>/abc123-photo.png)` for an image
- `<!-- file:{"url":"../attachments/<noteId>/abc123-plan.pdf", …} -->` for the file block

`saveAttachment` (`src/main/vault/attachments.ts`) builds that ref for every caller — the editor's paste/drop, sidebar drops, and every importer — by looking the note's own path up in the index. A note the index cannot place (an importer writing assets before the note exists) falls back to the absolute URL and logs it; that is the shape attachments had before, so nothing is left worse off. Attachment bytes are unaffected either way: sync moves them by the note's `attachments/<noteId>/` folder, not by parsing URLs.

Reading tolerates both shapes and nothing is rewritten on disk, so notes written by older versions keep their absolute URLs and keep rendering on the device that wrote them.

The relative ref resolves back to a `memry-file://` URL at render time only, so the vault stays readable by Obsidian:

- Built-in image/video/audio blocks go through BlockNote's `resolveFileUrl` (`createNoteFileUrlResolver` → `resolveNoteRelativeUrl`).
- The `file` block is a custom spec that renders its own URL, so the same resolver reaches it through `note-file-url-context.tsx`. The resolved URL is never written back to the block's props — that would put the machine path back into the markdown.
- Only the note page passes the note's path as a prop; the journal, canvas cards and a project's home note look it up by note id, from the same index row the write side reads.

Because the ref is relative to the note's folder and attachments stay under `attachments/<noteId>/`, moving a note to a different folder would leave its existing embeds pointing at the wrong place. `moveNote` therefore re-points them: every relative ref in the body is resolved against the _old_ note folder and re-expressed relative to the new one (`rewriteNoteRefsForMove` in `@memry/editor-schema/note-refs`, shared with the CLI's `notes move`), covering both the `![alt](ref)` image embed and the `<!-- file:{"url":…} -->` marker, whose other members are left byte-identical. Refs with a URL scheme, root-anchored refs, refs that climb above the vault root, and wiki-links (which resolve by title, not by path) are left exactly as written.

Two properties that matter more than the arithmetic:

- **A move that changes nothing writes nothing.** A rename inside one folder, or a move that leaves every ref resolving, skips the file write entirely — no `mtime` churn, no snapshot, no sync traffic. A percent-encoded ref keeps its original escapes rather than being re-encoded.
- **The open editor is corrected too.** Main owns the note's Y.Doc and keys it by note id, so a move never invalidates it; the doc would still hold the pre-move body and the next CRDT write-back would put it straight back over the corrected file. `moveNote` pushes the rewritten body into the live doc with `replaceNoteBodyInCrdt` right after the write, the same order `applyTemplateToNote` uses.

### Text colors in markdown

Editor colors persist in two Obsidian-compatible forms:

- **Block-level colors** (drag-handle menu) serialize as an HTML comment marker line before the block: `<!-- colors:{"textColor":"red"} -->` (`packages/shared/src/block-colors.ts`).
- **Inline colors** (formatting toolbar on selected text) serialize as raw HTML spans — `<span style="color:red">…</span>` / `background-color` — which Obsidian renders natively (`packages/shared/src/inline-colors.ts`). Because BlockNote's markdown pipeline drops both literal spans and inline color styles, both serializers route colored runs through markdown-inert tokens: wrapped before `blocksToMarkdownLossy` and swapped for span HTML after; masked before `tryParseMarkdownToBlocks` and re-applied as styles after. Spans inside fenced or inline code are left untouched. Files without markers or spans parse unchanged, and older app versions reading span-bearing files keep the text and lose only the color.

The pipeline is wired into both duplicated serializers: the renderer save path (`markdown-utils.ts`) and the main/CRDT path (`blocknote-converter.ts`).

### Toggle blocks in markdown

BlockNote's HTML export writes a `toggleListItem` as a plain `<li>`, so a toggle used to reach the vault file as an ordinary bullet — the fold gone and every block nested under it flattened out beside it. Toggles therefore have an on-disk form of their own (`packages/editor-schema/src/blocks/markdown.ts`):

```markdown
<details data-memry-toggle>
<summary>Research notes</summary>

Hidden detail

![](../attachments/<noteId>/abc123-diagram.png)

</details>
```

The summary line holds the toggle's own inline markdown; everything nested under it lives inside the region, serialized by the same top-level walk — so nested toggles, images and blank-line gaps inside a toggle behave exactly as they do on a page. A toggle carrying a non-default block colour gets the `<!-- colors:{…} -->` marker line immediately above the `<details>`.

A toggle left expanded is written as `<details data-memry-toggle open>`, using HTML's own `open` attribute, so GitHub and Obsidian render the section unfolded too. The fold is a block prop (`open`, default `false`) rather than editor state: BlockNote keeps it in `window.localStorage` under the block's id, which is per-device and keyed by an id that is minted fresh on every markdown parse, so a fold set there survived neither a re-open nor a sync. The attribute is written only when the toggle is expanded, which is what keeps every collapsed toggle already on disk byte-identical on its next save. Both processes register the block — ProseMirror drops any attribute its schema does not declare, so a spec on one side only would strip the fold on every write-back — and an older app version reading a file with the attribute simply shows the toggle collapsed.

`<details>`/`<summary>` is valid HTML inside GFM, so GitHub and Obsidian render the note as a real collapsible section rather than as markup.

The `data-memry-toggle` attribute is what makes the block Memry's. A bare `<details>` block written by hand in Obsidian is left exactly as the author wrote it: claiming it would run its body through BlockNote's markdown parser, and anything that parser cannot represent comes back different — write-back byte-compares, so that difference would rewrite a file Memry never wrote. A toggle quoted inside a code fence is left as code for the same reason.

Toggle regions are split off before the blank-line and marker-line scanners run, because those read one line at a time and would shred a toggle body apart at its own paragraph gaps. As with colors, both serializers carry it: the renderer save path (`markdown-utils.ts`) and the main/CRDT path (`blocknote-converter.ts`).

A toggle nested under a _list item_ still reaches markdown through the block-nesting markers and flattens to a bullet, as it always has.

## Concurrency

better-sqlite3 is synchronous and single-process. The main process is the only writer. The renderer never touches SQLite directly — all reads and writes go through IPC.

## Background Polling (Shared Minute Tick)

Three features watch the clock rather than an event: due reminders, snoozed inbox items that should
resurface, and the daily inbox review nudge. They share one 60-second timer in
`main/lib/minute-tick.ts` instead of each owning an interval, so an idle app wakes the process once
a minute, not three times. The timer is `unref`'d — polling alone never keeps the process alive —
and it only exists while at least one poller is registered.

Each poller stays cheap when there is nothing to do:

- **Reminders** count pending/snoozed rows first. Zero means nothing can be due, so the due lookup
  is skipped and the tick costs one indexed count. The dock badge is only re-asserted when the
  count actually changes.
- **Inbox snooze** runs a single filtered query that returns no rows when nothing is due.
- **Inbox review** returns before touching the database when the reminder is disabled (the default).

All three also short-circuit when no vault is open. Add a new minute-cadence job by registering it
on the shared tick — do not start another interval.

## SQLite Memory Budget

The desktop main process opens both databases with bounded SQLite page caches:

- `data.db`: `PRAGMA cache_size = -16000` (about 16 MiB)
- `index.db`: `PRAGMA cache_size = -32000` (about 32 MiB)
- both databases use WAL, `synchronous = NORMAL`, and `temp_store = MEMORY`

The previous caps were about 64 MiB for `data.db` and 128 MiB for `index.db`. A controlled
main-process benchmark with 15,000 notes, 5,000 tasks, 2,000 inbox items, FTS, graph links, and
`sqlite-vec` showed the smaller caches kept focused query latency flat while reducing the maximum
SQLite page-cache budget by about 144 MiB. Observed warm RSS was effectively flat because SQLite
does not preallocate the full cache cap.

| Configuration                               |  Warm RSS | Search p50 / p95 |  Graph p50 / p95 | Tasks p50 / p95 | Inbox p50 / p95 | Vector p50 / p95 |
| ------------------------------------------- | --------: | ---------------: | ---------------: | --------------: | --------------: | ---------------: |
| 64 MiB data / 128 MiB index / `MEMORY` temp | 173.1 MiB |   8.86 / 9.56 ms | 35.56 / 40.95 ms |  0.83 / 1.12 ms |  0.19 / 0.24 ms |   0.34 / 0.46 ms |
| 16 MiB data / 32 MiB index / `MEMORY` temp  | 174.1 MiB |   8.75 / 9.33 ms | 34.45 / 37.65 ms |  0.74 / 0.92 ms |  0.18 / 0.19 ms |   0.30 / 0.58 ms |

`temp_store = MEMORY` stays in place because an isolation run with smaller caches and `FILE` temp
store did not reduce RSS in the smaller smoke benchmark and slightly worsened graph p50. Re-run the
benchmark when search, graph, inbox, or vector query shapes change:

```bash
pnpm --filter @memry/desktop db:benchmark -- --iterations 25
```

## Native Media Processing

Image, PDF, and video thumbnail generation stays local, but the native image stack is not part of
the always-on main process. The desktop app starts an image-processing utility process only when
thumbnail or inbox image metadata work is requested. That worker owns the lazy `sharp` / `libvips`
load, returns the generated metadata or thumbnail bytes over IPC, and shuts down after it has been
idle.

The bridge to that worker is bounded. At most four requests are in flight at once; anything beyond
that waits in a queue in the main process and is dispatched as earlier results come back. Only
dispatched requests carry the 60-second request timeout, so a large import cannot time out while it
is merely waiting its turn. The wait queue itself is capped at 256 requests — past that, new image
work is rejected with a "busy" error rather than growing the queue, which callers surface as a
missing thumbnail or basic file metadata. Every request is settled exactly once, including when the
worker crashes or is stopped.

## CRDT Store Preflight

The Yjs store (`leveldb/`) is opened through `classic-level`, a native binding that can abort the
whole process instead of throwing — no JS error, nothing to catch. So it is exercised in a disposable
child process first (`crdt-preflight.ts`), against the real store directory, and only loaded in main
if that child survives. A store whose on-disk state aborts the binding (a torn LDB or MANIFEST from a
past crash) is quarantined to `leveldb.broken-<timestamp>` and re-probed once on a fresh directory: if
that passes, the data was the problem and the fresh store is kept; if it fails too, the binding is the
problem and the original is moved back.

When neither works, the CRDT layer runs **in memory**. Notes still load from vault markdown and still
write back to disk — markdown remains the source of truth — but merge history is not persisted across
launches. The log line is:

```
CRDT persistence unavailable — continuing in-memory (notes still load from vault files)
```

The child is forked twice on failure. The first attempt is an Electron `utilityProcess`; on some
Windows installs that dies during Chromium/crashpad startup before any of our code runs, which says
nothing about the store, so it is retried as a plain node child (`ELECTRON_RUN_AS_NODE`) that boots no
Chromium at all. Which transport produced the verdict matters when reading telemetry: a failure
reported with `transport: node` means the Chromium-free fallback failed too, so the binding is broken
on that machine rather than the utility process merely failing to start.

Because the preflight child is _expected_ to die in the recovered case, its `child-process-gone` report
(`Utility:crashed:CrdtPreflight`) does not indicate breakage. The event that does is
`app_error_seen` with `errorCode: CRDT_PERSISTENCE_UNAVAILABLE:<stage>`, emitted only when the store
genuinely could not be opened.

## better-sqlite3 ABI Quirk

The native module must match the JS runtime. If you see `ERR_DLOPEN_FAILED`, rebuild for the right target:

- **Node tests**: `pnpm rebuild better-sqlite3`
- **Electron app / E2E**: `bash apps/desktop/scripts/ensure-native.sh electron`

Using the Node fix for Electron leaves vault open silently failing — the app falls through to the welcome screen.
