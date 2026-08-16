# CRDT sweep catch-up: why a large vault waits ten minutes

Status: design, not implemented
Date: 2026-08-16
Issue: #1496 · Epic: #1499
Client: `apps/desktop/src/main/sync/engine/full-sync-runner.ts`, `apps/desktop/src/main/sync/engine/crdt-sync-coordinator.ts`, `apps/desktop/src/main/sync/engine/sync-context.ts`
Server: `apps/sync-server/src/routes/sync.ts`, `apps/sync-server/src/services/crdt.ts`
Related: #1466 / #1467 (the storm this pacing was built to stop) · #1449 (the LRU cap the chunk size is bounded by) · #1497 (the endpoint table this design adds a row to)

## Summary

The sweep is slow because it spends one HTTP GET per note per pass on a snapshot
baseline it almost always already has, not because the pacing is aggressive. The
pacing runs at **one sixth** of the real GET budget and **one seventh** of the
real batch budget. It was derived from two premises that are no longer true.

The fix is to make that GET conditional, which the server can enable with an
additive field on a response it already sends. After it, a reconnect sweep of a
1,000-note vault costs **ten requests and no snapshot downloads** instead of
1,000 requests and ~1,000 R2 reads, and finishes in under a minute rather than
ten.

Re-pacing on its own would buy at most 2.7x, would spend the margin that exists
because the last two attempts at this got it wrong, and would not remove a single
wasted byte. The batch snapshot endpoint the issue proposes optimises the one
regime that is not request-bound. Neither is the answer.

---

## 1. What the sweep actually costs today

### 1.1 The request, per note, per pass

The vault-wide sweep drains through `pullCrdtForNotes` →
`applyCrdtBatch` → `applyCrdtBatchChunk`
(`crdt-sync-coordinator.ts:463`, `:236`, `:273`).

For a chunk of N notes, `applyCrdtBatchChunk` does:

| work                                                                     | count               | bucket            |
| ------------------------------------------------------------------------ | ------------------- | ----------------- |
| `applySnapshotBaseline` → `GET /sync/crdt/snapshot/:noteId`              | **N**, one per note | `crdt_pull`       |
| `POST /sync/crdt/updates/batch`, looped while any note reports `hasMore` | **R ≥ 1** per chunk | `crdt_batch_pull` |

So a chunk of 25 costs **26 requests for 25 notes — 1.04 requests per note** in
steady state. The batch endpoint batches the incrementals; it does not batch the
baselines. That is the whole shape of the problem, and it is stated correctly in
the existing comment at `crdt-sync-coordinator.ts:449-456`.

The snapshot GET is **unconditional**. It is issued for every note on every pass:

- for a note whose body has not changed since the last pass,
- for a note this device wrote itself,
- for a note the server has no snapshot for at all, where `getSnapshot` returns
  `null` and the client gets `{ snapshot: null, sequenceNum: 0 }` after a full
  round trip (`sync.ts:792-803`).

`lastAppliedSequence` (`crdt-sync-coordinator.ts:21`) would be enough to know the
GET is redundant, but it is in-memory, cleared by `clearCaches()`, and — more
importantly — the client has no way to learn whether the _server's_ snapshot has
changed without downloading it.

Each of those GETs is not just an HTTP round trip. Server-side it is 2 D1
statements for the rate limiter (`middleware/rate-limit.ts:45-56`), 1 D1 read for
the `crdt_snapshots` row, and **1 R2 Class B read** for the blob
(`services/crdt.ts:263-286`). Client-side it is a base64 decode, a libsodium
`decryptCrdtUpdate`, and a `Y.applyUpdate` of the full document.

A 1,000-note vault on the 15-minute interval sweep therefore burns ~96,000 R2
reads and ~288,000 D1 statements per device per day re-downloading bodies it
already has.

### 1.2 The rate, against the real budgets

`CRDT_SWEEP_CHUNK_NOTES = 25`, `CRDT_SWEEP_CHUNK_INTERVAL_MS = 15_000`
(`sync-context.ts:201-202`), and the chunk is additionally clamped to
`crdtProvider.inactiveDocCapacity = 32` (`full-sync-runner.ts:460-463`,
`crdt-provider.ts:41`), so 25 is what binds.

```
chunks per minute = 60_000 / 15_000            = 4
crdt_pull       per minute = 25 × 4            = 100
crdt_batch_pull per minute =  1 × 4            =   4      (floor; R ≥ 1)
```

Against the budgets, all keyed by `deviceIdentifier` (`sync.ts:476-501`,
`middleware/rate-limit.ts:25-28`):

| bucket            | limit / 60 s | sweep uses | utilisation |
| ----------------- | ------------ | ---------- | ----------- |
| `crdt_pull`       | **600**      | 100        | **16.7 %**  |
| `crdt_batch_pull` | 30           | 4          | **13.3 %**  |
| `crdt_push`       | 300          | 0          | 0 %         |

Duration for V notes: `ceil(V / 25) × 15 s`. V = 1,000 → 40 chunks → **600 s**.
That is the ten minutes in the issue, and it reproduces exactly.

### 1.3 Where 25 / 15s came from, and why it is six times too conservative

The derivation is written out at `sync-context.ts:161-201`. It reads:

> GET budget: 25 x 4 = 100/min per sweeping device, 200 for two devices,
> against 300 — the binding constraint, ~30% spare

Three premises, and none of them holds now:

1. **`crdt_pull` is 600, not 300.** `sync.ts:489-494` sets `maxRequests: 600`.
   `apps/docs/src/architecture/sync-protocol.md:584` already documents 600. The
   300 survives only in this client comment and in the text of #1496 itself.
2. **The bucket is per device, so two devices do not share it.** `crdt_pull`
   passes `identifier: deviceIdentifier`. Doubling for a second device was
   correct under the per-user key — which is precisely what #1467 changed, in the
   same batch of work that introduced this pacing. The doubling was left behind.
3. **The other named consumers are on other buckets.** The comment reserves
   headroom for "the record-change pull, pushes, attachment fetches". Those are
   `sync_changes` (60), `sync_pull` (120), `sync_push` (60) and `crdt_push` (300)
   — separate keys, separate budgets. The only other `crdt_pull` consumers are
   `GET /sync/crdt/snapshot/:noteId` and `GET /sync/crdt/updates` from the
   single-note path: the `crdt_updated` broadcast pull (`engine.ts:756`), the
   pending-note replay (`engine.ts:407`), the reconnect active-editor pulls
   (`engine.ts:804`) and `sweepInactiveCrdtDocs` (`engine.ts:835`, bounded by the
   32-doc LRU, at most once per 5 minutes). Tens of requests per minute in the
   worst case, not hundreds.

**Answer to the question the issue really asks:** the current pacing is _not_
near the limit. It is conservatively far from it — 6x on the binding bucket. So
"just slow down less" is available on paper. It is still the wrong move, and
§4 says why.

### 1.4 Two regimes, and only one of them is the complaint

The issue says "after a sign-in or reconnect", but those are different problems:

- **Warm** — this device has merged this vault's bodies before. Restart,
  reconnect after a Wi-Fi blip, the 15-minute interval sweep, the post-`fullSync`
  sweep. The bodies are already in the local Y.Doc store. Every one of the 1,000
  GETs is redundant. **This is the overwhelmingly common case and it is 100 %
  waste.**
- **Cold** — a new device, a rebuilt store, a restored vault. Every body genuinely
  has to be transferred. The wait is real work.

Today both cost the same ten minutes. Any design that does not separate them is
optimising the wrong thing.

---

## 2. Direction 1 — collapse the per-note snapshot GET

The issue proposes a batch snapshot endpoint. That is one way to collapse the
requests. It is not the best one, and §2.3 evaluates it as asked. The better form
of the same direction is to **not send the request at all when we already have
the snapshot**.

### 2.1 Design: snapshot metadata rides the batch pull

`POST /sync/crdt/updates/batch` already names every note in the chunk and already
does one D1 `batch()` over them (`services/crdt.ts:162-190`). Add one more
statement to that batch, reading `crdt_snapshots` for the same note ids, and
return the metadata alongside the updates.

**Request** — unchanged. `{ notes: [{ noteId, since }], limit }`, cap 100
(`sync.ts:503-518`).

**Response** — one additive top-level key:

```jsonc
{
  "notes": { "<noteId>": { "updates": [...], "hasMore": false } },
  // NEW. Present on every response from a server that supports this.
  // A noteId absent from the map has no server snapshot at all.
  "snapshotMeta": {
    "<noteId>": { "sequenceNum": 42, "revision": "b1c9…", "signerDeviceId": "dev_…" }
  }
}
```

`GET /sync/crdt/snapshot/:noteId` gains the same `revision` field, so a client
that _does_ download a snapshot learns the token it just merged.

**Client rule.** For each note in a chunk, skip `applySnapshotBaseline` when
**both** hold:

1. `snapshotMeta[noteId].revision === merged[noteId].snapshotRevision`, and
2. `merged[noteId].appliedSequence >= snapshotMeta[noteId].sequenceNum`.

When `snapshotMeta` has no entry for the note (no server snapshot), skip
trivially with `since = merged[noteId].appliedSequence ?? 0`. When `snapshotMeta`
is `undefined` on the whole response, the server is old — fetch, exactly as
today.

A note that skips its baseline **is never opened**. That matters: the 32-doc LRU
cap on chunk size (`crdt-sync-coordinator.ts:261`) exists only because a chunk
holds every one of its notes open across an await. A note with nothing to apply
needs no doc, so the probe is not bound by the LRU at all.

This gives a natural two-phase sweep:

- **Probe.** One `POST /sync/crdt/updates/batch` for up to 100 notes (the server
  cap), `since` from the persisted watermark. Notes with no updates and an
  unchanged snapshot revision are finished here: no doc open, no GET, no decrypt.
- **Apply.** Only the notes that actually changed go through today's
  open + baseline + apply path, chunked at 32.

### 2.2 The arithmetic

Margin assumption: never exceed **50 %** of any bucket, leaving the other half
for editor traffic, the un-paced priority batch, broadcast-driven single-note
pulls, and a second sweep a flapping socket may start.

**Warm sweep, nothing changed, V = 1,000.**

```
probe POSTs        = ceil(1000 / 100)              = 10
crdt_pull          = 0
crdt_batch_pull    = 10 POSTs
at 10 POST/min (one per 6 s) → 33 % of 30/60s      → 60 s
at 15 POST/min (one per 4 s) → 50 % of 30/60s      → 40 s
```

**1,000 notes in 40–60 seconds, zero snapshot GETs**, against ten minutes and
1,000 GETs today. Traffic goes _down_ while the wall clock goes down 10x.

**Warm sweep, k notes changed.** Probe as above, then `ceil(k/32)` apply chunks
costing k GETs and `ceil(k/32)` POSTs. k = 20 → one extra chunk, a few seconds.

**Cold sweep, V = 1,000, everything must be downloaded.**

```
probe POSTs        = 10   (not wasted — they carry the incrementals too)
snapshot GETs      = 1000
apply POSTs        = ceil(1000 / 32)               = 32
binding bucket     = crdt_pull, 600/60s
at 300 GET/min (50 %): 32-note chunks → 9.4 chunks/min → interval 6.4 s
                        POST rate 9.4/min = 31 % of 30/60s
duration           = 1000 / 300                    ≈ 3 min 20 s
```

Cold drops from ten minutes to about three and a half, and the remaining time is
genuine body transfer. Note this improvement comes from the **re-pace**, which is
only safe _because_ the warm sweep no longer competes for the same bucket — it is
a later PR, not the headline.

For comparison, a chunk of 32 at the current 15 s interval would still be 8 min
cold; and the same 32/6.4 s pacing _without_ the conditional skip would put every
warm 15-minute interval sweep at 300 GET/min forever, which is exactly the
sustained pressure §1.3's margin is supposed to absorb.

### 2.3 The literal batch snapshot endpoint, evaluated

Designed out, as the issue asks:

- **Route.** `POST /sync/crdt/snapshots/batch`.
- **Request.** `{ noteIds: string[] }`, `min(1).max(25)` — matched to the 32-doc
  LRU chunk, not the 100-note batch-pull cap, because every returned snapshot has
  to be applied to an open doc.
- **Response.** `{ snapshots: { [noteId]: { snapshot: b64 | null, sequenceNum, signerDeviceId } }, truncated: string[] }`.
- **Rate-limit class.** Its own bucket, `crdt_batch_snapshot`, ~30/60 s per
  device. It must not share `crdt_pull` (one call replaces 25 of them, so a
  shared bucket would price it wrong) and must not share `crdt_batch_pull` (the
  same sweep spends that on incrementals).
- **The cap is a byte cap, not just a count cap.** `MAX_UPDATE_BYTES` is 5 MB
  (`sync.ts:134`), so 25 snapshots is up to 125 MB raw, ~167 MB base64, and the
  handler builds that as one JS string before `c.json()`. A Worker gets 128 MB.
  The endpoint therefore needs a running byte budget (~8 MB, matching the
  documented `/sync/*` body cap) that stops adding snapshots and returns the rest
  in `truncated`, plus a client fallback to the per-note GET for those. That is a
  partial-response protocol, and partial-response protocols in this codebase are
  where the data-loss bugs live.
- **Fan-out.** 1 D1 query + 25 R2 GETs per call, which must be `Promise.all`'d or
  25 × ~30 ms of serial latency lands in one request.
- **Old client.** Never calls it; the per-note GET stays. Zero compat risk. That
  is its one genuine virtue.

**Verdict: do not build it.** It saves 24 of every 25 requests in the cold
regime, which is the one regime where requests are _not_ the constraint — the
budget is 600/min and we would be using 100. It does not save a single byte, and
bytes plus client-side decrypt are what actually make cold slow. It does nothing
at all for the warm regime, which is the case in the issue's title. And it buys
that with a new endpoint, a new bucket, a memory cliff and a truncation path.

### 2.4 The revision token — why `sequenceNum` cannot be it

`storeSnapshot` pins the watermark: `sequenceNum = existingSnapshot?.sequence_num ?? currentSeq`
(`services/crdt.ts:214`), with the comment explaining why. So the second and
every later snapshot for a note **keeps the same `sequence_num`** while replacing
the blob. `sequence_num` is therefore useless as a change signal, and using it
would silently pin every device to the first snapshot a note ever had. This is
the single easiest way to get this design wrong.

`created_at` is updated on conflict, but at 1-second resolution, and
`(created_at, size_bytes, signer_device_id)` can collide for two pushes of the
same note in the same second from the same device at the same ciphertext length.
The consequence of a collision is a permanently stale body — the exact bug class
this subsystem keeps producing. Not acceptable as the primary token.

**Proposed:** add `revision TEXT NOT NULL DEFAULT ''` to `crdt_snapshots`, set to
a fresh `crypto.randomUUID()` on every `storeSnapshot` (including the
`ON CONFLICT DO UPDATE` branch). Random rather than a counter, so a row deleted
and recreated — vault deletion, account recreation — cannot collide with a token
a client still holds.

**No backfill migration.** Existing rows keep `''`. The server coalesces at read
time to `legacy:${id}:${created_at}:${size_bytes}`, which is deterministic per
row and changes on any rewrite — and any rewrite also assigns a real random
revision, so a row is legacy at most until its next snapshot push. This avoids a
single `UPDATE` over what could be millions of rows inside a D1 migration.

Zero-migration alternative, recorded and rejected: add `id = excluded.id` to the
`DO UPDATE SET` clause and use `id` as the revision, since it is already a fresh
`crypto.randomUUID()` per store and nothing references it (checked: only the
INSERT in `services/crdt.ts:230`, plus the `PRAGMA table_info` assertion in
`schema/d1.test.ts:188`; no foreign key). Rejected because it silently changes
`id` from a row identity to a version token, which the next reader of that table
will not expect.

### 2.5 Failure modes

**FM1 — the token fails to change when the blob does.** A client skips a snapshot
it needed and keeps a stale body forever. This is the design's central risk.
Mitigation: the revision is assigned unconditionally on every write path, and the
test for it must be **mutation-verified** — remove the revision bump from the
`ON CONFLICT` branch and the test has to go red. Green unit tests over broken
behaviour is the documented failure mode of this whole subsystem (#1499).

**FM2 — the watermark outlives the document.** If the client records "merged to
seq N, revision R" but the local doc no longer contains that state — LRU eviction
mid-batch (#1449), a quarantined store, a rebuilt or re-pathed store (#1490,
#1491) — it will skip the snapshot forever against a doc that never had it.
**Mitigation, and this is non-negotiable: the watermark lives inside the per-vault
CRDT store, so "the store is gone" implies "the watermark is gone".** It must not
live in the index DB, in `store` (electron-store), or anywhere with an
independent lifetime. Anything that quarantines, rebuilds or re-paths the store
must drop it in the same operation. Losing a watermark is free — you pay one
extra GET. Keeping a stale one loses a note body.

**FM3 — `since` below the prune watermark.** `pruneUpdatesBeforeSnapshot` deletes
every update `<= snapshot.sequence_num` (`sync.ts:733`, `services/crdt.ts:288`).
A skipped snapshot whose `since` sits below that watermark would ask for a range
the server has already deleted and get silence. Condition (2) of the skip rule —
`appliedSequence >= snapshotMeta.sequenceNum` — is exactly what forbids that, and
it needs its own test rather than being an implied consequence of (1).

**FM4 — a wrong "merged" answer reaches the snapshot push.** `applyCrdtIncrementals`
returns whether the server state was fully merged, and the pending-note replay
acts on it by pushing a snapshot (`runtime.ts:706-710` →
`engine.mergeRemoteCrdtForNote` → `pullCrdtForNote`). A snapshot push is an
assertion that the pushed state contains everything the server has, and the server
responds by deleting the peer's incrementals. A `true` that came from a
conditional shortcut, on top of a broken watermark, destroys another device's
edits.

**Mitigation, structural rather than careful: the conditional skip lives only
inside `applyCrdtBatchChunk`. `applyCrdtIncrementals` stays unconditional.**
This costs nothing, because every caller of the single-note path is low volume —
the replay, the `crdt_updated` broadcast pull, the reconnect active-editor pulls,
and `sweepInactiveCrdtDocs` (≤ 32 notes, ≤ once per 5 min). The sweep is the only
high-volume consumer and it is the only one that changes. The dangerous path
never takes the shortcut, by construction.

**FM5 — a snapshot row whose blob is missing.** `getSnapshot` returns `null` when
the D1 row exists but `getBlob` misses (`services/crdt.ts:281-282`). Then
`snapshotMeta` advertises revision R while the GET yields nothing, the client
returns 0, and the note falls into the existing seed-from-markdown branch. That is
today's behaviour and it is unchanged — but the client must **not** record a
watermark for a snapshot it never actually received.

**FM6 — the probe reports "nothing changed" for a note the local doc never had.**
A note present in `noteCache` but absent from the local CRDT store, with no
persisted watermark, has `merged[noteId] === undefined`, so condition (1) fails
and the baseline is fetched. Correct by default — but the default must be
_fetch_, and every unknown must fall to it.

### 2.6 Compat plan

Deploy order is fixed: sync-server first, then desktop.

- **New server + old client** (the window created by the deploy order). The
  request shape is unchanged. `snapshotMeta` and the new `revision` on
  `GET /sync/crdt/snapshot/:noteId` are additive response fields. The client
  reads batch responses through `postToServer<CrdtBatchPullResponse>`
  (`http-client.ts`), which is a TypeScript cast with **no runtime schema
  validation** — the server's zod covers requests only (`sync.ts:655`). Extra
  keys are ignored. Verified, not assumed.
- **New client + old server.** `snapshotMeta === undefined` on the response →
  never skip → today's behaviour exactly. This must be a real code path with a
  real test, not a theoretical one: staging, self-hosted, and a rolled-back
  server deploy all produce it.
- **New client, first run against a new server.** No persisted watermarks yet, so
  the first sweep is a full cold sweep. Expected, once.
- **D1.** `revision TEXT NOT NULL DEFAULT ''` is additive with a default; old
  server code never reads or writes it; `schema/d1.test.ts:188` asserts the
  column set and must be updated in the same PR.
- **Rate-limit classes.** Unchanged. No new bucket, no changed limit.
- **Editing signed out / offline / with no account.** Untouched. Everything here
  is inside the sweep, which does not run without a session, and the local Y.Doc
  is already independent of the session (`f89d23ed5`).

---

## 3. Direction 2 — prioritise recently-opened notes

### 3.1 What already happens

`flushPendingCrdtPulls` (`full-sync-runner.ts:401-431`) splits the drained
pending set into notes with a **live editor**, which bypass the pace entirely,
and everything else, which goes into `pacedCrdtPullQueue`. So tier 1 exists.

Everything else arrives in whatever order `getAllCrdtNoteIds` returns, which is
an unordered `SELECT id FROM note_cache WHERE file_type = 'markdown'`
(`note-crud.ts:277-284`) — effectively rowid order, i.e. index-build order.

Order is preserved end to end, which is the useful part: `pendingPulls` is a
`Set`, `drainPendingPulls` is `Array.from` on it, `pacedCrdtPullQueue` is a `Set`,
and the chunk is taken by iterating it. Insertion order _is_ priority. So this
direction is an ordering change at the source and nothing else.

### 3.2 Design

Three tiers instead of two:

1. **Live editors** — as today, un-paced.
2. **Open-but-inactive docs** — `crdtProvider.getOpenNoteIds()` minus the active
   set, at the front of the paced queue. This is free and it is the best
   available proxy: the 32-doc LRU _is_ a recently-opened list of exactly 32
   notes, already in memory, already the notes a user is one click from.
   Currently they get no priority at all.
3. **The rest of the vault, ordered `modifiedAt DESC`** — one `ORDER BY` on
   `getAllCrdtNoteIds`. `note_cache.modifiedAt` already exists
   (`note-crud.ts:290` uses it). A note that changed recently — by this user or by
   the device we are catching up with — is the one most likely to be opened next
   and the one most likely to actually be stale.

No new schema, no new requests, no protocol change. `searchReasons.visitedAt`
exists but is search-only, capped at 20 rows, and lives in the data DB
(`ipc/search-handlers.ts:132-207`) — not worth reaching for over tier 2.

### 3.3 Arithmetic

None. Zero change to request count, request rate, or duration. The budgets in
§1.2 are untouched.

### 3.4 Failure modes

- **A vault whose mtimes are uniform** — restored from backup, freshly cloned,
  bulk-imported. Ordering degrades to arbitrary, i.e. exactly today's behaviour.
  No regression.
- **Correctness of the sweep is unaffected.** The sweep stays exhaustive; only
  the order changes. The invariant documented at `full-sync-runner.ts:112-128` —
  no note is ever excluded from a sweep that runs — is preserved, and any
  implementation must keep it. Priority must never become filtering.
- **Failed notes go to the back.** `owePendingPull` re-adds to `pendingPulls`, so
  a re-queued note lands at the end of the _next_ drain. That is correct and
  should stay: a note that just failed is the worst candidate for a front-of-queue
  retry.

### 3.5 Compat

None needed. Client-only, no protocol, no schema, no persisted state.

### 3.6 Honest assessment

This changes perceived latency and nothing else. On its own it does not shorten
the ten minutes, does not reduce cost, and does not remove one redundant request.
After direction 1 lands, the warm sweep finishes in under a minute, so ordering
stops mattering there and matters only for cold catch-up — where it matters a
lot, because cold is where the three and a half minutes of real transfer sits.

It is also the cheapest change in this document by a wide margin, and it is
independent of everything else.

---

## 4. Recommendation

### 4.1 Do direction 1, in its conditional form

**First PR — server only, inside `apps/sync-server`, inert on its own.**

1. Migration `0005_crdt_snapshot_revision.sql`: `ALTER TABLE crdt_snapshots ADD COLUMN revision TEXT NOT NULL DEFAULT ''`.
2. `storeSnapshot` assigns `crypto.randomUUID()` to `revision` on insert **and**
   in the `ON CONFLICT DO UPDATE SET` branch.
3. `getSnapshot` returns `revision`, coalescing `''` to
   `legacy:${id}:${created_at}:${size_bytes}`.
4. New `getBatchSnapshotMeta` reading `(note_id, sequence_num, revision, created_at, size_bytes, signer_device_id)` for the batch's note ids, folded into the existing
   `db.batch()` in `getBatchUpdates` — one extra statement, no extra round trip.
5. `handleCrdtBatchPull` returns `snapshotMeta`; `handleCrdtSnapshotPull` returns
   `revision`.
6. Tests: `services/crdt.test.ts` and `schema/d1.test.ts`, with the revision bump
   mutation-verified per FM1.

Why this is the right first PR: it is the enabling change, it is entirely inside
the one area no other agent holds, it respects the sync-server-before-desktop
deploy order, it is behaviour-neutral for every existing client, and it can sit
deployed and unused indefinitely with no risk.

Its honest weakness: **on its own a user feels nothing.** If the goal is one PR
that a user can feel, the alternative first PR is §3 — small, independent, no
protocol change — but it moves perceived latency only.

**Then, in order:**

- **PR 2 (client, in-memory).** Conditional skip inside `applyCrdtBatchChunk`
  keyed on the in-session `lastAppliedSequence` plus a session-scoped revision
  map. `applyCrdtIncrementals` untouched (FM4). This alone fixes the reconnect and
  15-minute-interval sweeps within one process — no persistence, no FM2 exposure.
- **PR 3 (client, persistence).** Persist `{ appliedSequence, snapshotRevision }`
  per note **inside the per-vault CRDT store**, dropped with it. This is what
  fixes catch-up after an app restart or a fresh sign-in, and it is the PR that
  carries FM2. It should not be merged without an explicit test that quarantining
  or re-pathing the store also clears the watermarks.
- **PR 4 (client, pacing).** Re-derive `CRDT_SWEEP_CHUNK_NOTES` /
  `CRDT_SWEEP_CHUNK_INTERVAL_MS` from §2.2, rewrite the comment at
  `sync-context.ts:161-201` against the real budgets, and split the probe pace
  (100 notes / batch bucket) from the apply pace (32 notes / GET bucket).
- **PR 5 (client, independent).** §3's three-tier ordering. Can land at any point,
  including first; it touches only `note-crud.ts` and `full-sync-runner.ts`.
- **Docs.** `apps/docs/src/architecture/sync-protocol.md` — `snapshotMeta` and
  `revision` in the endpoint table, which also closes part of #1497.

### 4.2 What I would not do, and why

- **Not the batch snapshot endpoint.** §2.3. It optimises requests in the one
  regime that is not request-bound, does nothing for the warm regime, and needs a
  byte-cap truncation protocol to stay inside a Worker's 128 MB.
- **Not re-pace on its own.** 32 notes / 7 s is 274 notes/min → 3.6 min for 1,000,
  a 2.7x improvement for a two-constant diff. But it is 300 GET/min _sustained_,
  every 15 minutes, forever, for traffic that is ~100 % redundant in the warm
  case; it drops POST headroom from 7.5x to ~1.6x, and the POST count is a floor,
  not an exact count (`sync-context.ts:191-197`). The issue says "design work, not
  tuning", and it is right: pacing is not the defect, the wasted request is.
  Re-pacing is correct _after_ the waste is gone, which is why it is PR 4.
- **Not raise the server rate limits.** They are already 6x above what the sweep
  uses. Raising them would answer a question nobody asked.
- **Not make the sweep selective.** The sweep is the only channel by which a
  body-only remote edit reaches a device that missed the broadcast — note bodies
  never travel in the record feed (`full-sync-runner.ts:112-128`). Skipping notes
  by heuristic converts a slow catch-up into a silent one. Prioritise, never
  filter.
- **Not parallelise the per-note snapshot GETs within a chunk.** That is
  precisely the 242-requests-in-4-seconds burst of #1466, which had 92 of 121
  notes come back 429 and silently keep stale bodies.
- **Not use `sequence_num` as the change token.** §2.4. It is pinned at the first
  snapshot and never advances.
- **Not put the watermark in the index DB or electron-store.** FM2. It must share
  the CRDT store's lifetime or it becomes a data-loss vector.
- **No polling.** Everything above is driven by the existing sweep triggers.

### 4.3 Deserves its own issue

- **The stale 300 in `sync-context.ts:161-201`.** The comment is load-bearing —
  it is the stated derivation for the pacing constants — and three of its premises
  are wrong. Worth fixing on its own even if nothing else here is built, because
  the next person to touch the pacing will read it and trust it.
- **The warm sweep's standing cost.** Independent of latency, a 1,000-note vault
  re-downloads and re-decrypts every body every 15 minutes per device: ~96,000 R2
  Class B reads and ~288,000 D1 statements per device per day. That is a billing
  and a battery issue, not just a wait, and it justifies direction 1 on its own.
