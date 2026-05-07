# CRDT & Notes Sync

Notes and journal entries use Yjs CRDTs so concurrent edits merge cleanly across devices.

## Source of Truth

The Y.Doc is canonical. Markdown export is a derived, lossy representation.

## Where Y.Docs Live

The main process owns Y.Doc instances and persists them via y-leveldb. The renderer talks to them through an IPC provider (`yjs-ipc-provider.ts`).

## IPC Loop Prevention

- Updates are tagged with `sourceWindowId`.
- Local, IPC-originated, and network updates are distinguished by Y.Doc origin parameters.

## Hybrid Sync

- Bulk state moves through the SyncItemHandler pipeline (encrypted snapshots).
- Incremental updates flow through `/sync/crdt/updates` with binary `Uint8Array` payloads.
- A dedicated `CrdtUpdateQueue` orders updates per `noteId` and respects sequence ordering.

## Sign-Out / Sign-In

Pull from the server first; only then run `seedExistingCrdtDocs` (fire-and-forget) to fill gaps for orphaned notes. CRDT snapshots are pushed pre-batch so other devices receive correct state.
