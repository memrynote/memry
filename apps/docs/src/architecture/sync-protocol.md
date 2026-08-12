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

### Blob key layout

Item ids are human-readable and may repeat across types: the default project id is `inbox`, a
`tag_definition` id is the lowercased tag name, and a `folder_config` id is the folder path. R2 keys
for sync-item payloads therefore include the item type, and since `items-v3` also the payload's
content hash — new pushes write to `<user>/vaults/<vault>/items-v3/<type>/<id>/<content-hash>`, so a
project and a tag both named `inbox` own separate objects, and every push writes its own immutable
object instead of mutating a shared per-item one. Content-addressing is what makes concurrent pushes
of the same item safe: with a shared mutable key, two devices racing on one id (external calendar
events have deterministic ids, so every device pushes the same ids) could interleave blob and row
writes such that the surviving row carried one push's signature over the other push's bytes — the
item then failed Ed25519 verification on every pull until re-pushed. After a replacing push commits
its row, the previous version's object is deleted best-effort; a delete that loses a race merely
leaks a bounded orphan object. Rows written before these layouts keep their legacy `items/<id>` or
`items-v2/<type>/<id>` keys; every read path resolves the `blob_key` stored on the row rather than
re-deriving it, so old rows continue to work without a migration. (The untyped layout let same-id
items of different types overwrite one shared object, which permanently broke the losing row's
signature.) A pull that finds a row whose object is missing skips that row instead of failing the
page: a replaced item re-arrives at a later cursor, and a dangling row must not wedge every puller
behind one broken item.

### Per-item bookkeeping and retry semantics

Because ids repeat across item types, every piece of client-side per-item bookkeeping — the
signature-failure quarantine, the corrupt-item re-fetch tracker, the within-run apply dedup, and the
manifest diff — keys on the `(type, id)` pair, never the bare id. A permanent quarantine on one type
does not block its same-id sibling of another type, and a re-fetch that asks for one `(type, id)`
pair ignores the sibling rows the server returns for the same id.

Retry semantics: the pull cursor only advances past pages that were actually applied. A page the
client refused (all items failed crypto, or the key was mid-transition during sign-in/recovery) does
not move the cursor, so a manual Retry lands on the same page instead of skipping it and reporting a
clean sync. Persisted quarantine entries expire after 7 days — if the underlying server row is still
broken the item re-quarantines within a few pulls, and if it was repaired server-side the item flows
again without an emergency wipe. The manifest-check throttle (30 minutes) persists in sync state, so
engine restarts and vault switches cannot re-arm an immediate check.

### Push acknowledgements and in-flight mutations

The push queue coalesces: a new mutation for an item that already has an unattempted row overwrites
that row's payload instead of inserting a second one, and dequeue is a plain read that leaves no
in-flight marker. A row handed to a push therefore stays a valid coalesce target for the whole
flight — worker encryption, the round trip, and every retry — and the user can rename or re-tag the
item at any point in that window.

An acknowledgement is consequently conditional: the push remembers the payload each row held when it
was dequeued and only deletes rows that still match. A row that changed under the push is left
queued and goes out on the next iteration. Deleting unconditionally would drop the newer mutation
permanently, because the local clock advances at mutation time: the item would sit ahead of the
server with nothing queued, and every later pull would resolve `skip` rather than repair it.

Enqueue-time coalescing only folds into a row that has **not** been attempted yet, so a failed or
rejected push leaves the next edit to open a second row for the same `(type, itemId)`. Both rows can
then land in one batch, and the push collapses them again before encrypting. That batch-level
collapse keeps the **newest** row: the batch arrives oldest-first, and the older row's payload is by
definition the stale one. Keeping the newest row also keeps the row that is still unattempted, which
is the row a concurrent local edit would coalesce into — so the conditional acknowledgement above
continues to guard it.

The superseded row's operation is folded into the retained row with the same precedence enqueue
uses: a later delete wins outright, and an unacked create survives a newer update, because the server
has never seen the item and an update for an unknown id is not an equivalent request.

Collapsing to the newest row matters on its own terms rather than as an optimisation. The pushed
payload is normally rebuilt from local state at push time, but that rebuild hook is optional on the
handler interface and settings does not implement it — settings live in `config.json` and the
preferences cache, not in a sync table there is anything to rebuild from. For any such type the
frozen queue payload is the entire push, so retaining the older row published older state and
discarded the newer edit through the success path, with no error surfaced.

### The per-item attempt budget is spent per sync cycle

A push response can accept some items and reject others. A rejected row keeps its payload and is
charged one attempt; after five it stops being dequeued and no longer counts as pending.

That budget is spent **at most once per push cycle**. One `push()` call loops until the queue drains,
and the loop has no backoff, so a row re-sent inside the same call would consume all five attempts
across a handful of back-to-back requests — turning a few seconds of transient server trouble into a
permanently parked edit that the UI reports as nothing-to-sync. Rows the server rejects are therefore
excluded from the remaining dequeues of that call and picked up again on the next cycle, which is
where the delay between attempts comes from. Other queued rows are unaffected: a rejected row is
skipped, not treated as a barrier, so healthy items behind it still go out in the same cycle.

The exclusion lives only in memory for the duration of the call. It is keyed on row id rather than on
the persisted `lastAttempt` timestamp, so a backwards system-clock jump can never hide a pending
edit. A row that changed while in flight is a different case and is _not_ excluded — that re-send
carries the newer payload and costs no attempt.

Migration 0047 resets `attempts` to 0 for rows that an earlier build had already exhausted, so edits
stranded by the old in-cycle spend are retried again after upgrading. It preserves the row, its
payload, and its recorded error.

### Dead-letter purge and the pause flag are kept off the enqueue path

Rows that exhausted their budget are purged once at least 50 of them are older than
`ERROR_RETENTION_DAYS`. Nothing reads those rows and they can only accumulate at the pace of a
failing push, so the threshold is probed on the first enqueue and every fiftieth after that rather
than on every one — and the probe is a bounded existence check, not a count of the table. A bulk
import therefore no longer scans `sync_queue` once per queued mutation. The purge itself is
unchanged: same threshold, same retention window, same deletion.

Whether sync is paused is asked on every WebSocket message, every enqueue and every pull tick, so
the answer is held in memory. Only the _not paused_ answer is cached. Pause and resume write through
the state manager and flip the cached answer with the row, so they take effect on the next call.
Paused always re-reads, because `sync_state` rows are also removed outside the manager — the
emergency wipe, session teardown and device re-registration all delete them — and a removed
`syncPaused` row can only mean "not paused". A cached `false` can never go stale that way; a cached
`true` could. That extra read costs nothing, because paused is exactly the state in which every
caller stops early.

### Recovering pushes that never landed

Items expose a "the server has this state" stamp (`syncedAt`) that advances on a confirmed push as
well as on an applied pull. Anything modified after its stamp — or never stamped at all — is
re-queued on the next full sync for tasks, projects, notes and journals alike.

Recovery re-sends the item's **stored** clock rather than bumping it. An item that is genuinely in
step is then replay-detected by the server, costs one round trip, and is stamped clean; only an item
that really is ahead of the server changes anything. Scope is limited to items the server already
knows: clock-less rows belong to the initial seed.

Notes and journals share a table but not a sync service, so they are swept separately and each
re-push is handed to the service that owns it. The journal sweep also carries the entry's date, which
its payload builder needs to find the file on disk — recovering a journal without one would fail
before the builder's own error handling and take the rest of the sweep down with it.

Because recovery never advances a clock, a change made while the sync runtime is down has to advance
its own at write time or the re-push would be dismissed as a replay. Records park that tick under a
placeholder device that their sync service rebinds on the way out; notes and journals have no
rebinding step, so their fallback bumps under the current device directly and does nothing when no
device is registered (the same thing the online path does). It also clears the sync stamp, because
metadata-only writes — recording an uploaded attachment or editing a journal's tags, say —
deliberately leave `modifiedAt` alone and would otherwise be invisible to the "modified after its
stamp" test above. A row that never leaves the device, and one with no clock yet, are both left
alone.

### Foreign-key parents and orphan repair

Some rows carry foreign keys — a task references its project and its status — and the data DB
enforces them. Server cursor order is last-update order, not dependency order, so pulled items are
sorted so FK parents apply before their children, and anything that still fails is retried once after
every page has landed.

That covers a parent that simply arrived late. It does not cover a parent that is **gone**, which is
what a cascade delete produces: deleting a project removes its tasks locally through SQLite
`ON DELETE cascade`, and a cascade is invisible to sync unless each child is tombstoned explicitly.
Project deletion therefore pushes a tombstone for every task it cascades away, including completed
and archived ones. Without that, the child rows stay alive on the server, every device re-pulls them,
the FK insert fails, the item is skipped, the next manifest check still sees it server-only, and the
cycle repeats forever.

For installs already holding such orphans, the end of a pull run repairs them. The missing parent is
re-fetched **by id**, which is authoritative in a way the cursor window is not:

- the server still returns the parent → apply it, then the child lands normally.
- the server no longer returns it → the parent is gone everywhere, so the child is a confirmed
  orphan and is tombstoned. That is what the cascade should have pushed originally, and it ends the
  re-pull loop on every device.

Deletion is gated on that second condition alone; a child whose re-apply fails for any other reason
is left untouched and retried on the next cycle. A dangling `status_id` is not an orphan at all — the
FK is `ON DELETE SET NULL`, so the reference is simply cleared rather than failing the apply.

## Sync Type Negotiation

Clients declare the record sync item types they understand via an `X-Memry-Sync-Types` header
(comma-separated), sent on authenticated sync calls alongside the existing `X-Memry-Vault-Id`. The
value is `RECORD_SYNC_ITEM_TYPES` joined with commas. The server (`/sync/changes`, `/sync/manifest`,
`/sync/pull`) binds only the negotiated types into its `item_type IN (...)` SQL filter.

| Header                      | Resolves to                                                                      |
| --------------------------- | -------------------------------------------------------------------------------- |
| Absent                      | The frozen `LEGACY_RECORD_SYNC_ITEM_TYPES` list (15 types)                       |
| Present, nothing recognized | An empty list — serves zero rows                                                 |
| Present, some recognized    | The recognized subset, deduped and intersected with the server's supported types |

No header means the client predates negotiation and never declared anything, so it gets exactly the
frozen legacy list — the property that protects binaries already in users' hands. This list is never
edited when a new sync item type is added; adding to it would hand that type to clients whose parsers
reject it, which is exactly the bug this feature exists to prevent.

A header that is present but names nothing recognized is a different situation and resolves
differently: the client did negotiate, so it must never be handed types it didn't declare. Empty
types short-circuit before any DB query, and `getChanges` returns the incoming cursor unchanged so
nothing advances.

Requested types are deduped and intersected with the server's supported set, bounding the
bind-parameter count against D1's 95-parameter ceiling.

**Why this exists:** the desktop client does not runtime-validate `/sync/changes`, does not filter
item refs by type before pulling, and validates a pull page with a single whole-page `safeParse`. One
unknown item type fails the entire page, the client drops it without throwing, and its cursor still
advances past it — silently losing convergence for every note and task on that page, not just the
unrecognized item. Published binaries cannot be patched, so the server is the only place this can be
fixed.

**Deploy order:** the sync-server change must reach production before any desktop build carrying a
new item type.

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

## Pull Scheduling and Hang Recovery

A periodic tick fires every 60 seconds; WebSocket `changes_available` and `connected` messages
schedule additional pulls in between. The interval is armed before the first full sync, and a
failure in that first sync is logged rather than propagated, so one transient error at startup
cannot leave a session without a pull cycle.

The tick does not always pull. Its pull exists to heal a `changes_available` broadcast that never
arrived, so when the socket has been continuously connected since the previous tick — same
`connectionGeneration`, still `connected` — the request is skipped: the socket pings every 25s and
terminates itself after 31s of silence, so a half-open connection reports disconnected before a
tick would trust it. Any drop between ticks bumps the generation and restores the every-tick pull,
and a reconnect pulls on its own. A 5-minute floor caps the skipping, because a server that stops
broadcasting is indistinguishable from a quiet vault from the client side. The stale-lock watchdog
and the owed CRDT sweep run on every tick regardless.

Network status feeds the same scheduling. Electron exposes no main-process event for `net.online`,
so it is polled — every 5 seconds while offline, every 30 seconds while online, dropping back to
the fast cadence the moment the status goes offline. A returning network is therefore always
detected within ~5 seconds (plus a 2-second debounce), and `powerMonitor` `resume` polls
immediately rather than waiting for a tick; `suspend` applies offline right away, so a machine
waking from sleep is already on the fast cadence.

Three guards keep a wedged sync from lasting until restart. Every sync HTTP request carries a
60-second abort timeout, so a black-holed socket (suspend/resume, NAT teardown) surfaces as a
retryable network error instead of pinning the sync lock forever. If the lock is still held after
15 minutes anyway, a watchdog on the periodic tick force-releases it, aborts the in-flight run,
and lets the next pull proceed. Skipped periodic pulls log `Periodic pull skipped` with the
blocking flags, which is the first thing to look for when a device shows stale data.

## Runtime Emitters and Listener Budgets

Three main-process objects in the sync runtime are `EventEmitter`s: `NetworkMonitor`
(`status-changed`), `WebSocketManager` (`message`, `connected`, `device_revoked`,
`certificate_pin_failed`, `error`) and `SyncEngine`.

Their subscriber counts are small and fixed. `NetworkMonitor` has three
`status-changed` subscribers — the `SyncEngine`, the sync runtime itself and the
attachment `UploadQueue`. `WebSocketManager` has at most one listener per event
name. Nothing in the main process subscribes to `SyncEngine`: its status reaches
the renderer through `emitToRenderer`, not through listeners.

Each one calls `setMaxListeners(10)`, Node's default. That is deliberate: the
ceiling has to stay close enough to the real count that an accumulating-subscriber
bug trips `MaxListenersExceededWarning` instead of hiding behind a generous budget.
`src/main/sync/emitter-budget.test.ts` pins both the budget and the observed
counts, so raising either needs a test change and an explanation.

Every subscriber is detached on teardown: the engine removes its own in `stop()`,
the runtime keeps a reference to its `status-changed` handler so
`stopSyncRuntime()` can remove it, and the attachment `UploadQueue` is disposed
with the runtime that built it (see "Upload queue lifetime" under Note
Attachments). A subscriber left attached does more than leak: it keeps the dead
CRDT queue and provider reachable for the rest of the session.

## Manifest Integrity

Desktop periodically compares `/sync/manifest` with local syncable records. Notes and journals are
matched from canonical `note_metadata` first, with the rebuildable index cache as a fallback, so a
freshly pushed note is not treated as server-only while indexing catches up.

The comparison reads ids only. Repair payloads are built one row at a time, and only for a record
the server manifest is actually missing, so the usual clean check never materializes or serializes a
single row body — the cost of the check scales with the size of the disagreement, not with the size
of the vault. The bytes a repair pushes are unchanged: the lazy build runs the same full-row select
through the same serialization the eager pass used.

## Note Attachments

Files embedded in a note (images, PDFs) live on disk under the vault's
`attachments/<noteId>/` folder and are uploaded to the blob store as encrypted
chunks with a signed, encrypted manifest. Three mechanisms make them portable
across devices:

- **Reference sync** — each note's payload carries `attachmentReferences`, the
  ids of the blobs it embeds. When a device applies a note and is missing a
  referenced file, it downloads the blob into its own
  `attachments/<noteId>/` folder; the filename comes from the decrypted
  manifest (sanitized, skipped when already materialized at the same size).
  Older clients parse payloads in strip mode and ignore the field.
- **Cross-device path remap** — note blocks store the origin machine's
  absolute `memry-file://local/<path>` URL. The protocol handler resolves a
  path that is outside this device's allowed roots by remapping its
  `attachments/<noteId>/<file>` tail onto the local vault (traversal-guarded),
  so notes written on another OS render without rewriting note content.
- **Upload queue lifetime** — the in-memory `UploadQueue` is a module singleton
  owned by the IPC layer, but its lifetime is scoped to the sync _runtime_. It
  binds `getNetworkMonitor()` once, at construction, and only unsubscribes in
  `dispose()`, so a queue reused across a runtime restart (vault switch,
  sign-out/in) would stay attached to the previous monitor. That monitor is
  stopped, which clears its poll timer: its `online` flag is frozen and it can
  never emit `status-changed` again, so the reconnect wake-up that clears the
  network backoff would be dead for the rest of the session — and a frozen
  offline flag makes every retry burn the full five-minute offline wait before
  failing. `resetSyncServiceSingletons()` therefore disposes the queue and the
  attachment service on both teardown paths (`stopSyncRuntime()` and the
  startup-failure cleanup), so the next runtime builds them against the live
  monitor and vault A's queue can never serve vault B. The IPC layer registers
  its disposer through `attachment-outbox`, which is already the seam between
  the sync runtime and this singleton, so no import cycle is introduced.
  Uploads pending at dispose are rejected rather than carried over — the outbox
  below is what makes that safe.
- **Durable upload outbox** — the upload intent is persisted in the data DB
  (`attachment_upload_queue`, migration 0039) before the transfer starts and
  cleared only after the server accepts the file. Failed or quit-interrupted
  uploads are retried on every sync runtime start instead of being lost with
  the in-memory queue. Recording the reference enqueues a note push so peers
  learn the blob exists; if that lands while the runtime is down — an upload
  finishing during quit, a vault switch, re-auth — the note is marked for
  [recovery](#recovering-pushes-that-never-landed) instead, so the push happens
  at the next runtime start rather than waiting for an unrelated later edit.

`attachmentReferences` is the only signal that tells another device a note
embeds a file — the markdown link alone points at a path that exists nowhere
but the authoring machine. It is sync bookkeeping, not file state, so the
canonical note upsert leaves it (and the sync stamp) untouched when a caller
has nothing to say about it. Ordinary vault writes — a content save, a rename,
a move, a re-index — carry file state only, and must not erase it.

## Tombstones

Deletions include `deleted_at` inside the **Ed25519-signed** payload — preventing a hostile server from forging deletions.

A tombstone body carries no user content. The receiving side never decodes it: `ItemApplier`
short-circuits on `operation === 'delete'` and calls `applyDelete(ctx, itemId, clock)`, and
`SyncItemHandler.applyDelete` has no parameter that could accept the body. Handlers resolve
whatever they need from the local row instead — the journal handler, for example, reads the
journalled day from `noteMetadata.journalDate`.

So note and journal tombstones ship `{ clock, createdAt, modifiedAt }` and nothing else: no title,
no journal date. Anything more is encrypted and uploaded on every delete for no reader, and sits in
plaintext in the local `sync_queue` row until the push drains.

`clock` is the one field a tombstone must keep. `PushCoordinator.extractPayloadMetadata` parses it
back out of the payload string to stamp the server-side item version, so dropping it would break
delete ordering across devices.

Payload schemas therefore mark these fields optional (`NoteSyncPayloadSchema.title`,
`JournalSyncPayloadSchema.date`) — a tombstone legitimately omits them. Where a field is still
required for a create or update, the handler enforces it: `journal-handler.applyUpsert` skips an
upsert that arrives with no `date`.

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

Every authenticated sync call — and the WebSocket handshake — stamps the active vault's UUID into
`X-Memry-Vault-Id`. That UUID is a single `vault_metadata` row, so it is resolved once and cached
against the open data-database handle rather than re-read per request. Opening, closing or switching
a vault installs a new handle and therefore misses the cache on its own; the one rewrite that keeps
the same handle — a linked device adopting the initiator's vault identity — invalidates it
explicitly, so device registration and the first sync bind to the adopted vault, never the
pre-adoption one.

Desktop reads the directory over IPC:

| IPC method                                     | Purpose                                                                                              |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `vault.listAccount()`                          | Returns `AccountVaultInfo[]` (uuid, decrypted name, item count, local path, suggested download path) |
| `vault.downloadRemote(vaultUuid, parentPath?)` | Clone a cloud-only vault into a local folder and open it                                             |

The renderer surfaces this as an in-account switcher section plus a download dialog where the user
picks the destination folder. A name that fails to decrypt is shown as `null` rather than blocking the
list.

## Endpoints

| Path                      | Direction | Purpose                                                                        |
| ------------------------- | --------- | ------------------------------------------------------------------------------ |
| `POST /sync/push`         | up        | Upload new sync items (metadata + blob refs)                                   |
| `POST /sync/pull`         | down      | Fetch updates since cursor                                                     |
| `POST /sync/crdt/updates` | both      | Incremental Yjs binary updates                                                 |
| `GET /sync/vaults`        | down      | List the account's registered vaults                                           |
| `POST /sync/vaults`       | up        | Register or update a vault's encrypted name                                    |
| `POST /auth/*`            | mixed     | OTP, sign-in, refresh, sign-out                                                |
| `GET /auth/key-verifier`  | down      | Account key verifier for an established session (vault-key mismatch detection) |
| `POST /devices/*`         | mixed     | Linking, listing, revoking                                                     |
| `POST /keys/*`            | mixed     | Key sealing during link, rotation                                              |

### CRDT update sizing

`POST /sync/crdt/updates` is bounded by two different server limits, and the client
(`src/main/sync/crdt-payload.ts`) plans every batch against both:

- **Per update.** Each update is stored as a BLOB inside a D1 `crdt_updates` row, so an update can
  never exceed D1's 1 MB row limit. The route's own 5 MB check is not the binding one.
- **Per request.** `/sync/*` bodies are capped at 8 MiB, which limits how many updates one POST can
  carry.

A batch that exceeds the request budget is split across several POSTs rather than truncated. A
single update too large for a D1 row cannot use the incremental path at all; the client pushes the
note's full document to `POST /sync/crdt/snapshot` instead, which is R2-backed and therefore not
subject to the row limit. The local Y.Doc already contains those operations, so the snapshot carries
them, and every client version already applies the snapshot as its baseline before pulling
incrementals. If that fallback fails the push rejects, leaving the batch buffered for the next flush
and — on quit — recorded for replay. No path discards an update.

### Server base URL

Every path above is appended to a single resolved base URL. `resolveSyncServerUrl()`
(`src/main/sync/sync-server-url.ts`) is the only resolver — sync HTTP, OAuth sign-in, canvas assets
and attachment transfers all call it, so one env var cannot end up with two policies.

Two properties of that resolver are load-bearing:

- **Resolved per call, never at import time.** The main process applies `.env.<environment>` via
  dotenv in `index.ts` _after_ the IPC handler modules are imported, so a module-level
  `const URL = process.env.SYNC_SERVER_URL || …` freezes to the fallback before the env file lands.
  In `dev` the fallback happens to equal the configured value, which hides the bug; in `dev:staging`
  it silently pinned sync and OAuth to localhost.
- **Trailing slashes are stripped.** Callers build paths as `` `${base}${path}` ``, so a
  slash-terminated `SYNC_SERVER_URL` yields `https://host//sync/push`. Cloudflare Workers routes the
  doubled slash as a different path, so the request 404s instead of reaching its handler. Only
  trailing slashes are normalized — scheme, host, port and any base path are left verbatim so a typo
  still fails loudly rather than being rewritten into something that "works".

`SYNC_SERVER_URL` is required. The `http://localhost:8787` fallback applies only when `NODE_ENV` is
`development` or `test` — the unpackaged dev server and the vitest/Playwright harnesses. A packaged
build has `NODE_ENV` undefined and gets an explicit configuration error rather than a silent dial to
a localhost port nothing is listening on. Packaging cannot legitimately omit the value:
`scripts/build-packaged-app.js` refuses to build without `apps/desktop/.env.production` and asserts
the value is a non-local HTTPS URL.

## Realtime Socket Auth

The change-notification WebSocket (`/sync/ws`) authenticates once at handshake with a Bearer access
token. The server pins that token's expiry to the connection and sweeps every 60s, closing any
socket whose token has expired (`WS_TOKEN_EXPIRED`, close code 4003).

Because access tokens are short-lived, the client renews the connection **in place** rather than
riding each token to expiry. Whenever the token manager refreshes — the same cycle that serves HTTP
requests, and always well before expiry — the client sends the fresh token over the open socket:

| Direction       | Message                                 | Meaning                                       |
| --------------- | --------------------------------------- | --------------------------------------------- |
| client → server | `{ type: 'auth', payload: { token } }`  | Renew this connection with a fresh token      |
| server → client | `{ type: 'auth_ok', payload: { exp } }` | Accepted; the connection now expires at `exp` |

The server verifies the token and requires it to belong to the same device before extending the
expiry. Renewal is best-effort: a rejected or unanswered `auth` leaves the original expiry in place,
so the socket closes at expiry and the client reconnects with a fresh token as it otherwise would.

The renewal hook belongs to the running sync runtime, not to the token manager: the runtime installs
it at start and detaches it at stop. A refresh that lands after a vault switch or sign-out therefore
renews nothing instead of reaching into a torn-down socket and CRDT queue, and the runtime that
replaces it installs its own hook.

### Certificate pinning on the socket

A `wss://` socket connects through a pinned `https.Agent`. One agent is shared for the process
rather than rebuilt per reconnect: the agent holds nothing between connects (`keepAlive` is off, and
the WebSocket upgrade detaches its socket), so a fresh one per reconnect only produced garbage.

Sharing does not freeze the pin. The check lives in the agent's `checkServerIdentity`, which
resolves the connecting hostname's pins from `certificate-pins.ts` on **every** TLS handshake — an
updated pin table applies to the next handshake with no restart and no cache flush. Only the two
decisions made when the agent is constructed are cached with it: whether pinning is disabled
(unpackaged dev/test builds) and whether the configured host still carries placeholder pins. Both
form the cache key, so a change in either destroys the cached agent and builds a new one.

A pin mismatch is terminal for the session: the manager latches `certificate_pin_failed`, stops
reconnecting, and requires an app restart.

## Vault-Key Verification

Before syncing — and whenever an entire pull page fails to decrypt — the client verifies its local
master key against the account's key verifier (local cache first, `GET /auth/key-verifier` as
fallback). A confirmed mismatch stops the pull cycle **without** quarantining items or marking them
corrupt, escalates once into the recovery flow, and signs the install out so sign-in + recovery
phrase can restore the correct key. See
[Vault-Key Mismatch Detection](/architecture/cryptography#vault-key-mismatch-detection).

## Error Modes

| Failure             | Behavior                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------ |
| Offline             | Outbox queues; retry with backoff                                                          |
| Server unreachable  | Machine still has a link, so requests are retried with exponential backoff, not instantly  |
| Auth expired (401)  | Refresh the access token and retry the request once; only a failed refresh prompts sign-in |
| Refresh rejected    | Stop refreshing entirely (see below); prompt the user to sign in again                     |
| Payment required    | Sync stays local-only until a paid plan is active                                          |
| Quota exceeded      | Surfaces in [Settings → Vault](/user-guide/settings#vault)                                 |
| Socket token expiry | In-place renewal over the open socket; a rejected renewal falls back to close + reconnect  |
| Server unavailable  | Exponential backoff; status indicator turns yellow                                         |
| Blob hash mismatch  | Reject the item; log; alert health view                                                    |
| Vault-key mismatch  | Stop pulling without branding items; prompt recovery; sign out to restore the correct key  |

### Rejected Refresh Tokens

A 401 on `/auth/refresh` means the refresh token itself is dead, so no retry can succeed. Because
every part of the app asks for a valid access token on demand — sync passes, websocket reconnects,
CRDT pushes, attachment transfers, calendar sync, billing checks — an unlatched failure would let
each of them re-enter the refresh path forever.

A rejection therefore latches. The first two rejections open a backoff window (1 minute, then 5)
during which no refresh request reaches the network at all; that spacing exists only so a transient
server-side 401 can recover before the session is written off. The third rejection is terminal: the
client stops refreshing for good and prompts the user to sign in again.

Signing out remains an explicit user action. The session is already dead on the server, but local
key material is never cleared on the strength of an HTTP status alone. Signing in again clears the
latch and sync resumes.

## Encryption Stays End-to-End

The server never sees plaintext. See [Cryptography](/architecture/cryptography) for the key hierarchy.

### Crypto worker and main-thread fallback

Push encryption and pull decryption run in a worker thread so a large batch does not block the main
process. The worker is an optimisation, never a dependency: whenever it is unavailable the same
batch is encrypted or decrypted on the main thread instead, and sync continues at reduced speed
rather than failing.

"Unavailable" covers both a worker that never started and a running worker that rejects a request —
a request timeout, the worker crashing or exiting mid-batch, or a message kind the worker build does
not implement, which is what a partially updated install looks like. The batch that was in flight
when any of those happen degrades to the main thread with the rest; it is not lost.

Degrading cannot mask a bad payload. The worker reports per-item crypto outcomes in its reply — a
failed decrypt or a signature mismatch comes back as a per-item failure, not as a rejected batch —
so a rejection only ever means the worker itself was unreachable. The main-thread path then runs the
identical encryption and signature verification over the same inputs, so an item that genuinely
fails crypto still fails; it just fails on the main thread. Push payloads are resolved once and
shared by both paths, so the fallback encrypts exactly what the worker was handed.

A worker that crashes takes itself out of the rotation, because the exit leaves nothing to send to. A
worker that is alive but silent does not: it looks healthy, so every batch would ask it again and
wait out the 60-second request timeout before degrading. The bridge therefore counts consecutive
failed requests and stops offering itself after three, from which point batches go straight to the
main thread with no round trip. The penalty for a silent worker is bounded at three timeouts for the
whole session rather than one per batch.

Three is deliberate on both sides. One failure is noise — a single timeout under load should not cost
the session its worker — so a successful batch resets the count and only consecutive failures latch.
Waiting longer is expensive, because the penalty is paid in whole minutes. The thread is left alive
rather than terminated, and restarting the sync runtime gives the bridge a fresh worker and a clean
count.

Shutting the bridge down asks the worker to exit and waits three seconds before terminating it. A
worker that misses that window is fully detached first, so the exit that terminating eventually
produces cannot land on a bridge that has already been restarted and cancel the new worker's
in-flight batches.
