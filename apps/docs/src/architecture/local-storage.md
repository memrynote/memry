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
  `await flushProjectionEvents()`, which drains every lane.

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

### Text colors in markdown

Editor colors persist in two Obsidian-compatible forms:

- **Block-level colors** (drag-handle menu) serialize as an HTML comment marker line before the block: `<!-- colors:{"textColor":"red"} -->` (`packages/shared/src/block-colors.ts`).
- **Inline colors** (formatting toolbar on selected text) serialize as raw HTML spans — `<span style="color:red">…</span>` / `background-color` — which Obsidian renders natively (`packages/shared/src/inline-colors.ts`). Because BlockNote's markdown pipeline drops both literal spans and inline color styles, both serializers route colored runs through markdown-inert tokens: wrapped before `blocksToMarkdownLossy` and swapped for span HTML after; masked before `tryParseMarkdownToBlocks` and re-applied as styles after. Spans inside fenced or inline code are left untouched. Files without markers or spans parse unchanged, and older app versions reading span-bearing files keep the text and lose only the color.

The pipeline is wired into both duplicated serializers: the renderer save path (`markdown-utils.ts`) and the main/CRDT path (`blocknote-converter.ts`).

## Concurrency

better-sqlite3 is synchronous and single-process. The main process is the only writer. The renderer never touches SQLite directly — all reads and writes go through IPC.

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

## better-sqlite3 ABI Quirk

The native module must match the JS runtime. If you see `ERR_DLOPEN_FAILED`, rebuild for the right target:

- **Node tests**: `pnpm rebuild better-sqlite3`
- **Electron app / E2E**: `bash apps/desktop/scripts/ensure-native.sh electron`

Using the Node fix for Electron leaves vault open silently failing — the app falls through to the welcome screen.
