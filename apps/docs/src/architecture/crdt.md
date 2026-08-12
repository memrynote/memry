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

## Persistence Resilience

The classic-level native binding is first exercised in a **disposable
utilityProcess** (`crdt-preflight-child.ts`) against the **real store
directory**: a binding that hard-aborts (unsupported CPU instructions, AV
interference) — or a store whose on-disk state (torn LDB/MANIFEST from a past
crash or full disk) aborts the binding — kills that child, not the app, and
the main process then never loads the binding at all.

The child reports how far it got by writing **stage markers** to stderr
(`crdt-preflight-protocol.ts`), because the exit code alone cannot tell a bad
store from a machine that cannot start a child at all:

- `bootstrap` — the child never reached JS. Observed on Windows, where the
  utility process dies in Chromium/crashpad init with exit `0xFFFF7003`. The
  same probe is then retried as a plain node child
  (`ELECTRON_RUN_AS_NODE`), which starts no Chromium and no crash handler.
- `binding` — the child ran but the native binding failed to load. The store
  was never opened.
- `store` — the binding loaded and the probe died using it.

Only a `store` verdict implicates the store. When it fails and a store
exists, the store is **quarantined** (renamed to
`crdt-store.broken-<timestamp>`) and the preflight retried once against a
fresh directory: a pass means the data was at fault, so the app continues
with a fresh store; a second failure means the binding itself is broken, so
the original store is restored for a future launch and the provider goes
in-memory. Restoring first clears the partial fresh store the failed re-probe
left behind (renaming onto an existing directory is `EPERM` on Windows), and
falls back to retries and then copy+delete if the directory is still locked.
Only after the child survives is the y-leveldb store probed
in-process (a write/read/clear round-trip with a timeout) before it is
trusted. A broken `classic-level` native binding doesn't
fail cleanly — it throws outside the promise chain or hangs its callbacks — so
the probe captures both. If the probe fails, the provider degrades to
**in-memory mode**: notes still load from vault markdown and write back to
disk, and the editor keeps working; only CRDT history persistence across
restarts is lost for that session. A mid-session load failure for a single doc
falls back to seeding from the vault file instead of blocking the note from
opening.

## Why the Main Process Owns Y.Docs

- Single writer per document avoids merge complexity across renderer windows.
- Persistence via y-leveldb is a Node-side concern.
- Main can broadcast updates to multiple renderer windows (when split view exists).

## Renderer Update Delivery

Main broadcasts every CRDT update on one channel (`crdt:state-changed`), scoped to the
windows attached to that doc. Inside a window, the preload layer keeps a
`noteId → subscribers` registry behind a single channel listener, so an update is
dispatched only to the provider that owns the note. Opening ten notes still installs one
Electron listener, and a keystroke in one note does not wake the other nine providers.

Each provider subscribes with its own `noteId` before it opens the doc, so no broadcast
can land in the gap between opening a note and being wired to it. Unsubscribing the last
provider for a note drops its entry, and the channel listener is released once nothing is
listening — note close, window reload, and vault switch all take that path.

## Open Doc Lifecycle

Main keeps a Y.Doc open while an editor window is attached to it. Sync pulls may also
open a Y.Doc without a window so remote updates can be applied, but those sync-only
docs are closed again after the pull if they are still inactive.

Inactive docs are capped with least-recently-used eviction. The eviction path only
targets docs with zero attached windows, so active editor docs are never evicted. The
provider metrics expose the open doc count, encoded size, and per-doc `windowCount`
so memory growth can be observed without inspecting private provider state.

Because "attached window" is what makes a doc safe from eviction, every IPC entry point
that can open a doc attributes it to the sender window — `crdt:open-doc` and the
`crdt:sync-step-1` handshake alike. The handshake matters because it can be the call that
creates the doc: `crdt:open-doc` may have been skipped or failed, or a provider reset
during a vault switch may have dropped the entry in between. A doc opened without a window
would count as inactive while an editor was typing into it, and an update that arrives
after its entry is gone is dropped rather than applied.

Attribution is released on every path that ends a window's interest in a doc, so it never
pins a doc for the rest of the session: the renderer's `crdt:close-doc` on unmount, a
`closed` hook per window for ⌘W and renderer crashes, a broadcast-time backstop for any
window that turns out to be gone, and provider teardown on vault close or switch. Once
released, the doc is evictable and compactable again.

Closing is asynchronous — it flushes the doc to persistence first — so a note can be
reopened while its own close is still in flight. The reopen builds a fresh Y.Doc and takes
over the provider's entry for that note, and the close then finds that the entry no longer
belongs to it. It leaves that entry alone, because the reopened doc is the one the editor
is typing into, and destroys only the doc it superseded. Nothing can reach the superseded
doc at that point: every route into a Y.Doc looks the note id up in the provider's map,
which now resolves the replacement.

## IPC Loop Prevention

Three pieces of metadata prevent feedback loops:

1. **`sourceWindowId`** on every IPC update.
2. **Y.Doc origin parameter** distinguishes local typing, IPC re-application, and network apply.
3. **Update buffering** in `CrdtUpdateQueue` orders updates per `noteId`.

## Markdown Write-Back

Every local or remote Y.Doc update schedules a write-back that re-serializes the whole
document to its vault `.md` file and re-indexes it for search.

- **Debounce** — 500 ms after the last update, re-armed per update, so a fast typing run
  produces one write-back at the end rather than one per keystroke.
- **Cost-proportional cooldown** — a pass re-serializes the entire document, so it costs
  what the note is big rather than what the edit was. After a pass finishes, the next one
  waits until the note has been idle for nine times what that pass cost, capped at 5 s.
  Small notes never reach the 500 ms debounce floor and are unaffected; large notes settle
  at roughly a tenth of wall clock instead of saturating a core while the user types.
- **Nothing is deferred indefinitely** — the trailing pass always runs, and
  `flushPendingWritebacks()` forces any pending pass through before the CRDT provider is
  destroyed, which covers app quit and vault switch.
- **Per-vault bookkeeping** — write-back tracks self-written files and recent inbound
  network updates in short-TTL maps. Entries are evicted in an amortized pass (at most one
  sweep per TTL window) rather than scanned on every watcher event, and
  `CrdtProvider.destroy()` clears the maps outright, so no vault's note ids or file paths
  survive into the next one.

While a write-back is queued or mid-write the `.md` file is knowingly behind the Y.Doc, so
markdown-as-truth readers (task checkbox reconciliation) stand down for that window. Search
results and the file on disk catch up when the pass runs.

## Hybrid Sync Model

Notes flow through **both** sync paths:

- **Snapshot** — periodic full encrypted state, via the `SyncItemHandler` pipeline. Used for new devices, big diffs, and recovery.
- **Incremental** — small Yjs binary updates via `/sync/crdt/updates`. Used for live collaboration during a session.

Snapshots are pushed **pre-batch** so other devices receive correct state before the sync notification reaches them.

## Reconnect Recovery

A note body only ever travels as a CRDT update, so a remote body edit reaches a device
as a `crdt_updated` WebSocket broadcast — record changes in the pull feed carry no body.
Anything broadcast while the socket was down therefore has to be re-discovered when it
comes back.

When the socket reconnects, the engine pulls the record feed, then re-pulls the CRDT for
every note that still has an editor window attached. The rest of the LRU-cached docs —
the ones the provider retains after their editors closed — are swept too, but at most
once per five minutes, because each pull costs a snapshot fetch, paged incrementals, and
a vault-key derivation, and reconnect backoff caps at 30 seconds. A sweep suppressed by
that window is not dropped: it is paid by the next reconnect or by the 60-second pull
tick, and the vault-wide sweep at the end of a full sync covers every note regardless.

## Snapshot Failure Handling

A snapshot is a **compaction optimization**, not the source of truth: the authoritative
server-side state is the `crdt_updates` log. A failed snapshot is therefore recoverable,
and the write path is ordered so it stays that way.

- **R2 put before D1 upsert.** A failed put writes no metadata row, so there is never a
  row pointing at an object that does not exist.
- **Prune only after a successful store.** `pruneUpdatesBeforeSnapshot` runs only once
  the snapshot is durable, so a failed snapshot never deletes the update log behind it.
- **Transient puts are retried.** The R2 key is deterministic
  (`<userId>/vaults/<vaultId>/crdt/<noteId>/snapshot`), so a retry overwrites the same
  object and is idempotent. `putBlob` retries a transient failure twice with a short
  bounded backoff; quota and permission rejections are terminal and are not retried.
- **Failures are typed.** CRDT blob access goes through `putBlob`/`getBlob`, which
  classify R2 failures into `AppError`s (`STORAGE_UPLOAD_FAILED`, and so on). A raw
  storage error would otherwise reach the error handler as `UNHANDLED_ERROR` and make
  a transient provider incident look like an application crash in telemetry.
- **Quota refunds never mask the cause.** A reservation refund is itself a D1 write and
  can fail during a D1 incident. The refund is isolated so the original error always
  propagates; a failed refund is logged and leaves the reservation charged until it is
  reconciled.

The client mirrors this. CRDT pulls run in a **serial loop over notes**, so they do not
retry `429`s inline — honouring `Retry-After` per note would stall the whole pass, and the
sync cadence is the retry instead. A single note that fails its snapshot baseline is
skipped and retried on the next pass rather than abandoning the remaining notes.

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

## Files Worth Knowing

```
apps/desktop/src/main/sync/
├─ crdt-update-queue.ts
└─ engine.ts                # ordering: pull → seed → per-batch push

apps/desktop/src/renderer/src/sync/
├─ yjs-ipc-provider.ts      # renderer-side Y.Doc proxy
└─ use-yjs-collaboration.ts # editor hook
```
