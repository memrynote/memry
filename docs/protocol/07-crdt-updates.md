# 07 — CRDT updates

**Status**: normative. Every normative sentence carries a `path:line` citation
(chapter 00 §0.1).

Note and journal **bodies** travel here. A record push for a body edit carries
`content: null` (`packages/sync-client/src/pull/crdt-pull.ts:9-10`), so a client
that implements only the record feed (chapter 05) never sees a body change. A
client that declares `note_body` also receives the body rows stored here in
`GET /sync/changes` (§7.17; the Rust core since #2304, §7.17.4, and desktop
since #2297 on runs past cursor 0, §7.17.5); the routes below
are unchanged either way.

## 7.1 A journal body is a CRDT document — Q07.1

**Normative.** A journal body is a collaborative document in the **same CRDT feed
as a note**. **Its document id is the journal record's `id`.**

Desktop mints that id as `j<YYYY-MM-DD>` when it creates a day
(`apps/desktop/src/main/lib/id.ts:20`), but an existing canonical row's id wins
(`apps/desktop/src/main/journal/create-entry.ts:40-46`:
`canonical?.id ?? cached?.id ?? generateJournalId(date)`).

**A client MUST use the id carried by the `journal` record and MUST NOT derive
the document id from the date when a record exists.**

**The CRDT wire carries no item type at all.** The server does not distinguish
notes from journals: `NoteIdSchema` is `/^[a-zA-Z0-9_-]+$/` capped at 128
characters (`apps/sync-server/src/routes/sync.ts:571-574`), which `j2026-08-13`
satisfies, and every CRDT route treats `note_id` as an opaque string.

Supporting evidence: journals are `note_metadata` rows on the note clock path
(`packages/sync-client/src/offline-clock.ts:325-328`); the Y.Doc opens under that
id (`apps/desktop/src/main/journal/runtime-effects.ts:23-33`); pull routes both
`note` and `journal` records into the CRDT body feed
(`packages/sync-client/src/pull/engine.ts:305`); `journalHandler` defers
concurrent body merges to the CRDT
(`apps/desktop/src/main/sync/item-handlers/journal-handler.ts:57-64`) and purges
the Y.Doc on a remote delete (`:175-181`).

### 7.1.0 Minting a note id

§7.1 settles the journal id and the grammar, and stopped there: nothing said how
a **note** id is minted, so a port had to invent a scheme and two ports would
have invented different ones.

Desktop mints a note id as **12 characters drawn from `0123456789` plus `a-z`**,
lowercase only, via `nanoid`'s `customAlphabet`
(`apps/desktop/src/main/lib/id.ts:13-14`). The observed ids on a real account —
`dzxnhc9p3gk3` — are exactly that. Tasks and projects use a different generator:
plain 21-character URL-safe `nanoid` (`:7`).

**Normative, and narrower than it looks.** A note id MUST satisfy
`NoteIdSchema`, `/^[a-zA-Z0-9_-]+$/` capped at 128 characters; that is the only
constraint the wire enforces, and a client MUST accept any id meeting it. The
12-character lowercase form is what desktop **writes**, and a client that mints
its own note ids SHOULD match it so the two are indistinguishable in a vault —
but a client MUST NOT reject an id that does not, because journal ids
(`j2026-08-13`) do not, and neither would an id from any future shell.

**A core that is handed an id MUST validate it against the grammar rather than
mint a replacement.** Replacing a caller's id is how the same note becomes two.

### 7.1.1 The constants (#2186, fixed)

`CRDT_SYNC_ITEM_TYPES` was `['note']` and is now `['note', 'journal']`
(`packages/contracts/src/sync-api.ts:101`), with `CrdtSyncItemType` (`:173`)
derived from it. The dead `EncryptedCrdtItem` / `EncryptedCrdtItemSchema` pair
was removed in the same change (chapter 04 §4.12.1).

**Decision, 2026-09-13 — correct the constants; do not scope them.**
"Record-envelope-scoped only" would have been a false statement: the record
envelope's type set is `ENCRYPTABLE_ITEM_TYPES`
(`packages/contracts/src/crypto.ts:166`), which already contains `journal`
(`packages/contracts/src/sync-api.ts:144`).

Neither constant scopes anything at runtime — the CRDT wire carries no item type
— so this is a correctness fix for clients reading the contract, not a wire
change. Both are pinned by
`packages/contracts/src/sync-api.test.ts:89-92`.

**Disposition of Q07.1: answered (decision applied, #2186).**

## 7.2 Routes

**Normative** (`apps/sync-server/src/routes/sync.ts:1139-1144`), all under
`/sync/crdt`:

| Method | Path                          | Purpose                                                    | Line    |
| ------ | ----------------------------- | ---------------------------------------------------------- | ------- |
| POST   | `/sync/crdt/updates`          | append updates for one document                            | `:1139` |
| GET    | `/sync/crdt/updates`          | pull updates for one document: `note_id`, `since`, `limit` | `:1140` |
| POST   | `/sync/crdt/updates/batch`    | pull updates for up to 100 documents                       | `:1141` |
| POST   | `/sync/crdt/snapshot`         | write one snapshot                                         | `:1142` |
| POST   | `/sync/crdt/snapshot/batch`   | write up to 50 snapshots                                   | `:1143` |
| GET    | `/sync/crdt/snapshot/:noteId` | read the snapshot                                          | `:1144` |

Every route sits behind the paid gate and the sync-types middleware
(`apps/sync-server/src/routes/sync.ts:142-143`).

## 7.3 Limits

**Normative:**

| Limit                                | Value                                                         | Source                                             |
| ------------------------------------ | ------------------------------------------------------------- | -------------------------------------------------- |
| `MAX_UPDATE_BYTES`                   | 5 MiB **decoded, per individual update**                      | `apps/sync-server/src/routes/sync.ts:145`          |
| updates per push                     | 100, each base64 string capped at `MAX_UPDATE_BYTES * 2`      | `apps/sync-server/src/routes/sync.ts:642`          |
| documents per batch pull             | 1 to 100, **duplicate ids rejected**                          | `apps/sync-server/src/routes/sync.ts:623-636`      |
| updates per document in a batch pull | `limit`, 1 to 100, default 100                                | `apps/sync-server/src/routes/sync.ts:637`          |
| updates per single-document pull     | `min(limit, 500)`                                             | `apps/sync-server/src/routes/sync.ts:781`          |
| snapshots per batch push             | 1 to 50, **duplicate ids rejected**                           | `apps/sync-server/src/routes/sync.ts:660-673`      |
| client batch size                    | `CRDT_BATCH_MAX_NOTES = 100`, `CRDT_UPDATES_PAGE_LIMIT = 100` | `packages/sync-client/src/pull/crdt-pull.ts:26-27` |
| `/sync/*` request body ceiling       | 8 MiB                                                         | `apps/sync-server/src/index.ts:56-62`              |

The 50-document snapshot batch size is chosen because a snapshot is up to 5 MB
decoded, roughly 6.7 MB of base64, and a full batch is the largest request the
Worker body limit and subrequest budget comfortably take
(`apps/sync-server/src/routes/sync.ts:650-654`).

**`snapshot` is deliberately unbounded in the batch schema**
(`apps/sync-server/src/routes/sync.ts:656-658`): an oversized payload is a
**per-note failure reported in `results`**, not a 400 that throws away the 49
good notes riding with it.

### 7.3.1 Why the two update caps differ — Q07.5

The single-document pull caps at `min(limit, 500)`
(`apps/sync-server/src/routes/sync.ts:781`); the batch form caps at 100 per
document (`apps/sync-server/src/routes/sync.ts:637`).

**Normative: they are scoped differently and both are correct.** The batch form
multiplies its per-document limit by up to 100 documents against one 8 MiB body
ceiling (§7.3), so a 500-per-document batch could ask for 50 000 updates in one
response; the single-document form has no such multiplier. **A new client SHOULD
use the batch form with the default 100 for a sweep, and the single-document form
with a higher limit only when draining one document's backlog.** Both are
conforming; neither cap may be exceeded.

**Disposition of Q07.5: answered** (this section).

## 7.4 Sequence numbers

**Normative.** The server assigns them; **a client never proposes one**. A new
update takes `COALESCE(MAX(sequence_num), 0) + 1` over the **union** of
`crdt_updates` **and** `crdt_snapshots` for that document
(`apps/sync-server/src/services/crdt.ts:139-146`, and the same union at `:99-104`
for the current maximum), so **a snapshot consumes a sequence number in the same
space**.

Every update and every snapshot write also takes a `server_cursor` from the
user's record cursor sequence, in the same D1 batch (§7.17). `sequence_num` is
still assigned exactly as above, forever; the cursor is an additional column,
not a replacement.

### 7.4.1 The request and response shapes

**Normative.** §7.2's table names these routes and §7.3 bounds them, but the
bodies were never written down — the same gap chapter 05 §5.11.1 was written to
close. A port must not have to read the server to send a page request.

**`GET /sync/crdt/updates`** — query `note_id`, `since`, `limit`.
Response: `{ updates: [...], hasMore: boolean }`, **at the top level**. There is
no `notes` wrapper on the single-document form; that belongs to the batch.

**`POST /sync/crdt/updates/batch`** — request
`{ notes: [{ noteId, since }], limit }`. At most **100** entries, duplicate
`noteId`s **rejected outright** rather than de-duplicated, `since` defaulting to
0 and `limit` an integer 1 to 100 defaulting to 100.
Response: `{ notes: { <noteId>: { updates, hasMore } } }`, keyed by id — which
is why the single form's flat shape above is worth stating separately.

**`POST /sync/crdt/snapshot`** — request `{ noteId, snapshot }`, the snapshot
being the base64 packed envelope. Response `{ sequenceNum, revision }`
(`apps/sync-server/src/routes/sync.ts:951`), the `revision` being the token the
upsert just wrote (§7.13.4).

**`POST /sync/crdt/snapshot/batch`** — request
`{ snapshots: [{ noteId, snapshot }] }`, at most **50**, the lower cap because
a snapshot may be 5 MiB decoded and roughly 6.7 MiB as base64. `snapshot` is
deliberately unbounded per entry: an oversized payload is a per-note rejection,
not a malformed batch. Response `{ results: [...] }`, one entry per request
entry in request order, each `{ noteId, accepted: true, sequenceNum, revision }`
or `{ noteId, accepted: false, reason }`
(`apps/sync-server/src/services/crdt.ts:410-412`).

`POST /sync/crdt/updates` takes
`{ noteId: string, updates: string[] }` — the updates being base64 packed
envelopes (chapter 04 §4.11), **at most 100 per call**, each capped at twice
`MAX_UPDATE_BYTES` in its base64 form because base64 inflates by four thirds
and the cap is applied to the encoded string. It answers `{ sequences: number[] }`
(`apps/sync-server/src/routes/sync.ts:748`).

**The update store is idempotent per document** (#2296). The server stores the
SHA-256 of each update's bytes and ignores a second insert of the same bytes for
the same document (migration `0012_crdt_update_hash.sql`, a unique index on
`(user_id, vault_id, note_id, update_hash)`). A retried push therefore stores
nothing new and answers the sequence number the stored row already has, so the
response is the one the first attempt would have returned; the same bytes twice
in one request answer the same number twice. Storage is charged once: before
writing, the server looks up which of the request's hashes the document already
holds and reserves quota only for the rest, so a retry is answered even when the
quota filled up after the first attempt
(`apps/sync-server/src/services/crdt.ts:144-278`). Every packed envelope carries
a fresh nonce (chapter 04 §4.11), so identical bytes are a retry, never a new
edit. Rows written before the migration have no hash and are never matched.

## 7.5 Snapshot revision

**Normative.** A fresh `crypto.randomUUID()` on **every** snapshot write, insert
and conflict alike, and **never conditional on whether the bytes changed**
(`apps/sync-server/src/services/crdt.ts:335`, applied by the upsert at `:315-318`).

The reason is on record: a revision that fails to move when the blob moves leaves
a client skipping a snapshot it needed, with a stale body forever
(`apps/sync-server/src/services/crdt.ts:332-334`).

Rows written before `revision` existed carry `''` and are coalesced to a
synthetic `legacy:<id>:<created_at>:<size_bytes>`, so an old snapshot is not
re-downloaded forever
(`apps/sync-server/src/services/crdt.ts:77-89`).

**A client MUST treat `revision` as an opaque token and MUST compare it only for
equality.**

## 7.6 Snapshot watermark stability

**Normative.** Once a snapshot exists for a document, its `sequence_num` **stays
put** across subsequent snapshot writes: the upsert reuses
`existingSnapshot?.sequence_num ?? currentSeq`
(`apps/sync-server/src/services/crdt.ts:348`).

The reason is on record: client-uploaded snapshots carry no causal metadata
proving they already contain every server update above the prior watermark, so
keeping the watermark stable keeps later incrementals pullable
(`apps/sync-server/src/services/crdt.ts:345-347`).

## 7.7 Pruning is server-side

**Normative.** `DELETE FROM crdt_updates WHERE user_id = ? AND vault_id = ? AND
note_id = ? AND sequence_num <= ?`
(`apps/sync-server/src/services/crdt.ts:703`, driven by
`pruneUpdatesBeforeSnapshot` at `:705`), with a batch form that runs every SUM
ahead of every DELETE inside one D1 transaction
(`apps/sync-server/src/services/crdt.ts:749`).

**A client does no pruning of the server's log.**

## 7.8 The client's baseline rule

**Normative** (`packages/sync-client/src/pull/crdt-pull.ts:161-166`). Fetch the
snapshot first when:

- the cursor is `0`; **or**
- the server advertises a snapshot whose `sequenceNum` is **ahead of the cursor**
  **and** whose `revision` **differs** from the locally stored one.

Otherwise pull incrementals from `since = cursor`.

The rule exists precisely because of pruning (§7.7): updates at or below the
snapshot watermark are answered with silence, so a `since` under the watermark
MUST take the snapshot first
(`packages/sync-client/src/pull/crdt-pull.ts:155-160`). **When an old server
advertises no `snapshotMeta` at all and the cursor is not 0, the reference does
not fetch** (`:166`, the `: false` branch).

After a baseline the client stores the snapshot with its sequence number and
revision (`packages/sync-client/src/pull/crdt-pull.ts:191-196`) and advances the
cursor only if the snapshot's sequence number is ahead (`:197-199`).

## 7.9 Incremental application rules

**Normative** (`packages/sync-client/src/pull/crdt-pull.ts:225-250`):

- an update whose `sequenceNum <= cursor` is **skipped as a replay** (`:226`);
- each accepted update is decrypted, persisted, and the watermark advanced and
  written **per update, not per page** (`:246-248`);
- **on an unresolvable signer the document's pull stops at that update** and the
  watermark is not advanced past it, so a later pass retries (`:227-237`).

That last rule is a deliberate deviation from desktop, which advances past the
gap and owes the document a re-pull
(`packages/sync-client/src/pull/crdt-pull.ts:20-23`). **A conforming client MUST
take the stop-at-gap side**: it is the only one under which no update can be
skipped permanently.

## 7.10 Retry policy and rate limits

**Normative.** Every CRDT request uses `maxRetries: 3`, `baseDelayMs: 2000`,
`retryOn429: false`
(`packages/sync-client/src/pull/crdt-pull.ts:70-76`).

**CRDT rate limits are per device, not per account**, because body sync is
device-local work (`apps/sync-server/src/routes/sync.ts:582-620`):

| Bucket            | Limit                     |
| ----------------- | ------------------------- |
| `crdt_push`       | 300 per 60 s (`:583-585`) |
| `crdt_pull`       | 600 per 60 s (`:605-607`) |
| `crdt_batch_pull` | 30 per 60 s (`:616-618`)  |

### 7.10.1 The client push outbox (#2298)

Client-side only; the wire shape is the §7.4.1 update push, unchanged.

**A client MUST make every local update durable before it is considered
queued**, and MUST NOT drop it until a push carrying it has succeeded. Desktop
writes one `sync_queue` row per Yjs update, `type = 'note_body'`, payload the
base64 update, append-only (`packages/sync-client/src/queue.ts:400`). Rows are
never coalesced into each other: the record queue's coalescing overwrites the
payload, which for updates would keep only the last unflushed one. The record
push (chapter 05) never dequeues these rows
(`packages/sync-client/src/queue.ts:51`).

**Flush.** Per document, the outbox reads its rows in enqueue order, packs them
into `Y.mergeUpdates` runs of at most 256 KiB, sends up to 512 KiB per flush to
`POST /sync/crdt/updates`, and deletes exactly the rows it sent once the push
succeeds (`apps/desktop/src/main/sync/note-body-outbox.ts:24-26`, `:189`,
`:206`, `:262`). Rows enqueued
while a push is in flight stay queued. A push that succeeds but whose ack is
lost to a crash is sent again; applying an update twice is a Yjs no-op.

**Pacing.** A document's first update after a quiet second flushes at once;
later ones wait for one trailing flush per second
(`apps/desktop/src/main/sync/note-body-outbox.ts:19`, `:152`). A 429 holds
**every** document until `Retry-After`, because `crdt_push` is one per-device
bucket (§7.10; `note-body-outbox.ts:235`). A 401 or a storage-quota 413 pauses
the outbox until a token refresh or reconnect resumes it; any other 4xx drops
the rows it sent.

**Full-state rows.** A `note_body` row with an empty payload owes the
document's whole state: edits made while no sync runtime ran (signed out,
unpaid), a note leaving local-only, and ids imported once from the pre-#2298
`crdt-pending-notes.json` (`note-body-outbox.ts:295`). The client merges the
server's state for that document first, then pushes `Y.encodeStateAsUpdate(doc)`
as an update, one document at a time (`note-body-outbox.ts:76`;
`apps/desktop/src/main/sync/runtime.ts:957-965`); a merge that does not
complete keeps the row. State too large for the incremental route goes to the
snapshot endpoint under the §7.13.2 gate.

## 7.11 Wire shapes

**Normative** (`packages/sync-client/src/pull/crdt-pull.ts:29-46`):

- an update entry is `{ sequenceNum, data, createdAt, signerDeviceId }`, where
  `data` is base64 of the **packed envelope** of chapter 04 §4.11;
- the batch response is
  `{ notes: Record<noteId, { updates, hasMore }>, snapshotMeta?: Record<noteId,
{ sequenceNum, revision, signerDeviceId }> }`;
- the snapshot response is
  `{ snapshot, sequenceNum, signerDeviceId, revision? }`, with `snapshot` null
  when absent.

**A document absent from `snapshotMeta` has no server snapshot at all**
(`apps/sync-server/src/services/crdt.ts:292-305` populates the map only from rows
that exist).

**Snapshots use the identical packed envelope as updates. There is no separate
snapshot envelope** (`apps/desktop/src/main/sync/runtime.ts:624` packs
`Y.encodeStateAsUpdate(doc)` through the same
`apps/desktop/src/main/sync/crdt-encrypt.ts` path).

### 7.11.1 `snapshotMeta.signerDeviceId` — Q07.6

It is advertised (`packages/sync-client/src/pull/crdt-pull.ts:38`) and the
baseline decision ignores it (`:161-166`).

**Normative — it is advisory metadata, not part of the baseline decision, and a
client MUST NOT branch on it.** The value it does carry is on the snapshot
**response**, not the meta: `GET /sync/crdt/snapshot/:noteId` returns
`signerDeviceId`, and the client MUST resolve that device's public key and fail
the baseline when it cannot
(`packages/sync-client/src/pull/crdt-pull.ts:178-182`). The copy in
`snapshotMeta` lets a client pre-fetch that key before issuing the snapshot GET;
using it for anything else changes the baseline rule of §7.8.

**Disposition of Q07.6: answered** (this section).

## 7.12 Route ordering is load-bearing

**Normative.** On a snapshot push the server does **store, then prune, then
broadcast** — never broadcast between store and prune
(`apps/sync-server/src/routes/sync.ts:872-881`, `:896`, `:919-929`).

The reason is on record (`apps/sync-server/src/routes/sync.ts:914-918`): a peer
must never be told to pull while the pre-snapshot updates are still being
removed. Delivery is best-effort, because the write already succeeded and a
failed broadcast must not become an error the client retries.

**A snapshot push MUST broadcast.** A snapshot can be the only carrier of edits
no peer has seen (the fallback for an update too large for the incremental
route, §7.10.1), and a silently stored snapshot stays invisible on every other
device until the next vault sweep, up to 15 minutes away
(`apps/sync-server/src/routes/sync.ts:905-913`).

## 7.13 The client snapshot obligation — Q07.2

### 7.13.1 The server never requires a snapshot

**Normative.** There is no update count, byte total, or age that triggers
server-side compaction anywhere in `apps/sync-server/src/services/crdt.ts`. **A
snapshot exists only because a client wrote one**
(`apps/sync-server/src/services/crdt.ts:320`), and pruning (§7.7) only happens
once one does.

**Correctness never depends on a snapshot. There is no MUST-snapshot.** A client
that never pushes one is conforming; it causes unbounded growth of that
document's update log, which is a real cost for a device that edits a lot.

### 7.13.2 The gate — MUST

**A snapshot is destructive: it prunes every device's rows at or below the
watermark** (§7.7). A client **MAY** push `POST /sync/crdt/snapshot` or its batch
form for a document **only when all of**:

1. it has merged all server state for that document — the last pull completed
   with **no stopped-at-gap and no unresolvable signer**
   (`packages/sync-client/src/pull/crdt-pull.ts:225-237`; desktop's guard is
   `hasUnmergedRemoteCrdtState`,
   `apps/desktop/src/main/sync/engine.ts:459-463`, true for any document whose
   session ended holding debt);
2. the document is neither local-only
   (`apps/desktop/src/main/sync/crdt-provider.ts:559`, `:865-868`) nor purged
   (`:654`);
3. the encoded state is non-empty
   (`apps/desktop/src/main/sync/crdt-provider.ts:876-879`).

**Otherwise the client MUST NOT use the snapshot endpoint.** It MAY push the same
full state to `POST /sync/crdt/updates`, which prunes nothing
(`apps/desktop/src/main/sync/runtime.ts:663-670`). The payload either way is
`Y.encodeStateAsUpdate(doc)` in the packed envelope
(`apps/desktop/src/main/sync/runtime.ts:624`).

The gate is pinned by
`apps/sync-server/src/__tests__/crdt-snapshot-batch.test.ts:188` and
`apps/sync-server/src/__tests__/crdt-snapshot-endpoint-seam.test.ts:594-703`.

### 7.13.3 The cadence — SHOULD

Desktop's de facto policy, which a conforming client SHOULD follow so a heavily
edited document's log does not grow unboundedly:

| Trigger                         | Rule                                                               | Source                                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| after its own incremental batch | 30 s quiet, 120 s cap from the first request                       | `packages/sync-client/src/crdt-snapshot-scheduler.ts:9` (`SNAPSHOT_QUIET_MS = 30_000`), `:16` (`SNAPSHOT_MAX_WAIT_MS = 120_000`), `:51`; requested at `apps/desktop/src/main/sync/runtime.ts:577-580` |
| document close                  | when `pendingSnapshotBytes > 0` and the document is not local-only | `apps/desktop/src/main/sync/crdt-provider.ts:559-565`; debt is bytes of non-network-origin updates, `:1249-1252`                                                                                      |
| shutdown                        | `pushAllSnapshots` for documents holding debt                      | `apps/desktop/src/main/sync/crdt-provider.ts:809-823`                                                                                                                                                 |
| local compaction                | encoded size over 1 MiB, no editor open, 60 s check interval       | `apps/desktop/src/main/sync/crdt-provider.ts:47-49`, `:1385-1400`                                                                                                                                     |
| oversized incremental           | the snapshot is the compaction point                               | `apps/desktop/src/main/sync/runtime.ts:554-575`                                                                                                                                                       |

### 7.13.4 What the platform-free engine does today, and #2187

**The platform-free engine pushes no snapshots at all**
(`packages/sync-client/src/pull/crdt-pull.ts:16-18`) and writes the snapshot
table only through
`store.saveSnapshot(noteId, bytes, serverSequenceNum, revision)`
(`packages/sync-client/src/pull/crdt-pull.ts:191-196`;
`packages/sync-client/src/pull/store.ts:60-65`). **Under today's scope every
stored snapshot row is server-originated.**

A client that pushes a snapshot learns the revision it wrote from the push
response: both snapshot routes carry it (`apps/sync-server/src/routes/sync.ts:951`
for the single note, the accepted batch outcome at
`apps/sync-server/src/services/crdt.ts:410-412`), and it is the same token the
upsert bound, per push rather than per batch
(`apps/sync-server/src/services/crdt.ts:335`, `:559`). **#2187**, resolved as the
additive option: the field is new, so old clients reading these bodies through an
unvalidated cast ignore it.

**A client that does not see a `revision` in the push response MUST store a NULL
local revision rather than inventing one** — that is the case against an older
server — because an invented token can collide with a server revision and
suppress a baseline the client needed. Storing NULL remains correct on any
server: the `sequenceNum > cursor` guard
(`packages/sync-client/src/pull/crdt-pull.ts:197`) already prevents a self
re-download.

**Disposition of Q07.2: answered (the gate is MUST, the cadence is SHOULD, there
is no MUST-snapshot).**

## 7.14 No server-side signature verification on CRDT updates — Q07.3

**Normative.** The server verifies signatures on **record** pushes
(chapter 04 §4.10) and on **no** CRDT route: nothing in
`apps/sync-server/src/services/crdt.ts` reads `signature`, and `storeUpdates`
persists `update_data` opaquely
(`apps/sync-server/src/services/crdt.ts:139-149`).

Each update **is** signed and **the client verifies it**
(`packages/sync-client/src/pull/record-decrypt.ts:137-140`), so the server cannot
forge or alter one. **What a malicious or faulty server can do is drop, withhold
or reorder updates.**

**This is in the threat model and is accepted.** The mitigations are structural,
not cryptographic: sequence numbers are monotonic within a document and the
client refuses to advance past a gap (§7.9), so withholding is visible as a
stalled cursor rather than as silent data loss; and CRDT merge is
order-insensitive, so reordering delivered updates changes nothing. **A server
that withholds updates indefinitely is indistinguishable from a server that has
none, and this specification defines no defence against it.**

**Disposition of Q07.3: answered (in the threat model; withholding is undefended
and recorded).**

## 7.15 Deleting a document — Q07.4

**Normative.** Deleting a note or journal **does not delete its `crdt_updates` or
`crdt_snapshots` rows on the server.** The only statements that remove them are
vault deletion
(`apps/sync-server/src/services/vault-deletion.ts:126-127`) and account deletion
(`apps/sync-server/src/services/account-deletion.ts:19-20`). The record delete
path (`apps/sync-server/src/services/sync.ts`) touches neither table.

Consequences a conforming client MUST implement:

- On applying a tombstone for a document, **delete the local Y.Doc and the local
  update log**, as desktop does
  (`apps/desktop/src/main/sync/item-handlers/journal-handler.ts:175-181`).
- **Do not pull bodies for a tombstoned id.** The server will still answer with
  the surviving log, and re-applying it would resurrect body state for a document
  the record feed says is deleted.
- **Do not treat surviving server rows as evidence the delete failed.**

### 7.15.1 The three obligations are not all the same component's

"Delete the local Y.Doc **and** the local update log" reads as one step because
the cited desktop handler holds both. A port whose apply path holds only a
database connection cannot do the first half, and that is not a defect in the
port.

**Normative, split by tier:**

| Obligation                               | Tier    | If the component cannot do it |
| ---------------------------------------- | ------- | ----------------------------- |
| mark the record deleted                  | durable | fail the delete               |
| mark every projection row deleted        | durable | fail the delete               |
| purge the local update log and snapshots | durable | fail the delete               |
| release the resident in-memory document  | runtime | **report the id**             |

**The three durable obligations MUST commit as one transaction.** Done as
separate statements, a crash between them leaves a record marked deleted with a
live body log — which is precisely the state the second consequence above
forbids, reached by a client that was trying to obey it. A component that
cannot complete the purge MUST fail the whole delete rather than commit the
part it managed: the delete is idempotent and arrives again on the next pass,
whereas a half-applied one does not.

**A component that holds no document registry MUST report the purged ids to its
caller rather than skip the runtime obligation silently.** Releasing a resident
`Y.Doc` is not something a storage tier can do, and a client that simply omitted
it would keep serving an in-memory document whose durable log it had just
erased.

### 7.15.2 A purge is keyed by type, never by id shape

**Normative: purge the update log only for a tombstone whose item type is a
document type.** An id is not evidence of what it names — §5.12.1 already says a
client MUST NOT infer a type from an id shape, because `tag_definition` ids are
tag names and `folder_config` ids are folder paths, so the id spaces are not
disjoint. A tag whose name happens to match a note id would otherwise purge that
note's body, and the loss is **unrecoverable in practice**: this section leaves
the server rows in place, so nothing reports an error and the device simply
stops asking for them.

**The untyped tombstone of §5.12.1 is the deliberate exception and purges
unconditionally.** That is not id-shape inference either: an untyped delete
marks _every_ row under that id whatever its type, so whatever owns the body
rows is among the things being deleted.

**Disposition of Q07.4: answered** (this section).

## 7.16 The Yjs client id is derived, not chosen

**Normative.** The Yjs client id travels inside every update, and two devices
that mint the same id corrupt a document that merges both. The derivation is
therefore a protocol fact, not an implementation detail, and it must be stated
here or two ports cannot interoperate.

A client derives its client id as the **first 53 bits of the SHA-256 of its
device id**, big-endian, read as an unsigned integer. Not a random number, not a
counter, and not the device id itself.

Fifty-three bits, because a JavaScript peer holds the client id in a `number`
and 2^53 is where an integer stops being exactly representable there. A Rust or
Swift port that used the full 64 bits would mint ids a browser peer could never
have produced, and a document that merged updates from both would disagree with
itself about ordering on exactly the ids that lost precision.

SHA-256 of the device id, because the device id is already unique per device and
already durable across relaunches. A random id per launch would make every
relaunch look like a new peer and grow the document's state vector without
bound; a counter would collide across devices immediately.

## 7.17 Note bodies in the change feed (#2295)

**Normative.** `crdt_updates` and `crdt_snapshots` carry a `server_cursor`
(migration `0011_crdt_server_cursor.sql`) drawn from the same per-user
`server_cursor_sequence` as `sync_items`. The cursor is reserved **inside the
batch that commits the row** (`apps/sync-server/src/services/crdt.ts:193`,
`:457`, `:703`), the rule chapter 05 §5.11 relies on: no reader sees a cursor
above a row that has not committed. Push requests and responses are unchanged,
and no push response carries the cursor.

- **A snapshot is re-cursored on every write**, insert and conflict alike, like
  a `sync_items` row: the upsert sets `server_cursor = excluded.server_cursor`
  (`apps/sync-server/src/services/crdt.ts:409-413`). Its `sequence_num` stays
  pinned (§7.6). A reader past the old cursor therefore sees the replaced
  snapshot again at its new cursor.
- **Rows written before migration `0011` have a NULL cursor** and are never in
  the feed; there is no backfill. Bootstrap (snapshot GET, packs) and the routes
  of §7.2 still serve them. So does any row a Worker older than this change
  writes after the migration.
- **Cursor order is commit order across all three tables.** Within one
  document, the cursor order of updates equals their `sequence_num` order.
- **A reader never assumes cursors are contiguous**: a pruned update leaves a
  gap in the sequence, and so does an update ignored as a duplicate (#2296),
  whose reserved cursor is never used.

### 7.17.1 What the feed serves

A client that declared `note_body` (chapter 05 §5.3) gets `noteBodies` on every
`GET /sync/changes` page, with the entry shape of chapter 05 §5.11.1. The body
rows come from one statement over both tables
(`apps/sync-server/src/services/crdt.ts:867`) read in the same D1 batch as the
record rows, so a page is one consistent snapshot.

- **An update entry carries `data` when the update is at most
  `NOTE_BODY_INLINE_MAX_BYTES` (4 KiB) stored bytes**
  (`apps/sync-server/src/services/crdt.ts:817`). A larger one is a ref without
  `data`: fetch it with
  `GET /sync/crdt/updates?note_id=<noteId>&since=<sequenceNum - 1>&limit=1` and
  check `sequenceNum`. An empty or different answer means the update was pruned;
  a snapshot entry at a higher cursor covers it (§7.17.2). The threshold was set
  from a read-only size aggregate on staging D1 on 2026-09-25: 11 rows, p50 212
  bytes, p99 287, max 332. The sample is small; the constant is revisable
  without a protocol change because a ref is always a valid entry.
- **A snapshot entry is always a ref.** Fetch `GET /sync/crdt/snapshot/<noteId>`,
  or skip the entry when its `revision` equals the one held. `revision` is the
  same token that route and `snapshotMeta` return (§7.5). The GET may return a
  newer snapshot than the entry names. That is harmless: document state only
  moves forward, and the newer write reappears at its own higher cursor.
- **The server serves every body row of the user's vault**, including the
  requesting device's own writes and bodies of tombstoned documents (§7.15
  keeps their rows). A client drops bodies for a tombstoned id itself.

### 7.17.2 Pruning never makes the feed skip state

Pruning (§7.7) deletes feed rows, so the feed has to survive it. **Claim:** when
an update `u` is pruned, the document's snapshot row `s` has
`s.server_cursor > u.server_cursor`.

1. Prune runs only after a snapshot upsert has committed (§7.12), and that
   upsert gave `s` a fresh cursor above every row committed before it.
2. Prune deletes only `sequence_num <= s.sequence_num`, a value read before `s`
   was first written and pinned after (§7.6), so every pruned `u` committed
   before that upsert.
3. So `u.server_cursor < s.server_cursor`, and `s`'s cursor only grows
   afterwards.

A reader below `u`'s cursor will still read `s`; a reader at or past it already
read `u`. The feed adds no loss beyond today's assumption that a client
snapshot contains the updates it prunes (§7.6).

### 7.17.3 Known races and rollback

- `GET /sync/crdt/snapshot/:noteId` reads the D1 row and then the R2 blob, which
  is overwritten in place, so it can pair an older `revision` with newer bytes
  (`apps/sync-server/src/services/crdt.ts:773-808`). The feed converges it: the
  write that replaced the blob re-cursored the row, so the client sees a snapshot
  entry again and re-fetches.
- **Rolling the Worker back past this change is unsafe once a client depends on
  the feed for bodies** (#2297). Old Worker code writes updates with a NULL
  cursor and upserts snapshots without moving their cursor, so a feed-only
  client never sees those writes. Desktop reads the feed since #2297 part a but
  still runs the `crdt_updated`, per-note pull and sweep paths, so a rollback is
  still safe for it; it stops being safe once those paths are removed.
- The `crdt_updated` broadcast (chapter 09) is unchanged and carries no cursor.

### 7.17.4 The Rust core (#2304)

The Rust core declares `note_body` on the feed pull of `sync_now` and applies
`noteBodies` (`crates/memry-core/src/sync/note_body_feed.rs`). It does not
merge a body into a resident document: it appends the update, or stores the
snapshot, in the server namespace of its update log, as the per-note pull does
(§7.8, §7.9), and a document merges its log on the next load. The pull report
names the documents whose log grew.

- **Entries that cost nothing.** Before any request or decrypt, three kinds of
  entry are dropped:
  - one for a note or journal the page deletes. A deleted tag that shares a
    note's id deletes no body;
  - one for a document this device holds no body state for: no
    `crdt:<docId>` cursor and no row in either namespace of the log. That
    document was never fetched here, or has no local record. It is fetched
    whole when it is opened or when its record arrives, as desktop does for an
    id with no local row. Storing a feed row for it would leave a partial body
    that reads as present, and could land the body of a note deleted elsewhere
    long ago on a device that never held it;
  - an update at or below the held `crdt:<docId>` cursor, which is a replay
    (§7.9).
- **Before the page applies**, every other entry is parsed on its own. A ref
  update is fetched by sequence, and a snapshot ref is fetched unless its
  `revision` is held. The envelope is opened and the update parsed as Yjs. An
  entry that fails any step, including a fetch that fails or a ref the server
  pruned, costs that entry and owes its note a per-note pull. It never fails
  the page. After the first `429` of a page, no further request is sent, and
  every entry still needing one owes its note.
- **One transaction** stores the bodies, records the debts, and writes the
  record cursor last. A storage failure rolls it back and the page is pulled
  again. A body for a note or journal deleted here is dropped (§7.15).
- **The `crdt:<docId>` cursor moves only over a contiguous sequence.** An
  update past a gap is stored and its note owed, so the per-note pull still
  fetches the missing updates.
- **A debt** is the `meta` row `sync.body_owed:<docId>`
  (`crates/memry-core/src/sync/body_debt.rs`).
  - Its value is `<failures>:<passes to wait>`.
  - A tombstone settles the debt in the transaction that purges the body, and
    a debt on a deleted document is settled rather than pulled.
  - It is settled only by a per-note pull that reached the server's head
    (`hasMore: false`) and stored everything on the way, with no stop and no
    baseline it could not use. A pull that yields at the page cap keeps the
    debt.
  - A stop or an error answer backs the document off for
    `2^(failures - 1)` passes, up to 32.
- **Settled means "in the log".** A settled debt says this device's update
  log holds every server update up to the head the pull saw. It does not say
  a resident document has loaded them.
  - The snapshot push refuses an owed document (§7.13.2 condition 1).
  - It also refuses a resident document whose state and delete set would
    change if its log were replayed over it, so it cannot prune a logged
    update the document has not merged.
  - It cannot close the race with the server. An update another device
    commits after the encode is pruned if the server's watermark covers it,
    which is the §7.6 assumption every client shares. `SnapshotPusher` has no
    production caller yet.
- **The body step never blocks the push**
  (`crates/memry-core/src/sync/body_step.rs`).
  - It runs the per-note pull for the due documents within a budget of 200
    requests per pass, well under the server's 600 per minute for CRDT
    pulls.
  - An error answer owes that document and the step goes on.
  - A `429`, no network, or a rejected session ends the step, and the
    documents not reached keep their debts for the next pass.
  - The push runs either way.
- **The one-time legacy pull** is the `meta` row `sync.note_body_legacy_pull`,
  absent until the first page that carries `noteBodies`. In that page's
  landing transaction, every document this device holds body state for is
  owed a per-note pull and the row becomes `done`, so the debts carry the
  progress one document at a time. The pull exists for body rows the feed
  never serves, those with a NULL cursor (§7.17), in documents this device
  already holds. A document it never fetched is fetched whole when it is
  opened, so it is not included.
- The per-note pull after a record page (`crates/memry-core/src/sync/body_pull.rs`)
  stays, driven by the debt `sync_now`'s feed pull records for each note or
  journal record it applies. A body that arrives both ways converges, because
  the log ignores a sequence it holds. Only a pull loop that lands bodies owes
  them: a plain record pull (the CLI) records no debt it would never settle.

### 7.17.5 Desktop applies bodies from the feed (#2297)

**Declaration.** Desktop declares `note_body` only on the `GET /sync/changes`
of a pull run that starts past cursor 0
(`apps/desktop/src/main/sync/engine/pull-coordinator.ts:396`,
`apps/desktop/src/main/sync/http-client.ts:23`; chapter 05 §5.3). A run from
cursor 0, which is a bootstrap or any reset of the cursor to 0, keeps the
500-row record pages. Every note and journal record it applies pulls its whole
body (`applyCrdtBatch`), and the legacy sweep below covers the rest. A page of
a run that did not declare is read as a page without bodies.

Per page of a declaring run
(`apps/desktop/src/main/sync/engine/note-body-feed.ts`, class `NoteBodyFeed`):

- **Which entries are read** (`:120`). An entry is used only for a note or
  journal that has a row here, is not local-only, and whose record is not on
  this page.
  - A note whose record is on the page gets its whole body from that record.
  - An id with no row gets nothing (see below).
  - Of several snapshot entries of one note, only the newest (highest `cursor`)
    is kept (`:138`). Every snapshot GET returns the note's current snapshot,
    and the newest entry's `revision` is the one compared with the watermark.
- **Fetched and verified before the page transaction** (`:104`). Each entry is
  validated with `NoteBodyChangeSchema` on its own, and inline `data` is used
  as is.
  - Ref updates and snapshots are fetched through §7.2: one attempt each, at
    most four at a time (`:27`), and the pull's abort signal cancels the
    request in flight. A 401 is retried once with a refreshed session.
  - A page issues at most 16 of these GETs (`:34`), so it spends at most 16 of
    the `crdt_pull` budget it shares with the record pages' CRDT batch. Entries
    past that are owed; the paced sweep that pays owed pulls charges its own
    GETs.
  - The signer key is resolved, the payload decrypted (on the crypto worker
    when it runs), and the plaintext decoded once with `Y.decodeUpdate`
    (`:405`). All of this happens before any slice transaction opens, because
    the apply loop inside it stays synchronous.
- **Every failure is per entry; none fails the page.** Each entry ends in one
  of four outcomes:
  - **Refused:** a fault of the entry. That is a schema failure, a signer that
    cannot be resolved (or whose lookup fails), a ciphertext that does not
    verify, bytes Yjs cannot decode, or a fetch the server answers with a 4xx
    other than 401 and 429. The note goes to the schema-invalid ledger as
    `note_body:<noteId>`, is flagged as holding unmerged remote state (§7.13.2),
    and is owed a whole-body pull.
  - **Owed:** the entry's state is not here and nothing is wrong with it. The
    note is flagged and owed a whole-body pull, and never ledgered. This covers:
    - a ref update pruned since the page was read;
    - a snapshot GET with no blob. The covering snapshot (§7.17.2) may sit on a
      page the run never reaches;
    - an entry past the page's GET budget;
    - every entry from the first transport failure on: a `429`, a network
      failure or timeout, a 5xx, or a 401 after the refresh. The first one
      stops the page's GETs (`:353`), and that entry and every entry not yet
      fetched are owed. A rate limit or an outage says nothing about the entry.
  - **Skipped:** a snapshot whose `revision` equals the persisted watermark's.
  - **Dropped:** every entry that is not read (above).

  Only an abort throws. Refusals and debts are recorded inside the last slice's
  transaction, after its records applied and before any cursor write (`:179`).

- **The vault-key guard.** If every body on the page fails to decrypt, the same
  account-key check the record path uses runs (`:425`). On `mismatch` or
  `transition` the page stops before any slice, the cursor holds, and nothing
  is ledgered (`pull-coordinator.ts:426`).
- **Landed after the commit, before the cursor.** After the page commits and
  its note files land, the bodies land in the CRDT store (`:191`;
  `pull-coordinator.ts:1007`). Landing is post-commit work (chapter 05 §5.11),
  so `LAST_CURSOR` is written only after it (`pull-coordinator.ts:975`).
  - Nothing about the bodies is written to disk before the landing. A crash
    before it re-pulls the page, and re-applying a Yjs update is a no-op.
  - A document whose landing rejects is refused as above, before the cursor
    write.
  - An abort (a vault close or switch) stops the landing and refuses nothing.
    The cursor holds, so the page is pulled again.
- **How a body lands** (`apps/desktop/src/main/sync/note-body-apply.ts:45`).
  Only a note or journal with a row here, whose doc already holds persisted
  state, takes a body.
  - It is opened without a markdown seed and merged live, so an open editor
    and the markdown write-back see it.
  - An update that changed the doc is also stored explicitly. The landing
    awaits that write and rejects if it fails
    (`apps/desktop/src/main/sync/crdt-provider.ts:718`). An update that
    changed nothing, such as this device's own echo, is not stored again.

  Nothing else is ever stored. Bytes the store holds but no live doc merged
  make every later merge of the same state a no-op, so the write-back that
  writes the vault file would never run:
  - **An id with no row:** dropped, neither stored nor owed. It may belong to a
    note deleted on an earlier page. It may be deleted on this page, by a
    signed tombstone or a purged-tombstone marker (chapter 05 §5.12.3), both
    applied in the slice transaction before the landing. Or it may be deleted
    while the open awaited the store; the row is checked again after the open.
    Owing it a pull would let that pull's merge write a deleted note back.
  - **A known note whose doc holds nothing:** owed its whole body, and nothing
    is stored. A delta merged into an empty doc can integrate in part and write
    a partial body over the file.
  - **A body the doc cannot integrate (pending structs):** the note is owed a
    whole-body pull.
  - **No store at all (in-memory mode):** nothing is fetched, and every entry
    that is read is owed to the CRDT pull (`note-body-feed.ts:148`).

- **Every path that applies a note or journal record pulls its whole body.**
  That is how a dropped body arrives. The paths are:
  - the record page (`applyCrdtBatch` after each slice);
  - the corrupt re-fetch after a page;
  - the ledger retry at pull start;
  - the deferred retry after the last page;
  - the orphan repair.

  The last four run the CRDT batch before the pull ends
  (`pull-coordinator.ts:185`, `:682`). A replacement for `applyCrdtBatch`
  (#2297 part b) MUST keep this rule for every one of these paths.

- **No id without a row is ever owed or pulled.** Two places keep this:
  - `NoteBodyFeed` ledgers and owes only a note that still has a row when the
    debt is recorded (`note-body-feed.ts:255`).
  - A queued pull, from the pending pulls or the paced sweep, drops an id with
    no row before it opens a doc and clears its flag
    (`apps/desktop/src/main/sync/engine/crdt-sync-coordinator.ts:1391`). A note
    deleted after it was owed is therefore never merged and written back as a
    new file.

  The delete paths themselves record nothing.

- **Healing a refused body.** At pull start, after the pending sync intents
  drain (chapter 05, #2301), the ledger retry merges the note's whole body
  through §7.2, at most 10 notes per pull
  (`apps/desktop/src/main/sync/engine/item-recovery.ts:193`). A failed heal
  waits out the cooldown again.
  - An id with no row, or a local-only note, is resolved without a pull
    (`note-body-feed.ts:235`).
  - A heal that still left an update unverified keeps the entry.
  - A `note_body:<id>` entry is its own ledger entry (kind `envelope`), apart
    from the note record's own `blob_missing` or `pending_intent` entry.
    - The manifest's quarantine check asks for the record type, so a refused
      body never hides the note record.
    - The `pending_intent` re-fetch never asks `/sync/pull` for a body.
    - The entry heals by itself and asks nothing of the user, so it is not
      listed as a quarantined item
      (`apps/desktop/src/main/sync/engine/schema-invalid-ledger.ts:104`).
- **Snapshot revisions.** The note's watermark records:
  - the revision of a snapshot merged into a doc. One that was dropped or only
    owed is not recorded, since the CRDT pull would then skip the baseline the
    note is owed;
  - the revision the server returns for a snapshot this device pushed
    (`crdt-provider.ts:742`; `apps/desktop/src/main/sync/runtime.ts:681`,
    `apps/desktop/src/main/sync/crdt-snapshot-batch.ts:162`). This device's own
    snapshot then comes back through the feed as a skipped entry, not a
    download.
- **Journals.** A journal body is the same CRDT document under the journal
  record's id (§7.1), so `note_body` carries it with no extra handling.
- **Both paths apply the same bytes.** The `crdt_updated` pull, the per-note
  reconnect pull and the vault sweep still run (#2297 part b removes them).
  Applying a Yjs update that a doc already holds is a no-op, so a body that
  arrives by both paths converges; the cost is one duplicate fetch.
- **The legacy sweep.** Rows written before migration `0011` carry no cursor,
  and rows below the device cursor at first negotiation were never served as
  bodies.
  - The first page that carries a `noteBodies` array sets the sync-state key
    `noteBodyLegacySweep` to `pending` (`note-body-feed.ts:267`).
  - A full sync whose pull delivered (ran to `hasMore: false` without a refused
    page) then forces the vault-wide sweep
    (`apps/desktop/src/main/sync/engine/full-sync-runner.ts:725`).
  - Only that sweep's drain, with nothing owed back, records `done`, and only
    if the key still reads `pending` (`full-sync-runner.ts:492`). An
    interrupted or partly failed sweep stays `pending`.
  - A page without `noteBodies` while the key is set means the server stopped
    serving bodies (§7.17.3). The page deletes the key and discards the sweep
    this engine queued (`full-sync-runner.ts:515`), so that drain records
    nothing. The next negotiated page forces a new sweep.
  - A device that was offline for the whole of a server rollback never sees a
    page without `noteBodies`. It cannot tell that the rollback wrote rows with
    no cursor, so its `done` stands. Detecting this needs a server signal, such
    as a feed epoch, which this part does not have.
- **Bootstrap after `applyCrdtBatch` goes.** A run from cursor 0 gets bodies
  only through the records it applies and the sweeps. Once #2297 part b
  removes `applyCrdtBatch` and the sweeps, it MUST give that run another body
  path. It can declare `note_body` from cursor 0 as well and accept the 100-row
  pages. Or it can keep a whole-body pull for every note and journal record the
  run applies.
