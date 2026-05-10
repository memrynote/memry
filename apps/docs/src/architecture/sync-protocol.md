# Sync Protocol

Encrypted payloads move between devices through a Cloudflare Workers API backed by D1 and R2.

## Storage Split

| Storage | Holds                                                                                |
| ------- | ------------------------------------------------------------------------------------ |
| **D1**  | Sync item metadata: id, type, vector clock, blob key, size, content hash, timestamps |
| **R2**  | Encrypted payload blobs (avoids the 1 MB D1 row limit)                               |

Splitting metadata from blob saves cost and lets the server reason about ordering without ever touching ciphertext.

## Sync Items

Every domain object syncs as a `sync_item`. The server sees:

```ts
{
  id: string
  user_id: string
  device_id: string         // last writer
  type: 'note' | 'task' | 'agent_conversation' | 'agent_message' | ...
  vector_clock: VectorClock // doc-level
  blob_key: string          // R2 path
  size_bytes: number
  content_hash: string
  created_at: timestamp
  updated_at: timestamp
  deleted_at: timestamp | null
  signature: bytes          // Ed25519 over the metadata + blob hash
  crypto_version: int
}
```

The blob is the encrypted body. The server can reason about order, dedupe, and authorize writes — but the contents stay opaque.

## Vector Clocks (Doc-Level)

Used by the server to order changes across devices. The server itself never inspects fields — it sees a single clock per document and uses it to pick the correct write on conflict.

## Field-Level Merge (Tasks & Projects)

Inside the encrypted blob, tasks, projects, and agent conversations carry per-field vector clocks
(`field_clocks`).

- Concurrent edits to **non-overlapping** fields merge cleanly.
- Concurrent edits to **the same field** resolve last-writer-wins by the sum of device ticks (`tickSum`). Ties favor the remote write (deterministic).

See `apps/desktop/src/main/sync/field-merge.ts` for the merge implementation.
`TASK_SYNCABLE_FIELDS` is 15 fields; `PROJECT_SYNCABLE_FIELDS` is 8; agent conversations merge
`title`, `backend`, `trustList`, and `pinned`.

## Agent Chat Items

Agent chat adds two encrypted record sync item types:

| Type                 | Merge behavior                                                     |
| -------------------- | ------------------------------------------------------------------ |
| `agent_conversation` | Field-level merge for title, backend, trust list, and pinned state |
| `agent_message`      | Append-only by message id; duplicate ids are idempotent            |

Conversation titles, message bodies, and attachments are stored as purpose-bound encrypted JSON
envelopes before sync encoding. Streaming messages are not eligible for sync until they reach a
terminal status.

## Cursors

`server_cursor_sequence` tracks per-device pull progress. Pull is incremental: fetch everything strictly after the cursor, advance, repeat.

## Tombstones

Deletions include `deleted_at` inside the **Ed25519-signed** payload — preventing a hostile server from forging deletions.

## Endpoints

| Path                      | Direction | Purpose                                      |
| ------------------------- | --------- | -------------------------------------------- |
| `POST /sync/push`         | up        | Upload new sync items (metadata + blob refs) |
| `POST /sync/pull`         | down      | Fetch updates since cursor                   |
| `POST /sync/crdt/updates` | both      | Incremental Yjs binary updates               |
| `POST /auth/*`            | mixed     | OTP, sign-in, refresh, sign-out              |
| `POST /devices/*`         | mixed     | Linking, listing, revoking                   |
| `POST /keys/*`            | mixed     | Key sealing during link, rotation            |

## Error Modes

| Failure            | Behavior                                                   |
| ------------------ | ---------------------------------------------------------- |
| Offline            | Outbox queues; retry with backoff                          |
| Auth expired       | Refresh token; if rotation failed, prompt sign-in          |
| Quota exceeded     | Surfaces in [Settings → Vault](/user-guide/settings#vault) |
| Server unavailable | Exponential backoff; status indicator turns yellow         |
| Blob hash mismatch | Reject the item; log; alert health view                    |

## Encryption Stays End-to-End

The server never sees plaintext. See [Cryptography](/architecture/cryptography) for the key hierarchy.
