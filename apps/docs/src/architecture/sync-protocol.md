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

## Client Identification and the Per-Platform Write Gate

A client may identify itself with a `x-memry-client: <platform>/<semver>[+<build>]`
header (`ios`, `android`, or `desktop`). The header is **optional**: a request
without it is a legacy desktop client and keeps full access, unchanged. A
malformed header is treated as absent and logged rather than rejected — a
parser bug must never be able to lock a user out of their own vault. Pre-release
versions (`1.0.0-beta.1`) count as malformed, so a beta can never satisfy a
floor its release does not.

The server keeps one `client_policies` row per platform, holding a semver write
floor and a kill switch. It is consulted on **writes only**; reads are never
gated, so a device dropped to read-only can still open every note it owns.

| Condition                                | Server behaviour                                                   |
| ---------------------------------------- | ------------------------------------------------------------------ |
| No header                                | Allow (legacy desktop)                                             |
| No row, or `min_write_version` is NULL   | Allow                                                              |
| Version at or above the floor, writes on | Allow                                                              |
| Version below the floor                  | `426` with `CLIENT_UPGRADE_REQUIRED` and the required `minVersion` |
| `writes_enabled = 0`                     | `403` with `PLATFORM_WRITES_DISABLED`                              |

The kill switch is evaluated before the floor: when writes are off for a
platform, telling users to upgrade would send them chasing a release that cannot
help. Every uninterpretable policy — absent row, NULL floor, unparseable floor —
resolves to allow, so an unreadable policy table degrades to today's behaviour
rather than to an outage.

`GET /sync/status` echoes the caller's own policy as an optional `clientPolicy`
field whenever the request identified itself, so a device learns about a flipped
switch on its next foreground poll instead of by attempting a write and being
rejected. Header-less clients get byte-identical status responses.

On receiving either rejection a client enters explicit read-only mode, **parks**
its outbox (queued writes preserved, attempts stopped), polls the policy on
foreground, and resumes automatically once clear.

### Write attribution

Item writes are stamped with the calling platform and version on `sync_items`,
`crdt_updates`, and `crdt_snapshots`. `NULL` means the row was written by a
client that predates the header — which is every desktop build shipped so far;
there is no backfill. The CRDT tables are included because a note's body lives
there, and that is the payload most likely to need a targeted rollback after a
mobile incident. Attribution records the _latest_ writer, not the creator, so a
desktop rewrite clears an earlier mobile stamp. No read path depends on these
columns.

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

Both of those in-memory ledgers are bounded, because a server-side incident can brand a very large
number of items in a single session. The corrupt-item tracker holds at most 5,000 cooldown entries
and sheds the coldest ones first; the coldest entry is also the one closest to its one-hour cooldown
lapsing, so the most an eviction can cost is one extra re-fetch for an item that was about to become
eligible anyway. Expired entries are also swept at the end of every pull, not only when a later pull
happens to touch the same item.

The quarantine ledger applies the same 7-day expiry to live entries that it already applied to
persisted ones, so a long-running session behaves like a restart. Its 10,000-entry cap is
deliberately soft: only entries that have not yet reached the permanent threshold can be evicted,
because those are attempt counters and a still-broken item simply re-quarantines. Permanent
quarantines are the record that keeps a failed-signature item out of the vault and are never dropped
to satisfy the cap.

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

### A batch the server refuses shrinks instead of ending the run

The acknowledgement rules above all assume a per-item verdict. A request that never reaches the
handler has none: Cloudflare terminates an oversized `POST /sync/push` at the edge — invocation
outcome `exceededCpu`, an empty `503` with no server error code — so nothing is accepted, nothing is
rejected, and no attempt is charged. Resending that request unchanged cannot succeed, because what
tripped the limit is the batch itself: a 100-item push costs roughly 50 ms of Worker CPU, about 80%
of it the per-item Ed25519 signature check.

The push loop therefore reads a `5xx` as a statement about the batch's **shape** rather than a
transient blip. It halves the batch and keeps going — from `PUSH_BATCH_SIZE` (100) down to
`MIN_PUSH_BATCH_SIZE` (1) — so the queue drains at whatever size the server can take. `withRetry`
is given `retryOn5xx: false` for this one call: retrying an identical request first spends the
backoff budget before the loop can adapt, then dead-letters the batch and ends the run. That is how
one vault sat at 2914 pending changes for five days, with `POST /sync/pull` and `GET /sync/manifest`
taking collateral 503s from the same isolate.

The size that worked is remembered on the coordinator rather than re-derived per run, so a vault
refused at 100 does not re-spend those doomed requests every cycle. It only ever shrinks; a restart
clears it and the loop starts optimistically from the configured size again.

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

That tombstone is stamped with this device's clock before it is queued. The payload it is built from
is the one just pulled, so its clock is the **server's own** clock for that row, and the server
rejects any push whose clock has no entry greater than the one it already holds. Sent back unchanged
the delete is answered `SYNC_REPLAY_DETECTED`, the queue row is cleared as already applied, the next
pull serves the same orphan again, and the repair runs again — the loop it exists to end, running
forever. A normal delete never hits this: it is built from a local row by the domain layer, which
stamps the clock on the way out, and the push path sends `delete` payloads verbatim apart from the
last-resort clock stamp described in
[Initial seeding](/architecture/sync-handlers#initial-seeding), which only fires when the payload has
no clock at all and so cannot lift a server clock past itself. An
orphan has no local row, which is what makes it an orphan, so nothing else can stamp it. Without
signing keys the stamp is impossible, and the orphan is left for the next pull rather than spending a
push that would only be refused again.

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

## Property Definitions

`property_definition` is an encrypted record sync item type whose id is the property name. It
carries the property's type plus its `options` column verbatim, as the opaque JSON string the row
stores — a bare option array, or `{ categories }` for a `status` property. It is deliberately
opaque so a newer client's per-option field survives a round trip through an older one.

`.memry/properties.md` stays the human-readable file, and it is local to one machine. The data DB
row is what replicates. Two consequences worth knowing before touching either:

- `PropertyDefinitionsService.reload()` rebuilds the table from that file, and the pull coordinator
  calls it after every pull. The rebuild carries each row's clock across, or every definition would
  look unclocked and `seedUnclocked` would re-push the whole set on the next sync.
- A pulled definition exists only as a row until the file is written, so `reload()` unions the
  clocked rows into the cache and persists when the union gained something — including on a device
  that has no file yet. A remote delete reconciles the file too, or the next reload reads the
  definition straight back in.

`property_definition` is not in `LEGACY_RECORD_SYNC_ITEM_TYPES`; clients that predate it negotiate
it away via `X-Memry-Sync-Types` and never see it.

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

### Manifest pagination

`GET /sync/manifest` pages **opt-in** via `limit` (with an optional `cursor`). A param-less
request — which is every client shipped before this — keeps the original complete single response,
`nextCursor` field and all absent. A `cursor` without a `limit` is a malformed pagination attempt
and is rejected rather than answered with the full manifest, which would silently duplicate the
pages already served.

Pagination keys on `server_cursor`: it is unique per user and only ever grows, so pages can neither
skip nor split rows. A row updated _between_ pages gets a new cursor greater than any page already
served, so it may appear twice across the run — once at its old cursor, again at its new one —
never zero times, and the client's `(type, id)` map dedups the repeat. `nextCursor` is taken from
the last row **kept**, unsupported types included, so the type filter cannot open a gap the next
page skips over. `MAX_MANIFEST_PAGE_LIMIT` is 1000, and the +1 row the query fetches probes for
another page without a `COUNT`.

The `sync_manifest` ceiling moved from 10/min to 30/min alongside this: a paginated client spends
`ceil(rows / page)` requests per integrity check instead of 1, so the old ceiling would have
stalled any vault past 10 pages. Each paged request is a bounded indexed scan — strictly cheaper
than the single unbounded full scan the old ceiling was budgeted for.

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
- **Durable download verdicts** — a download that does not succeed is recorded
  in the data DB (`attachment_download_failures`, migration 0051), keyed by
  (note, attachment). Only the outcome writes here: the request itself no longer
  counts as a result, so a 404 and a success are no longer the same event. A
  transient failure (5xx, network, decrypt) keeps its retry on an exponential
  backoff from one minute. A `404`/`410` — the server saying it does not have
  this blob — is re-probed at most once a day, three times, and then never
  automatically again. Session state (in-flight claims and this session's
  successes) is still in memory and still cleared on runtime teardown, because
  the file is on disk and a re-request is cheap; the verdicts deliberately are
  not, since surviving a sync stop/start is the whole point.
- **Reference pruning** — `attachmentReferences` merges union-only, so a
  reference to a blob that is genuinely gone would otherwise live in the note's
  payload forever and be handed to every device that ever pulls it. On the pull
  that applies a note, ids whose 404 probes are exhausted are dropped from the
  stored list. The rule is positive evidence only: this device watched the
  server 404 that exact manifest three times, and the note has no pending
  `attachment_upload_queue` row (bytes still on their way up are never pruned).
  An id that has merely not uploaded yet has no verdict and is never touched,
  and nothing on disk is ever deleted. The way back is that attachment ids are
  minted per upload — re-inserting the file produces a new id with no verdict
  against it — and a local upload of the same id clears its row outright.

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
against the open data-database handle rather than re-read per request. The cache lives with the
resolver itself, so every consumer shares it: the request header, device registration, vault-key
derivation, canvas reconcile and per-attachment uploads all read the row once per open vault instead
of once per operation. Opening, closing or switching a vault installs a new handle and therefore
misses the cache on its own; the one rewrite that keeps the same handle — a linked device adopting
the initiator's vault identity — invalidates it explicitly, so device registration and the first
sync bind to the adopted vault, never the pre-adoption one.

Desktop reads the directory over IPC:

| IPC method                                     | Purpose                                                                                              |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `vault.listAccount()`                          | Returns `AccountVaultInfo[]` (uuid, decrypted name, item count, local path, suggested download path) |
| `vault.downloadRemote(vaultUuid, parentPath?)` | Clone a cloud-only vault into a local folder and open it                                             |

The renderer surfaces this as an in-account switcher section plus a download dialog where the user
picks the destination folder. A name that fails to decrypt is shown as `null` rather than blocking the
list.

## Endpoints

| Path                                   | Direction | Purpose                                                                                       |
| -------------------------------------- | --------- | --------------------------------------------------------------------------------------------- |
| `POST /sync/push`                      | up        | Upload new sync items (metadata + blob refs)                                                  |
| `POST /sync/pull`                      | down      | Fetch updates since cursor                                                                    |
| `POST /sync/crdt/updates`              | up        | Incremental Yjs binary updates                                                                |
| `GET /sync/crdt/updates`               | down      | One note's incremental updates (`note_id`, `since`, `limit` query params)                     |
| `POST /sync/crdt/updates/batch`        | down      | Incremental updates for up to 100 notes in one request, plus `snapshotMeta`                   |
| `POST /sync/crdt/snapshot`             | up        | Full Yjs document baseline; prunes the note's stored updates at or below it                   |
| `POST /sync/crdt/snapshot/batch`       | up        | Up to 50 full baselines in one request; same store-and-prune semantics, reported per note     |
| `GET /sync/crdt/snapshot/:noteId`      | down      | The note's snapshot baseline and its `revision`, applied before its incrementals              |
| `GET /sync/vaults`                     | down      | List the account's registered vaults                                                          |
| `POST /sync/vaults`                    | up        | Register or update a vault's encrypted name                                                   |
| `POST /sync/bootstrap`                 | mixed     | Open an elevated bootstrap window; returns a token, the first manifest page and a tail cursor |
| `POST /sync/bootstrap/renew`           | mixed     | Slide the window's TTL under the same session id                                              |
| `POST /sync/bootstrap/close`           | up        | Release the window and its per-user session slot (idempotent)                                 |
| `GET /sync/packs`                      | down      | List this vault's compaction packs, newest-first, with presigned URLs when available          |
| `POST /sync/attachments/presign-batch` | down      | Presigned R2 GETs for attachment chunks the caller already owns                               |
| `POST /auth/*`                         | mixed     | OTP, sign-in, refresh, sign-out                                                               |
| `POST /auth/oauth/google/native`       | mixed     | Trade a platform-issued Google ID token for a setup token (mobile)                            |
| `GET /auth/key-verifier`               | down      | Account key verifier for an established session (vault-key mismatch detection)                |
| `POST /devices/*`                      | mixed     | Linking, listing, revoking                                                                    |
| `POST /keys/*`                         | mixed     | Key sealing during link, rotation                                                             |

The five `/sync/crdt/*` routes are the only ones that carry a note body; the record feed above them
moves metadata only. A device reads a body by applying the baseline from
`GET /sync/crdt/snapshot/:noteId` and then replaying incrementals from `GET /sync/crdt/updates`.
`POST /sync/crdt/updates/batch` is the whole-vault form of that second step — up to 100 notes per
request, each with its own `since` — but it batches incrementals only, so the baselines stay one GET
per note and dominate a first-sync sweep's request count.

### Native OAuth on mobile

`GET /auth/oauth/google` starts the browser flow and only accepts a `redirect_uri` that is a
`127.0.0.1` loopback (the desktop app) or the configured web origin. iOS has neither, so mobile does
not use it. The app signs in with Google's own SDK and posts the resulting ID token to
`POST /auth/oauth/google/native`, which skips the authorization-code exchange and rejoins the
browser flow at token validation. Everything after that point — user lookup, entitlement, setup
token, analytics — is the same code path, so the two entry points cannot drift into two account
models.

Two consequences worth knowing:

- The route validates the ID token against `GOOGLE_IOS_CLIENT_ID`. When that binding is unset it
  answers `501` rather than falling back to the web client, because validating against the wrong
  audience would accept a token minted for a different application.
- The client ids are also what gate the button. A mobile build without them omits the Google option
  from the sign-in screen entirely rather than showing one that fails when tapped.

### Snapshot revisions

A snapshot baseline carries a `revision`: an opaque token the server replaces on every snapshot
write, so a client can tell whether the server's baseline moved without downloading it.

- `GET /sync/crdt/snapshot/:noteId` returns `revision` alongside `snapshot`, `sequenceNum` and
  `signerDeviceId`, so a device learns the token for the baseline it just merged. When the note has
  no server snapshot the response is `{ snapshot: null, sequenceNum: 0, signerDeviceId: null, revision: null }`.
- `POST /sync/crdt/updates/batch` returns a top-level `snapshotMeta` map beside `notes`:
  `{ "<noteId>": { "sequenceNum": 42, "revision": "…", "signerDeviceId": "…" } }`. A note absent from
  a present map has no server snapshot at all; an absent `snapshotMeta` key means the server predates
  this field.

The token is deliberately not `sequenceNum`. A replacement snapshot keeps the note's existing
sequence number so later incrementals stay pullable, so the number does not move when the blob does.
It is random per write rather than a counter, so a row deleted and recreated — vault deletion,
account recreation — cannot reuse a token a client still holds.

Rows written before the field existed are not backfilled; the server derives a deterministic token
for them at read time from the row's identity, creation time and size, and the next snapshot push
replaces it with a real one. Both read paths return the same token for the same row.

Both fields are additive: an older client reads these responses through an unvalidated cast and
ignores the extra keys.

`snapshotMeta` is read on the same round trip as the incrementals, as extra statements inside the
batch the pull already sends. D1 refuses any single query carrying more than 100 bound parameters and
answers the whole request with an error, and the metadata read binds the user and vault ahead of one
parameter per note, so it is split into several statements sized under that ceiling rather than one
statement naming every note in the chunk. A request-sized chunk of 100 notes would otherwise cross
the line — and only a full chunk does, which is why a first sync on a new device was the one caller
that hit it.

### The vault sweep's conditional baseline

The vault-wide sweep uses `snapshotMeta` to stop re-downloading baselines a device already holds. It
runs each chunk in two phases:

- **Probe.** One `POST /sync/crdt/updates/batch` for the chunk with `limit: 1`, asking only whether
  anything moved. No document is opened, no snapshot is fetched, nothing is decrypted. A note whose
  baseline is unchanged and whose update list comes back empty is finished here.
- **Apply.** Only the notes with work take the existing open-document, baseline, apply path, and a
  note whose baseline the probe proved redundant skips the `GET /sync/crdt/snapshot/:noteId` and
  resumes its incrementals from the sequence it already applied.

A baseline is skipped only when **both** of these hold:

1. the note's `revision` in `snapshotMeta` equals the revision this session actually merged, and
2. the sequence this session applied is at or above the note's `sequenceNum` in `snapshotMeta`.

The second condition is not implied by the first. `sequenceNum` is the server's prune watermark, and
`pruneUpdatesBeforeSnapshot` has already deleted every update at or below it — a pull starting under
that line is answered with silence rather than an error, so the note would go quietly stale.

Everything else falls through to a fetch: an absent `snapshotMeta` key (an older server), a note the
server left out of the response, and any note this session holds no merged revision for. A missed
skip costs one request; a wrong skip costs a note body.

The bookkeeping — `{ appliedSequence, snapshotRevision }` per note, the **snapshot watermark** — is
persisted **inside the per-vault CRDT store**, so the warm path survives an app restart and a fresh
sign-in rather than paying a full cold sweep on every launch. It is a y-leveldb document meta key,
which puts it in the same LevelDB, in the same directory, behind the same handle as the note's
updates: there is no way to read a watermark without the store that holds the document it describes.

That location is forced, not chosen. A watermark that outlives its document makes the sweep skip
that baseline **forever** against a body that never had it. Because a meta key sits inside the key
range `clearDocument` wipes, purging a note drops its watermark in the same operation; quarantining,
rebuilding or re-pathing the store moves or destroys every watermark with every document; and a
store that could not be opened at all leaves the provider in memory-only mode with no handle to read
a watermark through. The watermark is never written for a snapshot that was not actually received —
`GET /sync/crdt/snapshot/:noteId` answers `null` when the D1 row exists but its R2 blob is gone.

The key is additive. A store written by a build that predates it has no record, which reads as
**unknown → fetch**, never as "sequence 0 → skip", so the first sweep on such a store costs exactly
what it cost before. A newer store read by an older build is inert: the older build never asks for
the key. No protocol change, no D1 schema change, no IPC contract change.

Two properties this does **not** change. The sweep stays exhaustive — every note in a chunk is still
named in the probe, because the sweep is the only channel by which a body-only remote edit reaches a
device that missed the broadcast; this changes what a note costs, never whether it is visited. And
the single-note pull path (`GET /sync/crdt/snapshot/:noteId` then `GET /sync/crdt/updates`) stays
unconditional: it reports whether the server's state was fully merged, and the pending-note replay
turns that report into a snapshot push, which prunes peers' updates.

Pushing a snapshot is an assertion, not just a write: once the snapshot is stored,
`pruneUpdatesBeforeSnapshot` deletes every `crdt_updates` row for that note at or below the
snapshot's sequence number. A snapshot that does not already contain those updates does not merely
fail to add them — it removes them from the server.

### Batched snapshot uploads

`POST /sync/crdt/snapshot` takes one note per request, and the server spends six serial D1/R2
round trips on it: the note's current watermark, its existing snapshot row, a storage reservation,
the R2 put, the upsert, and the prune. That is fine for the editing path, where snapshots trickle
out behind a 30-second debounce, and expensive for seeding, where a fresh vault pushes a baseline
for every note it owns. On a 1000-note vault each 100 bodies cost 15 seconds, essentially all of it
server time.

`POST /sync/crdt/snapshot/batch` carries up to 50 snapshots and pays those costs once per request
instead of once per note — the metadata reads become one `db.batch` chunked at the bind-param
ceiling, the reservations become one call for the batch's summed growth, the R2 puts run
concurrently, and the upserts and prunes become one batch each. Semantics per note are identical to
the single-note endpoint, including the rule that a note's snapshot watermark stays where it is once
a snapshot exists.

The response reports each note separately:

```jsonc
{
  "results": [
    { "noteId": "…", "accepted": true, "sequenceNum": 42 },
    { "noteId": "…", "accepted": false, "reason": "…" }
  ]
}
```

Entries are returned in request order, and one note failing does not fail the others. A storage
quota that the batch as a whole cannot satisfy still rejects the whole request, exactly as the
single-note path does — nothing partial lands.

Two notes never ride a batch:

- **A note with unmerged remote state.** The batch endpoint prunes stored updates below the new
  watermark, so a device that merged around server state it could not verify must not assert "I
  contain everything up to here". Those notes take the non-pruning `POST /sync/crdt/updates` route,
  the same way the single-note path already routes them.
- **Anything pushed to a server that predates this endpoint.** Such a server answers 404 here and
  200 for the single-note route. The first 404 latches for the session and every later chunk falls
  back to one request per note, so an old server costs one wasted request rather than one per batch.
  A 413 also falls back per note but does not latch: the aggregate body being too large says nothing
  about which note is oversized, and only the per-note path can name it to the user.

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

The two caps do not compose cleanly at the top end. A payload the route would reject with the
precise `Snapshot exceeds 5MB limit` never reaches the route once its encoded body passes 8 MiB: the
body-limit middleware answers 413 first, and with it the route's `snapshot_rejected` event — the one
carrying `totalBytes` — was lost. The middleware therefore emits that event itself for
`/sync/crdt/snapshot` and `/sync/crdt/updates`, with `reason: 'body_limit_exceeded'` and the
observed **encoded** body size (base64 plus the JSON envelope, roughly 4/3 of the decoded payload).
An oversized CRDT payload is diagnosable whichever check catches it. On the client a bare 413 with
no storage code maps to `note_too_large`, which names the note in its toast — it is not, and must
not read as, a storage-quota problem.

### CRDT write notifications

Both CRDT write paths notify peers the same way. Once the write is durable, the server broadcasts
`crdt_updated` carrying the note id to every socket on that vault except the pushing device, and
each peer pulls that one note. Nothing else carries a body — the record feed moves metadata only —
so a body write that does not broadcast stays invisible until the receiving device's next vault
sweep, which is up to 15 minutes away.

The symmetry matters most for `POST /sync/crdt/snapshot`, which is not only the oversized-update
fallback. Edits made while signed out do enter the local Y.Doc, but with no session they are never
enqueued as incremental updates, so on the next sign-in that whole accumulated state can only leave
the device as a snapshot. Before the snapshot path broadcast, such a push was stored and announced
to nobody: the peer's socket stayed connected and silent, its 60-second tick pulled only the record
feed, and the backlog appeared solely once someone typed one more character — that produced an
incremental, which did broadcast, and the pull it triggered picked up the snapshot's content too.

The snapshot broadcast is issued after the snapshot is stored and after `pruneUpdatesBeforeSnapshot`
has run, never between them, so no peer is told to pull while the superseded updates are still being
removed. Delivery is best-effort on both paths: the write has already succeeded, so a failed
broadcast is captured in the background rather than returned to the client, which would otherwise
retry a write that already landed.

### Rate limiter mechanism

Every rate-limited endpoint shares one fixed-window middleware (`createRateLimiter`), and its
counter lives in a `RateLimiter` Durable Object — one instance per `bucket:identifier` key — not in
D1. The previous implementation paid a 2-statement `db.batch` against a single `rate_limits` row per
bucket on every request, which meant write contention exactly when a fresh device hammered the API.
The DO keeps identical semantics: a request older than the bucket's window starts a fresh window at
count 1, anything else increments, and the middleware compares the count against the bucket ceiling.
Nothing client-visible changed — same bucket names, ceilings, and windows, the same 429 body, and
`Retry-After` still reports the exact seconds left in the window.

Two properties of the split matter. The DO only counts; the ceiling comparison stays in the
middleware, which is what lets a request-scoped elevation hook (`getElevatedLimits`, the seam for
bootstrap-session elevation) widen the effective ceiling without touching the counter. And failure
stays fail-closed: a missing binding or DO error blocks the request with a 500, exactly as a D1
error did before.

The `rate_limits` table still exists: previously-deployed code writes it during a deploy window,
and the OTP per-email limiter plus the telemetry exception budget still use it. It is dropped only
after those two migrate.

### CRDT rate limits

The three CRDT limiters (`crdt_push`, `crdt_pull`, `crdt_batch_pull`) key their buckets by
**deviceId**, not by account. Body sync is device-local work: each device pulls the note bodies it
does not already hold, so a second device on the same account is normal use rather than contention.
Under the default per-user key the two devices split one budget, and a legitimate first sync on
device B made device A's ordinary syncing start failing with 429s. A request that arrives without a
deviceId keeps the existing userId → IP fallback, so nothing becomes less strict.

`crdt_push` allows 300 requests per 60 seconds. Batched snapshot uploads changed what that budget
buys: a push iteration dequeues at most 100 creates and a batch carries 50, so an iteration yields
at most two snapshot requests, and iterations are serial. Seeding a 1000-note vault therefore costs
roughly 20 requests rather than 1000, which is why `crdt_push` receives no bootstrap elevation —
`BOOTSTRAP_ELEVATION_MULTIPLIERS` stays pull-only, and pushes keep their abuse ceilings.

`crdt_pull` allows 600 requests per 60 seconds, which is sized for one device pulling an entire
vault's bodies after a fresh sign-in. That sweep costs two GETs per note — snapshot plus
incrementals — so a 121-note vault spends roughly 242 requests within a few seconds, and the ceiling
leaves room for a vault twice that size plus the editing traffic running alongside it. The client
paces and batches the sweep itself; this limit is the safety margin for when that pacing is wrong or
missing, not the mechanism that shapes the traffic.

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

## Bootstrap Sessions

A device that has never pulled a vault has to move the whole thing. Every steady-state rate ceiling
on this server is sized for a device that already has its data and is exchanging deltas, so a fresh
device's first sync is the one workload those ceilings actively fight. A **bootstrap session** is a
time-boxed, per-device window in which the pull-side ceilings are widened — and nothing else
changes.

| Route                        | Purpose                                                                                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /sync/bootstrap`       | Open a window. Returns the session token, the first manifest page, `tailCursor`, and (when the deployment can presign) a first page of attachment chunk hashes |
| `POST /sync/bootstrap/renew` | Slide the TTL under the same session id                                                                                                                        |
| `POST /sync/bootstrap/close` | Drop the ledger row and free the per-user slot; idempotent                                                                                                     |

They are mounted as their own router under `/sync/bootstrap` because Hono's `use('*')` does not
leak between routers and these routes need their own stack: `authMiddleware`,
`clientGateMiddleware`, `paidSyncMiddleware`, `syncTypesMiddleware` — the same gates as the rest of
the vault pull path. Their own limiter bucket, `bootstrap_session`, allows 30 requests per minute
keyed by **device**, since eligibility is per device and open/renew/close are once-per-run
operations rather than hot-path traffic.

### The token

An HMAC-SHA256 signature over a base64url JSON payload carrying
`{v: 1, userId, deviceId, vaultId, jti, iat, exp}` — the same shape as the checkout token, keyed by
its own secret binding. Per-purpose HMAC secrets are this codebase's pattern (`OTP_HMAC_KEY`,
`WEBHOOK_HMAC_KEY`, `TELEMETRY_HMAC_KEY`): one shared key across token classes would let a leak in
any of them forge all of them.

Verification reads **no database**. `exp` is inside the signature, so an expired token fails
verification with zero I/O on the hot path, and the token can be checked on every elevated request
without a round trip. `verifyBootstrapSession` returns null on _any_ failure — wrong secret,
tampered payload, expired, malformed — and never throws: an invalid bootstrap header must not be
able to fail an unrelated sync request.

`iat` is carried in the payload but never inspected. The only temporal check is
`if (payload.exp <= nowSeconds) return null`, so a token whose `iat` is in the future verifies
normally as long as its `exp` has not passed. That is harmless — `iat` is informational, only the
signing key's holder can set either claim, and `exp` alone bounds the window — but a not-before
check is not something this token has, and the function's own doc comment claiming "future-dated"
among its rejections is wrong.

The one thing statelessness cannot express is a cap on concurrent sessions, which is what the
`bootstrap_sessions` ledger (migration `0007_bootstrap_sessions`) exists for. It is never on the
verification path. It is written at issuance, renewal and close, deleted per `(user, vault)` by
vault-deletion revocation, and pruned two more ways: issuance runs a lazy
`DELETE FROM bootstrap_sessions WHERE user_id = ? AND expires_at < ?` for that user only before its
insert, and the 6-hourly cron runs `cleanup_expired_bootstrap_sessions`, which deletes every
expired row account-wide. An abandoned session therefore costs one row until its expiry passes,
never a live cap slot.

### What elevation actually does

The limiter middleware asks a request-scoped hook (`getElevatedLimits`) for a multiplier and
compares the count against `ceiling × multiplier`. The Durable Object still only counts; the
comparison stays in the middleware, which is exactly what lets elevation widen a ceiling without
touching the counter — see [Rate limiter mechanism](#rate-limiter-mechanism).

| Bucket            | Steady state | Multiplier | Elevated | Cost per request                                                 |
| ----------------- | ------------ | ---------- | -------- | ---------------------------------------------------------------- |
| `crdt_pull`       | 600/min      | ×5         | 3000/min | One indexed D1 read, at most one R2 read                         |
| `crdt_batch_pull` | 30/min       | ×5         | 150/min  | One indexed query                                                |
| `blob_download`   | 600/min      | ×5         | 3000/min | One indexed D1 row + one R2 class-B read                         |
| `sync_pull`       | 120/min      | ×3         | 360/min  | Up to 100 R2 reads per POST (`pullItems` caps concurrency at 25) |
| `sync_changes`    | 60/min       | ×3         | 180/min  | One indexed scan per page of 500, refs only                      |
| `sync_manifest`   | 30/min       | ×3         | 90/min   | Bounded indexed keyset scan per page                             |

Everything else — every push, every upload, status, vaults, the socket, and presign issuance itself
— stays at its steady-state ceiling whether or not a valid token is present. Bootstrap is a pull
problem, and elevating a write path would only widen an abuse ceiling.

`sync_pull` gets the smaller multiplier because it is the expensive one: 6 requests/second against
bursts of 25 concurrent R2 reads is roughly 150 R2 operations/second worst case. That is bounded by
the TTL and the two-session cap, and is still below what a single warm push batch spends.

#### Nothing is granted — the client assumes ×5

The multipliers above are the **server's** table and never travel. `POST /sync/bootstrap` returns
no `elevationFactor`: the field is absent from `BootstrapOpenResponseSchema`
(`packages/contracts/src/bootstrap-api.ts`) and the route never sets it. The client probes the open
response for one anyway and, finding none, always falls through to
`DEFAULT_ELEVATION_FACTOR = 5` (`src/main/sync/bootstrap-session.ts`). Every client-side pacing site
therefore runs at a hard-coded ×5, including against `sync_pull`, `sync_changes` and
`sync_manifest`, which the server only widens ×3.

That is safe rather than tuned, because the client's pacing sites and the ×3 buckets barely
overlap. The CRDT sweep — the one site that paces continuously — spends `crdt_batch_pull` and
`crdt_pull`, both ×5 buckets, and `crdtSweepChunkDelayMs` divides each of its three slice terms by
the factor, so its own derivation's "at most 50% of the bucket" property survives elevation exactly.
The pull path is not client-paced by this factor at all: grep `getBootstrapElevationFactor` and
every call site is one of the three rows in the table below, or the session module notifying its
own listeners. The pull is bounded by page size and the server's own
limiter, which is where a ×5 assumption against a ×3 ceiling would surface: as a 429, which
`http-client` turns into a `RateLimitError` carrying `Retry-After`. The pull coordinator rethrows
that rather than swallowing it, so the run ends and the next sync cycle retries — a delay, not a
lost pull.

The probe is worth keeping: it is the seam a future server-negotiated factor would arrive through
without a protocol change. As shipped it does nothing, and the number in the client is not the
number in the server.

#### The factor is read at charge time in exactly one place

| Pacing site                                            | How it takes the factor                                                                      | Reverts when the session ends                               |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| CRDT sweep per-chunk delay (`full-sync-runner`)        | `crdtSweepChunkDelayMs(cost, getBootstrapElevationFactor())`, called inside the chunk loop   | On the very next chunk                                      |
| Attachment download queue (`sync-attachment-handlers`) | Seeded once, then push-updated through `onBootstrapElevationChange(...)`                     | On the next notification, before the next request           |
| Pack download pacer (`full-sync-runner`)               | `pacer.setMultiplier(getBootstrapElevationFactor())` once per bootstrap run, no subscription | Not within the run — the multiplier is cached until it ends |

Only the sweep reads it at charge time. The pack pacer's caching is deliberate and commented as
such: a session that closes mid-run only narrows the factor, pack transfers are tens of large
objects rather than thousands of small ones, and those transfers are presigned GETs direct to R2
that spend no Worker bucket at all.

Requests carry the token in `X-Memry-Bootstrap-Token`. Identity is re-bound to the authenticated
context of the request it arrives on, so a token replayed from another device or another vault
elevates nothing.

### Eligibility, TTL and the lifetime cap

`POST /sync/bootstrap` is only granted to a device that has never completed a pull for this vault:
`device_sync_state.last_cursor_seen` is absent, NULL or 0. `updateDeviceCursor` only writes when a
changes page actually delivered items, so that is a genuine never-pulled device — the same signal
the client's own `LAST_CURSOR` gate uses. An already-synced device gets `BOOTSTRAP_NOT_ELIGIBLE`
(409).

| Constant                                 | Value      | Why                                                 |
| ---------------------------------------- | ---------- | --------------------------------------------------- |
| `BOOTSTRAP_SESSION_TTL_SECONDS`          | 60 minutes | Per-token lifetime; slides on renewal               |
| `MAX_BOOTSTRAP_SESSION_LIFETIME_SECONDS` | 6 hours    | Absolute ceiling from the ledger row's `created_at` |
| `BOOTSTRAP_RENEW_LEAD_SECONDS`           | 5 minutes  | How far before expiry the client renews             |
| `MAX_CONCURRENT_BOOTSTRAP_SESSIONS`      | 2          | Per user, counted over unexpired rows only          |

Renewal is sliding and identity-bound: a still-valid token exchanges for a fresh TTL under the
**same `jti`**, so the ledger row simply extends rather than churning through insert/delete. An
expired or revoked token is refused — renewal is not resurrection — and a token presented by any
other user, device or vault is refused with `BOOTSTRAP_IDENTITY_MISMATCH` (403) instead of being
extended. Bearer possession alone never renews anything.

The absolute lifetime exists because the per-token TTL slides. Without a hard ceiling a client that
never finishes its pull, and never fires its close sweep, could hold an elevated window open
indefinitely. Six hours comfortably covers any real full-vault pull — the pacing budgets assume
hours, not days. Past the ceiling, `/renew` answers `BOOTSTRAP_SESSION_EXPIRED` (403) **and drops
the ledger row**: the session can never come back, so keeping it would only pin a cap slot until
its TTL passed. The client treats this like any other failed renewal — close locally, revert to
steady-state pacing.

The concurrency cap is taken atomically. The whole decision lives in one statement — the `COUNT`
subquery is evaluated as part of the `INSERT`'s own execution, and D1 serialises write statements,
so there is no interleaving point left between check and take. `changes === 0` means the `WHERE`
refused, i.e. the user is at cap, answered `BOOTSTRAP_SESSION_LIMIT` (429). The earlier
prune-then-count-then-insert sequence had a TOCTOU window where two concurrent opens could both see
one free slot.

Errors are logged with the **caller's** identifiers only, never the mismatched token's, so the
warning line cannot be used to enumerate other users' identifiers.

### Documented limitation: a closed token still elevates for up to 60 minutes

Elevation is stateless by design — it reads the signature and `exp`, never the ledger. A token
whose session was closed through `/sync/bootstrap/close`, or one that was stolen, therefore keeps
elevating **from its own device** until its `exp`, which is at most 60 minutes away.

This is accepted rather than fixed, and the reasoning is what bounds it:

- The residual is hard-capped by the TTL and cannot be extended or moved. Since renewal and close
  became identity-bound, no other user, device or vault can renew it — or even close it. It can
  only be waited out.
- Every elevated bucket is pull-only. The worst case is a device reading its own vault's ciphertext
  faster than steady state allows, for under an hour.
- Making it stateful would put a D1 read on the hot path of every rate-limited request, which is
  the cost the token was designed to avoid.

Closing early is still worth doing, because `/close` frees the per-user session slot for the
account's other devices.

### The 501 degradation

`BOOTSTRAP_SESSION_HMAC_KEY` is **optional**. When it is absent:

- All three endpoints answer a typed `BOOTSTRAP_UNAVAILABLE` (501), mirroring
  `STORAGE_PRESIGN_UNAVAILABLE`.
- `bootstrapRateLimitElevation` returns null everywhere, so every bucket keeps its steady-state
  ceiling.

That is byte-for-byte today's behaviour. The client's failure discipline makes it invisible: a
404 from an old server, a 501 from an unconfigured one, a 409 from an already-synced device, a 429
at the cap, a malformed body, or a plain network error all resolve to "no bootstrap here" — the
client clears local state and syncs exactly as it did before the feature existed. The token can
only ever widen a ceiling, so losing it can never lose data.

### Completing the bootstrap and releasing the session are two decisions

They used to be one, and #1835/#1837 pulled them apart because every path where completion is
legitimately impossible was leaking the per-user session slot.

**Marking the bootstrap complete** is a claim that every note body the server holds is now current
on this device. `maybeMarkBootstrapFullText()` fires only when four things hold at once:
`sweepSettledOnThisEngine`, `bootstrapPullSucceeded`, no paced CRDT chunk in flight, and both the
paced queue and the pending set empty.

`sweepSettledOnThisEngine` deliberately does **not** mean "a sweep literally ran". The sweep
throttle reads the persisted `LAST_CRDT_SWEEP_AT` stamp while fresh-device detection reads
`LAST_CURSOR`, so a genuine first sync can find the sweep throttled and never run one — and a mark
gated on a sweep having run would then never fire, holding the window and the elevated session open
until the TTL expired. The flag is set when a sweep is queued **and** when the runner is online and
the throttle declined, because that is the other way the question "is anything outstanding?" gets a
real answer. Offline is not one of those ways: it means "nothing is fetchable", never "nothing is
outstanding".

`bootstrapPullSucceeded` is the other half, and is why `PullCoordinator.pull()` and
`SyncEngine.pull()` return `Promise<boolean>` rather than `Promise<void>`. On a fresh device an
empty index DB makes every sweep drain trivially whether or not the pull failed, so "queue empty"
only becomes "bodies delivered" once a pull has reported that it actually delivered.

`LAST_CRDT_SWEEP_AT` itself is written by `stampSweptVault()` when the paced drain has finished the
vault — nothing in flight, nothing queued, nothing owed back to the pending set — not when the
sweep enqueued it. `unstampedSweepAt` holds the throttle interval closed in between, so a process
killed mid-drain does not leave a stamp claiming a drain that never completed.

**Releasing the elevated session** is a resource concern, and takes any of these paths:

| Path                           | Trigger                                                                                           | Reason logged  |
| ------------------------------ | ------------------------------------------------------------------------------------------------- | -------------- |
| Completion                     | `maybeMarkBootstrapFullText()` — all four gates hold                                              | `completed`    |
| Stalled drain                  | Empty paced queue, nothing in flight — whether the drain finished or ended owing notes back       | `idle`         |
| Blocked drain, terminal        | No `crdtProvider`; fixed for the engine's life, so the block cannot lift and the dwell is skipped | `idle`         |
| Blocked drain, transient       | Blocked continuously for `BOOTSTRAP_DRAIN_BLOCKED_DWELL_MS` = 2 minutes                           | `idle`         |
| Run threw                      | The `catch` in `run()`, which also abandons the telemetry window if no pull had resolved yet      | `failed`       |
| Vault switch / runtime restart | `dispose()`                                                                                       | `vault_switch` |

The dwell is what separates the two blocked cases. A network block lifts by itself constantly, so
cutting the session on a first blocked tick would revert pacing in the middle of a bootstrap that
is about to resume; a missing CRDT provider never lifts, so waiting buys nothing. An active
`fullSyncActive` is exempt from the blocked check entirely.

`dispose()` also abandons the bootstrap telemetry window — but only one this runner owns
(`bootstrapWindowOwned`). The window is a module global and `beginBootstrap` no-ops while one is
set, so an unconditional abandon during a vault switch would delete the _incoming_ vault's window:
`downloadRemoteVault` arms it before `selectVault` closes the outgoing engine.

On every path, local state is cleared **first** — the token is captured, then
`clearBootstrapSessionState()` runs and notifies the factor listeners, so pacing reverts in the same
tick. The `POST /sync/bootstrap/close` call follows best-effort with the captured token, and its
failure is logged at debug: the token dies on its own TTL, so a lost close request is harmless. The
reason is local; it is logged and never sent.

### What the open response carries

Besides the session, `POST /sync/bootstrap` answers with:

- `manifest` — the **first page** of the paginated manifest service (`MAX_MANIFEST_PAGE_LIMIT`),
  never the whole vault.
- `tailCursor` — the current `MAX(server_cursor)` for the vault, so the client knows when its pull
  has caught up.
- `attachments` — present only when the deployment can presign. Its `chunkHashes` is the first
  keyset page of the vault's ciphertext chunk hashes, capped at 512, and is **informational
  only**: no continuation endpoint ships, so `nextChunkCursor` names where continuation _would_
  start and a client must not treat the page as a complete inventory. URLs come from
  `POST /sync/attachments/presign-batch`, which keeps this response bounded no matter how
  attachment-heavy the vault is.
- `packs` — always an empty array, and now permanently so. The route returns `packs: []`
  unconditionally. It was reserved so the pack pipeline could plug in without a protocol change,
  but the pipeline did not use it: the client discovers packs through
  [`GET /sync/packs`](#pack-discovery) instead, and reads this field only to log its length. It is
  dead weight in `BootstrapOpenResponseSchema` — it cannot be removed without a contract change, so
  it stays, but nothing should be built on it.

## Presigned R2 Transfers

R2 speaks the S3 protocol, so an object can be handed to a client as a plain SigV4 query-string
presign with region `auto`, service `s3` and payload hash `UNSIGNED-PAYLOAD`. That turns a chunk or
pack transfer from _client → Worker → R2_ into _client → R2_, taking the Worker out of the byte
path entirely.

The presigner is hand-rolled (`services/r2-presign.ts`) rather than pulled from `aws4fetch` or the
AWS SDK: it is about a hundred lines on Web Crypto, there is no dependency to audit for one HMAC
chain, and the signature path is pinned byte-for-byte against AWS's published known-answer vector.
It is deliberately two layers — `presignS3Url` is pure protocol with no policy, which is what lets
the vector pin it, and `presignR2Url` is the deployment policy wrapper that derives the path-style
address and clamps the TTL.

### Where URLs are issued

| Site                                     | Method | Scope                                             |
| ---------------------------------------- | ------ | ------------------------------------------------- |
| `POST /sync/attachments/upload/initiate` | PUT    | One URL per chunk hash the client declares (≤128) |
| `POST /sync/attachments/presign-batch`   | GET    | One URL per chunk hash the caller owns (1–1024)   |
| `GET /sync/packs`                        | GET    | One URL per pack on the page (≤50)                |

Issuance has its own bucket, `blob_presign`, at 120/min — an order of magnitude under the chunk
ceilings it serves, and deliberately **not** elevated by a bootstrap session. Presigning is cheap
(one HMAC chain plus one indexed D1 read per hash) but each issued URL unlocks a direct transfer
that bypasses the proxied buckets entirely, and one batch already arms up to a full manifest's
chunks per TTL window.

### What a URL is scoped to

One object, one method, one bucket, for five minutes. `DEFAULT_PRESIGN_TTL_SECONDS` and
`MAX_PRESIGN_TTL_SECONDS` are both 300, and `presignR2Url` clamps whatever it is handed into
`[1, 300]`. Only the `host` header is signed.

Scope enforcement is **structural, not checked**. Clients send chunk _hashes_; the R2 key comes
back from a `blob_chunks` row selected by `user_id AND vault_id`, which is exactly the ownership
check the proxied chunk GET performs. A foreign vault's or another user's hash is simply "not
found" (404). Clients never submit key material, so a cross-vault scope escape has nowhere to
enter.

`assertPresignKeyInVault` then runs immediately before signing, on the exact bytes about to enter
the URL, requiring the key to start with `<userId>/vaults/<vaultId>/`. That is defence in depth: a
presigned URL bypasses every other auth check the Worker performs, so the last thing before the
signature is a prefix assertion.

A leaked URL exposes only end-to-end encrypted ciphertext. It is still a credential and is treated
as one — see [Presigned URLs are credentials](/architecture/vault-packs#presigned-urls-are-credentials).

Two properties of the upload direction follow from the Worker not seeing the bytes:

- **`Content-Length` is not covered by the signature**, so an armed PUT URL accepts any number of
  bytes. At `/complete` every direct chunk is `head`-verified against R2 for existence _and_ exact
  byte count before quota is credited, and an object larger than the whole session's ciphertext
  budget is reclaimed immediately.
- **An armed URL that is never registered leaves an invisible object.** The expiry sweep walks
  `uploaded_chunks` and the orphan sweep walks `blob_chunks`, and a presigned PUT appears in
  neither. Migration 0008 adds `upload_sessions.presigned_chunks` — the JSON array of hashes armed
  at initiate — and complete, abort and the expiry sweep each delete every armed hash that has no
  live `blob_chunks` row (`services/presigned-chunk-reclaim.ts`). The `blob_chunks` check is
  load-bearing: a client may legitimately declare the hash of a chunk that already exists, and
  deleting that object would destroy another attachment's data. The column is nullable and
  deliberately not backfilled — NULL means no URLs were ever armed, which is what every row written
  by the old server, by a proxied-path client, or on a deployment without the secrets holds.

### Configuration and the graceful fallback

| Binding                | Value                                                |
| ---------------------- | ---------------------------------------------------- |
| `R2_ACCESS_KEY_ID`     | R2 API token id                                      |
| `R2_SECRET_ACCESS_KEY` | Its secret                                           |
| `R2_S3_ENDPOINT`       | `https://<account-id>.r2.cloudflarestorage.com`      |
| `R2_S3_BUCKET`         | **The bucket bound as `STORAGE` in `wrangler.toml`** |

**None of the four is declared in `wrangler.toml`** — there is no `[vars]`, `[env.staging.vars]` or
`[env.production.vars]` entry for any of them. They appear only in `.dev.vars.example` and in the
`Bindings` type in `src/types.ts`. All four are therefore supplied per environment out of band, and
the usual var-versus-secret split does not apply to any of them; the table above deliberately does
not claim one. Scoping the API token narrowly — one bucket, Object Read & Write — is a sound
deployment practice and nothing in the code checks it, so it is a recommendation, not an invariant
the Worker can enforce.

`resolveR2PresignConfig` returns null unless all four are present, the endpoint parses as a URL,
its protocol is `https:`, and it has a host. A trailing slash on the endpoint is normalised away,
because it would double up in the canonical path and break the signature.

A null config is not an error anywhere. `presign-batch` answers a typed
`STORAGE_PRESIGN_UNAVAILABLE` (501); `upload/initiate` simply omits `chunkUrls` and the session
stays valid on the proxied path; `GET /sync/packs` omits `url` and `expiresAt`. Clients read all
three as "use the proxied path". Old servers answer 404 to the presign route, which clients treat
identically.

**`R2_S3_BUCKET` must name the same bucket the `STORAGE` binding points at.** Nothing in the code
cross-checks this — the Worker cannot read a binding's bucket name — so a mismatch fails at
`/complete` instead: the presigned PUTs land in the _other_ bucket, the Worker's `head` against
`STORAGE` finds nothing, and every affected chunk is rejected with `UPLOAD_INCOMPLETE` (400). That
is fail-closed by construction, since quota is only ever credited for storage the Worker has
verified exists, but it is also silent until an upload completes. Verify the pair on every
environment before enabling the secrets.

## Pack Discovery

Lists the compaction packs available for the caller's vault. A pack is an immutable byte-concat of
already-encrypted blobs plus a trailing index block — see [Vault Packs](/architecture/vault-packs)
for the format, the compaction pipeline and the client's apply path. Everything here is additive:
old clients never call it, and the item-granular endpoints remain the source of truth.

**Auth and gating.** The route sits on the `sync` router after `paidSyncMiddleware`, so it carries
the same stack as `/sync/pull`: authenticated, client-gated, paid-gated, and scoped to the
`X-Memry-Vault-Id` header. Every query filters on `user_id AND vault_id`; there is no cross-vault
read path. It is registered at both `/sync/packs` and `/sync/records/packs`, mirroring the other
record routes. Its bucket is `sync_packs` at 60/min, not elevated by a bootstrap session — a
bootstrap lists packs a handful of times, not continuously.

**Pagination** is keyset on `(max_cursor DESC, id DESC)`, so packs arrive newest-first. `limit`
defaults to 20 and is clamped to `MAX_PACK_PAGE_LIMIT` = 50. The `cursor` token is
`"{max_cursor}:{id}"` and is validated at the route against `^\d+:\S+$`. The composite token is
what keeps tie-grouped rows — two ranges sharing a `max_cursor` — stable across pages: a bare
`max_cursor < ?` filter could skip a row or serve it twice as pages churn. `nextCursor` is present
only when another page exists.

**Response** is `{ packs: PackSummary[], serverTime, nextCursor? }`. Each summary carries:

| Field                   | Meaning                                                                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                    | `pack_index` row id; also the second half of the page cursor                                                                                  |
| `itemKind`              | `record` \| `crdt_snapshot` \| `crdt_update`                                                                                                  |
| `packKey`               | R2 object key                                                                                                                                 |
| `minCursor`/`maxCursor` | Range bounds on the kind's ordering axis                                                                                                      |
| `itemCount`             | Entries written into the pack (holes are not counted)                                                                                         |
| `byteSize`              | **Payload-region bytes only** — header, index block and footer are excluded, so it is not a file length and must not be used to Range-request |
| `createdAt`             | Epoch seconds                                                                                                                                 |
| `url` / `expiresAt`     | Presigned GET and its expiry, both present or both absent                                                                                     |

A row whose `item_kind` fails schema validation is dropped from the page rather than served: an
unknown kind must not silently reach a client that switches on it.

**An absent `url` means the deployment cannot presign**, which is the same graceful degradation
every other presign site takes. There is no proxied pack GET to fall back to — the client filters
those packs out of its listing entirely and bootstraps through the item-granular endpoints. An
`expiresAt` already in the past (a page held too long) has the same effect; the client applies a
30-second clock-skew margin and re-lists to mint fresh signatures when a queued pack ages out
mid-run.

## Deploy Prerequisites and Ordering

This epic adds bindings, queues and migrations that are individually optional, plus one ordering
constraint that is not.

**Per-environment Worker secrets** — `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`. Absent (or
partially set) means no presigned transfers anywhere; everything stays on the proxied paths.

**Per-environment vars** — `R2_S3_ENDPOINT`, `R2_S3_BUCKET`. Neither is declared in
`wrangler.toml`, so both are set out of band per environment. `R2_S3_BUCKET` must match the
`STORAGE` binding's bucket; see the fail-closed note above.

**Optional secret** — `BOOTSTRAP_SESSION_HMAC_KEY`. Absent means typed 501s and zero elevation.

**Queues** — `memry-pack-compaction-staging` and `memry-pack-compaction-production` must exist
before deploying those environments. Queue bindings are **not** inherited from the top-level
`wrangler.toml` block, so each environment wires its own producer and consumer; a missing producer
makes every enqueue a silent no-op and a missing consumer leaves messages unconsumed. The same is
true of the `RATE_LIMITER` Durable Object binding, which is fail-closed — an absent binding 500s
every rate-limited request in that environment. `wrangler.test.ts` asserts all of this against the
TOML.

**Migrations** apply on deploy. There are two independent files numbered 0007 — `0007_pack_index`
and `0007_bootstrap_sessions` — plus `0008_upload_sessions_presigned_chunks`. All three are
additive:

| File                                    | Adds                                                                                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `0007_pack_index`                       | Tables `pack_index`, `pack_watermarks`; indexes `idx_pack_user_vault_cursor`, `idx_pack_user_vault_min`, and `idx_crdt_snapshots_created` |
| `0007_bootstrap_sessions`               | Table `bootstrap_sessions`; indexes `idx_bootstrap_sessions_user_expires`, `idx_bootstrap_sessions_vault`                                 |
| `0008_upload_sessions_presigned_chunks` | Nullable column `upload_sessions.presigned_chunks`, deliberately not backfilled                                                           |

Three new empty tables, five new indexes, one nullable column. Only `idx_crdt_snapshots_created`
touches a pre-existing table — it indexes `crdt_snapshots(user_id, vault_id, created_at)` so pack
selection can scan snapshots above the watermark. A server running the previous code against the
migrated schema behaves exactly as it did.

### Telemetry event schema first, then the desktop build

**The sync-server carrying the new telemetry event schema must be deployed before any desktop build
that emits `sync_bootstrap`.**

The reason is batch-level, not event-level: telemetry events are validated as a batch, and one
unrecognised event name rejects the entire batch with a 400. A desktop build ahead of the server
therefore does not just lose its bootstrap metrics — it loses every other event that happened to
travel with them. Deploying the server first costs nothing, since an event name nothing emits is
inert.

The `sync_bootstrap` event itself is consent-gated through the ordinary telemetry client, fires at
most once per action per bootstrap (backed by a per-minute floor so even a begin/complete loop
cannot spam), and carries three actions — `interactive`, `full_text`, `throughput`. It ships coarse
buckets only (`note_bucket`, `size_bucket`) and never content, titles, paths, ids or keys.

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

| Failure                                 | Behavior                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| Offline                                 | Outbox queues; retry with backoff                                                          |
| Server unreachable                      | Machine still has a link, so requests are retried with exponential backoff, not instantly  |
| Auth expired (401)                      | Refresh the access token and retry the request once; only a failed refresh prompts sign-in |
| Refresh rejected                        | Stop refreshing entirely (see below); prompt the user to sign in again                     |
| Payment required                        | Sync stays local-only until a paid plan is active                                          |
| Client below floor (426)                | Read-only mode; outbox parked; resume after update                                         |
| Platform writes off (403)               | Read-only mode; outbox parked; resume when the switch is flipped back                      |
| Quota exceeded                          | Surfaces in [Settings → Vault](/user-guide/settings#vault)                                 |
| Socket token expiry                     | In-place renewal over the open socket; a rejected renewal falls back to close + reconnect  |
| Server unavailable                      | Exponential backoff; status indicator turns yellow                                         |
| Blob hash mismatch                      | Reject the item; log; alert health view                                                    |
| Vault-key mismatch                      | Stop pulling without branding items; prompt recovery; sign out to restore the correct key  |
| Bootstrap unavailable (404/501/409/429) | No elevated window; steady-state pacing, i.e. pre-#1837 behavior                           |
| Bootstrap renewal refused               | Close locally; pacing reverts on the next chunk                                            |
| Presign unavailable (501)               | Transfers stay on the proxied blob paths                                                   |
| Pack unusable at any stage              | That pack or entry falls back to its item-granular GET; cursor untouched                   |

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

In-flight requests are bounded too. Each one carries the batch's items and key material until it is
answered, so the bridge refuses to hold more than 1,000 at once; past that point requests are
rejected at the door and fall to the main thread, which is the same degradation a wedged worker
already triggers. A sweep runs while requests are outstanding and collects any request that outlived
its own timeout, and it stops itself as soon as nothing is pending, so an idle bridge costs nothing.

Shutting the bridge down asks the worker to exit and waits three seconds before terminating it. A
worker that misses that window is fully detached first, so the exit that terminating eventually
produces cannot land on a bridge that has already been restarted and cancel the new worker's
in-flight batches.

The bridge only listens to the thread it is currently routing to. A message, error, or exit that
arrives from a thread it has already walked away from is ignored, and that thread is disconnected
outright. Without this, the late exit of a terminated worker would take the _live_ worker out of the
rotation — a bridge reporting no worker at all while a healthy thread sat idle, leaving every batch
for the rest of the session on the main thread.

Starting and stopping the bridge are serialised against each other. A start requested while a
shutdown is still running waits for that shutdown to finish and then spawns a fresh thread, instead
of mistaking the thread on its way out for a running one and returning with nothing behind it. For
the same reason a thread that has been asked to exit no longer counts as running, so batches raised
during the shutdown window go straight to the main thread rather than waiting out a request timeout
against a worker that is leaving. This is what keeps a vault switch or a sync restart from ending up
on main-thread crypto for the rest of the session.
