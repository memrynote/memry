# Sync Protocol

Encrypted payloads move between devices through a Cloudflare Workers API backed by D1 and R2.

## Storage Split

| Storage | Holds                                                                                |
| ------- | ------------------------------------------------------------------------------------ |
| **D1**  | Sync item metadata: id, type, vector clock, blob key, size, content hash, timestamps |
| **R2**  | Encrypted payload blobs (avoids the 1 MB D1 row limit)                               |

Splitting metadata from blob saves cost and lets the server reason about ordering without ever touching ciphertext.

## Entitlement Gate

Every `/sync/*` route is authenticated and paid-gated before record, CRDT, WebSocket, or blob
logic runs. Paddle webhooks write the active `sync_entitlements` row for the user, and the server
copies the plan limits into quota enforcement:

| Plan     | Storage limit | Vault limit | File limit | Version history |
| -------- | ------------- | ----------- | ---------- | --------------- |
| Plus     | 1 GB          | 1           | 5 MB       | 30 days         |
| Pro      | 10 GB         | 10          | 200 MB     | 365 days        |
| Believer | 50 GB         | Unlimited   | 200 MB     | 365 days        |

Inactive, past-due, paused, canceled, or expired entitlements return `SYNC_PAYMENT_REQUIRED` before
sync data is read or written. Vault and file-size limits return `SYNC_VAULT_LIMIT_EXCEEDED` and
`STORAGE_FILE_TOO_LARGE`.

The desktop client mirrors this gate locally to avoid pointless round-trips that can only return 402. Handlers for paid-only endpoints check the cached entitlement first and return their empty
value (`GET_STATUS` → `local_only`, `GET_STORAGE_BREAKDOWN` → `null`) when the cache says the user
is on the free plan. Only a **known-unpaid** entitlement is gated — an unknown/uncached
entitlement (fresh install, before the first status call) still calls the server, so the gate can
never lock a paying user out on stale local state. The server-side gate remains authoritative.

Development sync servers can seed a `dev_seed` Believer entitlement for configured local admin
accounts during sign-in, billing checks, reconcile, and paid-sync middleware access. This path is
guarded by `ENVIRONMENT=development`; production and staging rely on Paddle webhooks, explicit
admin overrides, or billing reconcile only.

Desktop checkout is account-owned. The app requests `/auth/checkout-token`, opens
`memrynote.com/pricing` with the token in the URL fragment, and the landing page passes that token
to the Paddle checkout transaction API. After payment, Paddle webhooks are the primary entitlement
writer. Desktop can also call `/auth/billing/reconcile` with the returned transaction id; the server
fetches the Paddle transaction, verifies the embedded memrynote user id, and provisions the
entitlement only for completed transactions.

Billing status and customer management stay on authenticated account routes:

| Path                                | Purpose                                                         |
| ----------------------------------- | --------------------------------------------------------------- |
| `GET /auth/billing`                 | Return current plan, status, limits, usage, expiry, portal flag |
| `POST /auth/billing/reconcile`      | Reconcile an optional Paddle transaction id into entitlement    |
| `POST /auth/billing/portal-session` | Create a temporary Paddle customer portal URL                   |

Portal URLs are temporary authenticated links from Paddle and are never cached. Refund and
chargeback automation is intentionally out of scope; support handles those from email and the Paddle
dashboard.

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
`title`, `backend`, `backendModel`, `trustList`, and `pinned`.

## Agent Chat Items

Agent chat adds two encrypted record sync item types:

| Type                 | Merge behavior                                                                    |
| -------------------- | --------------------------------------------------------------------------------- |
| `agent_conversation` | Field-level merge for title, backend, backend model, trust list, and pinned state |
| `agent_message`      | Append-only by message id; duplicate ids are idempotent                           |

Conversation titles, message bodies, and attachments are stored as purpose-bound encrypted JSON
envelopes before sync encoding. Streaming messages are not eligible for sync until they reach a
terminal status.

## Cursors

`server_cursor_sequence` tracks per-device pull progress. Pull is incremental: fetch everything strictly after the cursor, advance, repeat.

## Manifest Integrity

Desktop periodically compares `/sync/manifest` with local syncable records. Notes and journals are
matched from canonical `note_metadata` first, with the rebuildable index cache as a fallback, so a
freshly pushed note is not treated as server-only while indexing catches up.

## Tombstones

Deletions include `deleted_at` inside the **Ed25519-signed** payload — preventing a hostile server from forging deletions.

## Account Vault Directory

An account can hold several vaults (subject to the plan's vault limit). The directory lets any
signed-in device see every vault on the account and pull one it does not have locally yet.

Each vault registers itself in the `sync_vaults` table, keyed `UNIQUE (user_id, vault_id)`. The
server stores only the ciphertext of the vault's display name:

| Column                         | Holds                                                     |
| ------------------------------ | --------------------------------------------------------- |
| `vault_id`                     | The vault UUID that scopes all sync data for the vault    |
| `encrypted_name`, `name_nonce` | XChaCha20-Poly1305 ciphertext of the display name + nonce |

Names are encrypted client-side by `encryptVaultName` (AAD bound to the vault UUID) and decrypted
locally; the server never sees a plaintext vault name. Registration is authenticated but does not
require the vault to have synced any items, so a freshly created vault still appears in the directory.

Desktop reads the directory over IPC:

| IPC method                                     | Purpose                                                                                              |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `vault.listAccount()`                          | Returns `AccountVaultInfo[]` (uuid, decrypted name, item count, local path, suggested download path) |
| `vault.downloadRemote(vaultUuid, parentPath?)` | Clone a cloud-only vault into a local folder and open it                                             |

The renderer surfaces this as an in-account switcher section plus a download dialog where the user
picks the destination folder. A name that fails to decrypt is shown as `null` rather than blocking the
list.

## Endpoints

| Path                      | Direction | Purpose                                      |
| ------------------------- | --------- | -------------------------------------------- |
| `POST /sync/push`         | up        | Upload new sync items (metadata + blob refs) |
| `POST /sync/pull`         | down      | Fetch updates since cursor                   |
| `POST /sync/crdt/updates` | both      | Incremental Yjs binary updates               |
| `GET /sync/vaults`        | down      | List the account's registered vaults         |
| `POST /sync/vaults`       | up        | Register or update a vault's encrypted name  |
| `POST /auth/*`            | mixed     | OTP, sign-in, refresh, sign-out              |
| `POST /devices/*`         | mixed     | Linking, listing, revoking                   |
| `POST /keys/*`            | mixed     | Key sealing during link, rotation            |

## Error Modes

| Failure            | Behavior                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------ |
| Offline            | Outbox queues; retry with backoff                                                          |
| Auth expired (401) | Refresh the access token and retry the request once; only a failed refresh prompts sign-in |
| Payment required   | Sync stays local-only until a paid plan is active                                          |
| Quota exceeded     | Surfaces in [Settings → Vault](/user-guide/settings#vault)                                 |
| Server unavailable | Exponential backoff; status indicator turns yellow                                         |
| Blob hash mismatch | Reject the item; log; alert health view                                                    |

## Encryption Stays End-to-End

The server never sees plaintext. See [Cryptography](/architecture/cryptography) for the key hierarchy.
