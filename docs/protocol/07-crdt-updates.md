# 07 — CRDT updates

**Status**: normative. Every normative sentence carries a `path:line` citation
(chapter 00 §0.1).

Note and journal **bodies** travel here and nowhere else. A record push for a
body edit carries `content: null`
(`packages/sync-client/src/pull/crdt-pull.ts:9-10`), so a client that implements
only the record feed (chapter 05) never sees a body change.

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

### 7.1.1 The constants are wrong today (#2186)

`CRDT_SYNC_ITEM_TYPES = ['note']`
(`packages/contracts/src/sync-api.ts:91`) and `CrdtSyncItemType` (`:163`) are
referenced only by tests. `EncryptedCrdtItemSchema.type` is `z.literal('note')`
(`packages/contracts/src/crypto.ts:194`) on a type that matches nothing on the
wire at all (chapter 04 §4.12.1).

**Decision, 2026-09-13 — correct the constants; do not scope them.**
"Record-envelope-scoped only" would be a false statement: the record envelope's
type set is `ENCRYPTABLE_ITEM_TYPES`
(`packages/contracts/src/crypto.ts:179`), which already contains `journal`
(`packages/contracts/src/sync-api.ts:134`).

The corrections are `packages/contracts/src/sync-api.ts:91` becoming
`['note', 'journal']`, its test
(`packages/contracts/src/sync-api.test.ts:89-91`), and either deleting the dead
`EncryptedCrdtItem` pair or widening its `type`. Tracked as **#2186**.

**This chapter states the corrected rule. Where it differs from today's
constants, the constants are wrong, not the chapter.**

**Disposition of Q07.1: answered (decision: correct the constants, #2186).**

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
being the base64 packed envelope. Response `{ sequenceNum }` (§7.13.4 — not
`revision`).

**`POST /sync/crdt/snapshot/batch`** — request
`{ snapshots: [{ noteId, snapshot }] }`, at most **50**, the lower cap because
a snapshot may be 5 MiB decoded and roughly 6.7 MiB as base64. `snapshot` is
deliberately unbounded per entry: an oversized payload is a per-note rejection,
not a malformed batch.

`POST /sync/crdt/updates` takes
`{ noteId: string, updates: string[] }` — the updates being base64 packed
envelopes (chapter 04 §4.11), **at most 100 per call**, each capped at twice
`MAX_UPDATE_BYTES` in its base64 form because base64 inflates by four thirds
and the cap is applied to the encoded string. It answers `{ sequences: number[] }`
(`apps/sync-server/src/routes/sync.ts:748`).

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
snapshot envelope** (`apps/desktop/src/main/sync/runtime.ts:634` packs
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

**A snapshot push MUST broadcast.** A device that edited while signed out never
enqueued those edits as updates — they exist only as document state — so a
snapshot is the only shape that backlog can leave in, and a silently stored
snapshot stays invisible on every other device until the next vault sweep, up to
15 minutes away (`apps/sync-server/src/routes/sync.ts:905-913`).

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
(`apps/desktop/src/main/sync/runtime.ts:674-681`). The payload either way is
`Y.encodeStateAsUpdate(doc)` in the packed envelope
(`apps/desktop/src/main/sync/runtime.ts:634`).

The gate is pinned by
`apps/sync-server/src/__tests__/crdt-snapshot-batch.test.ts:188` and
`apps/sync-server/src/__tests__/crdt-snapshot-endpoint-seam.test.ts:594-703`.

### 7.13.3 The cadence — SHOULD

Desktop's de facto policy, which a conforming client SHOULD follow so a heavily
edited document's log does not grow unboundedly:

| Trigger                         | Rule                                                               | Source                                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| after its own incremental batch | 30 s quiet, 120 s cap from the first request                       | `packages/sync-client/src/crdt-snapshot-scheduler.ts:9` (`SNAPSHOT_QUIET_MS = 30_000`), `:16` (`SNAPSHOT_MAX_WAIT_MS = 120_000`), `:51`; requested at `apps/desktop/src/main/sync/runtime.ts:585-591` |
| document close                  | when `pendingSnapshotBytes > 0` and the document is not local-only | `apps/desktop/src/main/sync/crdt-provider.ts:559-565`; debt is bytes of non-network-origin updates, `:1249-1252`                                                                                      |
| shutdown                        | `pushAllSnapshots` for documents holding debt                      | `apps/desktop/src/main/sync/crdt-provider.ts:809-823`                                                                                                                                                 |
| local compaction                | encoded size over 1 MiB, no editor open, 60 s check interval       | `apps/desktop/src/main/sync/crdt-provider.ts:47-49`, `:1385-1400`                                                                                                                                     |
| oversized incremental           | the snapshot is the compaction point                               | `apps/desktop/src/main/sync/runtime.ts:578-585`                                                                                                                                                       |

### 7.13.4 What the platform-free engine does today, and #2187

**The platform-free engine pushes no snapshots at all**
(`packages/sync-client/src/pull/crdt-pull.ts:16-18`) and writes the snapshot
table only through
`store.saveSnapshot(noteId, bytes, serverSequenceNum, revision)`
(`packages/sync-client/src/pull/crdt-pull.ts:191-196`;
`packages/sync-client/src/pull/store.ts:60-65`). **Under today's scope every
stored snapshot row is server-originated.**

When a client starts pushing snapshots, `server_revision` is **undefined at write
time**, because the push response returns `{ sequenceNum }` and **not** the
revision (`apps/sync-server/src/routes/sync.ts:947`). The two options are
returning `revision` from the snapshot routes (additive; old clients ignore it),
or storing NULL and leaning on the `sequenceNum > cursor` guard
(`packages/sync-client/src/pull/crdt-pull.ts:197`), which already prevents a self
re-download. Tracked as **#2187**.

**Until #2187 lands, a client that pushes a snapshot MUST store a NULL local
revision rather than inventing one**, because an invented token can collide with
a server revision and suppress a baseline the client needed.

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
