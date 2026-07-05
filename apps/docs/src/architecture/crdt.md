# CRDT & Notes Sync

Notes and journal entries use Yjs CRDTs so concurrent edits across devices merge cleanly.

## Source of Truth

The Y.Doc is canonical. Markdown is a derived, lossy export — useful for `.md` interop but not authoritative.

## Where Y.Docs Live

The **main process** owns Y.Doc instances, persists them to disk via y-leveldb (`<vault>/leveldb/`), and exposes them to the renderer through an IPC provider.

```
renderer  ──Yjs IPC provider──▶  main (Y.Doc)  ──y-leveldb──▶  disk
                                       │
                                       └──network sync──▶  /sync/crdt/updates
```

## Why the Main Process Owns Y.Docs

- Single writer per document avoids merge complexity across renderer windows.
- Persistence via y-leveldb is a Node-side concern.
- Main can broadcast updates to multiple renderer windows (when split view exists).

## Open Doc Lifecycle

Main keeps a Y.Doc open while an editor window is attached to it. Sync pulls may also
open a Y.Doc without a window so remote updates can be applied, but those sync-only
docs are closed again after the pull if they are still inactive.

Inactive docs are capped with least-recently-used eviction. The eviction path only
targets docs with zero attached windows, so active editor docs are never evicted. The
provider metrics expose the open doc count, encoded size, and per-doc `windowCount`
so memory growth can be observed without inspecting private provider state.

## IPC Loop Prevention

Three pieces of metadata prevent feedback loops:

1. **`sourceWindowId`** on every IPC update.
2. **Y.Doc origin parameter** distinguishes local typing, IPC re-application, and network apply.
3. **Update buffering** in `CrdtUpdateQueue` orders updates per `noteId`.

## Hybrid Sync Model

Notes flow through **both** sync paths:

- **Snapshot** — periodic full encrypted state, via the `SyncItemHandler` pipeline. Used for new devices, big diffs, and recovery.
- **Incremental** — small Yjs binary updates via `/sync/crdt/updates`. Used for live collaboration during a session.

Snapshots are pushed **pre-batch** so other devices receive correct state before the sync notification reaches them.

## Sign-Out / Sign-In Ordering

A sign out → sign in cycle has a sharp ordering rule:

```
engine.start()       # pull from server FIRST
  └─ seedExistingCrdtDocs()   # fire-and-forget; only fills truly orphaned notes
```

Reversing this order causes split-brain: stale markdown seeds Y.Docs with new client IDs, server pull then sees non-trivial state vectors and skips bootstrap, and the device diverges.

## CrdtUpdateQueue

A separate queue from `SyncQueueManager`:

- Handles binary `Uint8Array` updates
- Respects sequence ordering per `noteId`
- Buffers updates when the network is paused

## BlockNote Compatibility

BlockNote uses Yjs natively. The renderer's BlockNote editor binds to the renderer-side Y.Doc proxy provided by the IPC provider; edits flow through main and back to disk.

Markdown cannot represent arbitrary nested BlockNote paragraphs. Note markdown export and CRDT writeback preserve those unsupported child blocks with hidden nesting markers, then restore them when a note reloads. Inbox note reload also reads BlockNote's saved `data-nesting-level` HTML metadata so captured note indentation round-trips through the editor.
Marker parsing trims imported markdown with a linear scan so malformed or very large note bodies cannot trigger regex backtracking during reload.

## Foreign Obsidian Syntax

Obsidian block constructs that BlockNote cannot represent — `%%block comments%%`, `$$math$$` blocks, footnote definitions, custom checkbox states like `- [-]`, and callouts outside the four Memry types (or with titles, fold markers, nesting, or multi-paragraph bodies) — are split out before parsing and carried as opaque `rawMarkdown` blocks (`packages/shared/src/foreign-syntax.ts`). Both conversion pipelines (renderer `markdown-utils.ts` and main `blocknote-converter.ts`) re-emit the block's source verbatim on save, so an edited vault note never mangles syntax the editor doesn't understand. The block renders read-only in the editor.

Inline Obsidian syntax (`%%…%%` comments, `==highlights==`, `$math$`, footnote references, `![[embeds]]`, wiki-link anchors, Dataview fields, template vars, block IDs) survives the parse→serialize round trip as plain text without special handling; the `foreign-syntax-roundtrip` test matrices in both pipelines guard this byte-for-byte.

## Files Worth Knowing

```
apps/desktop/src/main/sync/
├─ crdt-update-queue.ts
└─ engine.ts                # ordering: pull → seed → per-batch push

apps/desktop/src/renderer/src/sync/
├─ yjs-ipc-provider.ts      # renderer-side Y.Doc proxy
└─ use-yjs-collaboration.ts # editor hook
```
