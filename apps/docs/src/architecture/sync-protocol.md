# Sync Protocol

Encrypted payloads move between devices through a Cloudflare Workers API backed by D1 and R2.

## Storage Split

- **D1**: sync item metadata (id, type, vector clock, blob key, size, content hash)
- **R2**: encrypted payload blobs (avoids the 1 MB D1 row limit)

## Sync Items

Each domain object syncs as a `sync_item`: an opaque encrypted blob with a doc-level vector clock.

## Vector Clocks (Doc-Level)

Used by the server to order changes from each device. The server never sees field contents.

## Field-Level Merge (Tasks & Projects)

Inside the encrypted blob, tasks and projects carry per-field vector clocks (`field_clocks`). Concurrent edits to non-overlapping fields merge without conflict; same-field edits resolve last-writer-wins by tick-sum.

## Cursors

`server_cursor_sequence` tracks per-device pull progress.

## Tombstones

Deletions include `deleted_at` inside the Ed25519-signed payload to prevent server-forged deletions.

## Endpoints

- `POST /sync/push` — upload new sync items
- `POST /sync/pull` — fetch updates since cursor
- `POST /sync/crdt/updates` — incremental Yjs updates
- Auth, device, and key endpoints surrounding the above
