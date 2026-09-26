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
Response: `{ updates: [...], hasMore: boolean, snapshotMeta }`, **at the top
level**. There is no `notes` wrapper on the single-document form; that belongs
to the batch. `snapshotMeta` (#2299, additive) is the note's
`{ sequenceNum, revision, signerDeviceId }`, or `null` when it has no snapshot;
it is read after the updates, so a prune landing in between shows up as a newer
snapshot, never a missing one (`apps/sync-server/src/services/crdt.ts:280`). A
server that predates it omits the key.

**`POST /sync/crdt/updates/batch`** — request
`{ notes: [{ noteId, since }], limit }`. At most **100** entries, duplicate
`noteId`s **rejected outright** rather than de-duplicated, `since` defaulting to
0 and `limit` an integer 1 to 100 defaulting to 100.
Response: `{ notes: { <noteId>: { updates, hasMore } } }`, keyed by id — which
is why the single form's flat shape above is worth stating separately.

**`POST /sync/crdt/snapshot`** — request
`{ noteId, snapshot, coversThrough?, baseRevision? }`, the snapshot being the
base64 packed envelope and the other two the optional claim of §7.7.1 (#2299).
Response `{ sequenceNum, revision }`
(`apps/sync-server/src/routes/sync.ts:951`), the `revision` being the token the
upsert just wrote (§7.13.4).

**`POST /sync/crdt/snapshot/batch`** — request
`{ snapshots: [{ noteId, snapshot, coversThrough?, baseRevision? }] }`, at most **50**, the lower cap because
a snapshot may be 5 MiB decoded and roughly 6.7 MiB as base64. `snapshot` is
deliberately unbounded per entry: an oversized payload is a per-note rejection,
not a malformed batch. Response `{ results: [...] }`, one entry per request
entry in request order, each `{ noteId, accepted: true, sequenceNum, revision }`
or `{ noteId, accepted: false, reason }`
(`apps/sync-server/src/services/crdt-snapshot-write.ts:43`).

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
(`apps/sync-server/src/services/crdt-snapshot-write.ts:287`, applied by the upsert at `:114`).

The reason is on record: a revision that fails to move when the blob moves leaves
a client skipping a snapshot it needed, with a stale body forever
(`apps/sync-server/src/services/crdt-snapshot-write.ts:300-302`).

Rows written before `revision` existed carry `''` and are coalesced to a
synthetic `legacy:<id>:<created_at>:<size_bytes>`, so an old snapshot is not
re-downloaded forever
(`apps/sync-server/src/services/crdt.ts:77-89`).

**A client MUST treat `revision` as an opaque token and MUST compare it only for
equality.**

## 7.6 Snapshot watermark stability

**Normative.** Once a snapshot exists for a document, a push **without**
`coversThrough` leaves its `sequence_num` where it is: the upsert reuses
`existingSnapshot?.sequence_num ?? currentSeq`
(`apps/sync-server/src/services/crdt-snapshot-write.ts:297-299`).

The reason is on record: client-uploaded snapshots carry no causal metadata
proving they already contain every server update above the prior watermark, so
keeping the watermark stable keeps later incrementals pullable.

A push **with** `coversThrough` carries that proof for the rows it covers, so
it may move the watermark forward, and only over rows it prunes (§7.7.1). The
watermark **never moves down**: the conflict clause writes
`MAX(crdt_snapshots.sequence_num, excluded.sequence_num)`
(`apps/sync-server/src/services/crdt-snapshot-write.ts:114`), so a concurrent push that read an older watermark cannot
lower it under rows another push already pruned.

## 7.7 Pruning is server-side

**Normative.** Without `coversThrough`: `DELETE FROM crdt_updates WHERE user_id
= ? AND vault_id = ? AND note_id = ? AND sequence_num <= ?`, bound to the
snapshot's watermark (`pruneUpdatesBeforeSnapshot`,
`apps/sync-server/src/services/crdt.ts:486`), with a batch form that runs every
SUM ahead of every DELETE inside one D1 transaction (`:530`). A claimed push
prunes inside its own write instead (§7.7.1).

**A client does no pruning of the server's log.**

### 7.7.1 `coversThrough` (#2299)

**Meaning.** `coversThrough = C` on a snapshot push (single or per batch entry,
`CrdtSnapshotCoversThroughSchema`, a non-negative integer) asserts: **every
note_body feed row of this note with `server_cursor <= C` is merged into the
pushed state.** `baseRevision` (optional, only with `C`) names the stored
snapshot revision the pusher last merged or pushed. Both are optional; a server
that predates them ignores the keys and applies §7.6 and §7.7 unchanged.

**The gate: claims stay dormant until old desktops can no longer write.** A
claimed row answers a pre-#2299 desktop's unclaimed push with a 409, and that
desktop retries it (its oversized-update fallback about once a second). So the
server honours `coversThrough` only when the env var
`CRDT_CLAIM_MIN_DESKTOP_VERSION` is set **and** `client_policies['desktop']
.min_write_version` is at or above it (`compareVersions`;
`snapshotClaimsEnabled`, `apps/sync-server/src/services/client-policies.ts:73`,
read once per request). Otherwise a claim is dropped and the push runs under
the pre-#2299 rules exactly (`covers_through` stays NULL), so no claimed row
exists and no legacy client ever meets the refusal. The env var is unset in
`wrangler.toml` for every environment. **Rollout:** raise the desktop
`min_write_version` to the #2299 release, then set the env var. Setting it last
also closes most of the mixed-version deploy window below, because no claimed
row exists before it.

**Why the rules below exist.** Before #2299 the watermark stayed pinned after a
note's first snapshot, so every update row above it survived any blob
overwrite. A claimed push deletes rows above the old watermark; from then on
those rows exist on the server **only inside that snapshot's blob**. Every rule
below keeps that blob from being replaced by one that does not hold them.

**The write** (`apps/sync-server/src/services/crdt-snapshot-write.ts`, one path for the single and batch routes):

1. **One immutable object per write.** The blob goes to
   `<user>/vaults/<v>/crdt/<noteId>/snapshot/<revision>`, and the row's
   `blob_key` names it. The previous object is deleted only after the D1 commit
   and only when its key differs; a refused write deletes its own object. A
   losing concurrent write therefore never clobbers the winner's bytes. Rows
   written before #2299 keep the fixed `.../snapshot` key; the next write
   replaces it.
2. **The claim is recorded**: `crdt_snapshots.covers_through`
   (migration `0014_crdt_snapshot_covers_through.sql`, nullable, no backfill;
   NULL means "no claim"). A write through the `baseRevision` arm stores the
   union of both coverages, `MAX(C, COALESCE(old.covers_through, 0))`
   (`STORED_COVERS_THROUGH_SQL`, `:106`): the pusher merged that snapshot, so
   the new blob holds what it pruned. `old.server_cursor` is not used: rows
   between the old claim and the old snapshot's cursor are not provably merged.
3. **The guard is a condition of the upsert, never a prior read**
   (`REPLACE_ALLOWED_SQL`, `:91`, on `ON CONFLICT DO UPDATE ... WHERE`, checked
   through `changes()`). A stored row may be replaced:
   - by an **unclaimed** push only when the row carries no claim either — an
     unclaimed push onto a claimed row is refused, because it never merged the
     rows that claim pruned (older clients and the Rust core see a failed
     snapshot push and keep the note pending; nothing is lost). This case is
     also refused from the stage-1 read, before the R2 put, so a legacy retry
     costs a D1 read only; the upsert condition stays the authority;
   - by a **claimed** push only when the row is legacy (no cursor, no claim);
     or `baseRevision` equals the row's revision (compare-and-swap: the pusher
     merged exactly that snapshot); or the row's cursor is at or below `C`,
     whoever signed it (the pusher's feed has read it).

   Nothing else. **A device id alone is no proof of state**: a data dir restored
   from a backup or cloned to another machine signs with the same id, and a
   stale own encode (a retry after a lost response, a push racing the
   oversized-update fallback) can lack content its newer snapshot took through
   `baseRevision`. Such a push gets the ordinary refusal and the client pulls.

4. **Covered watermark** (`COVERED_WATERMARK_SQL`, `:128`). Starting above the
   current watermark `W` (0 for a first snapshot, never `currentSeq`), take
   update rows in `sequence_num` order while each has a non-NULL cursor at or
   below `C`, and stop at the first that does not. The new watermark is
   `max(W, last sequence taken)`.
5. **The prune is in the same D1 batch as the upsert** and runs only when the
   upsert applied (`COVERED_PRUNE_SCOPE_SQL`, `:142`, conditioned on the row now
   carrying this push's revision): rows at or below that watermark with
   `server_cursor IS NOT NULL AND server_cursor <= C`. Nothing else.
6. **A refused write** (0 changes) is answered `409 CRDT_SNAPSHOT_NOT_COVERED`
   with `error.blockingCursor` (the stored snapshot's cursor, from a re-read of
   the row; the refusal wrote nothing, so the read is not a race), or in a
   batch `{ accepted: false, reason: "CRDT_SNAPSHOT_NOT_COVERED",
blockingCursor }`. There is no success answer for a refused write: a
   revision it named would be recorded as held and sent as the next base.
7. **An ambiguous commit.** D1 can throw after the batch committed (a lost
   connection, an isolate reset). The rows are re-read: a row naming this
   write's key committed, keeps its object and is answered as success, and the
   object it replaced is left an orphan (its key is unknown). Only a write the
   re-read shows uncommitted loses its object; if the re-read fails too,
   nothing is deleted.

**Readers racing the delete.** A reader can read the row, then miss the old
object the next write deleted. `getSnapshot`
(`apps/sync-server/src/services/crdt.ts:362`) re-reads the row once: a changed
`blob_key` is fetched, an unchanged one answers a retryable **503**, and only a
row that is gone answers `snapshot: null`. Never "no snapshot" for an existing
row: desktop reads that as verified-empty and seeds from markdown. Desktop,
the Rust core and `CrdtBodyPuller` treat the 503 as a transport failure.

**Why the watermark moves.** A reader of §7.8 whose per-note cursor sits above
the old watermark only fetches the snapshot when told of it. Pruning rows above
a watermark that did not move would leave that reader a gap it never
re-fetches. Moving it over exactly the pruned prefix makes the reader fetch the
snapshot (which holds those rows) and resume above it.

**NULL-cursor rows** are never pruned by a claimed push, and they stop the
watermark (rule 4). The feed never served them, so `C` says nothing about them.
Cost: a note whose pre-`0011` rows sit above its pinned watermark keeps them.

**Clients.**

- **Desktop** claims `C = LAST_CURSOR` only when all of: the legacy body sweep
  is `done` (§7.17.5), the cursor is above 0, the note holds no tracked
  unmerged state (a `crdt_updated` wake whose cursor `LAST_CURSOR` has not
  reached counts), the debt tables are usable, the feed never dropped a body of
  the id as rowless (a `crdt_body_withheld` row), and no refusal of this note is outstanding
  (`SyncEngine.snapshotCoverage`, `apps/desktop/src/main/sync/engine.ts:511`).
  - `encodeForPush` (`apps/desktop/src/main/sync/crdt-provider.ts:326`) is the
    only way to produce push bytes: it reads the base revision first (the
    persisted snapshot watermark, `readPushBase`, `:314`), then the claim and
    the encode in one synchronous step, because a feed page can land bodies and
    move `LAST_CURSOR` during any await. A reader that throws claims nothing.
  - The provider withholds the claim when the doc cannot vouch for itself
    (`canVouchFor`, `:295`): the store is in-memory, its epoch reconcile threw
    this session, or the note's doc was created or seeded this session without
    persisted state (a new note or journal, a markdown seed, a failed store
    read) or the feed dropped the id as rowless, until a whole-body pull of the
    note merges (`recordWholeBodyMerged`, `:300`). The push is then the plain
    unclaimed one.
  - A flagged note (at the encode or at send time) claims nothing and takes the
    non-pruning route of §7.13.2.
  - A refusal (`recordSnapshotRefusal`, `engine.ts:536`) owes the note a pull
    and keeps it on `/sync/crdt/updates` until `LAST_CURSOR` reaches the
    refusal's `blockingCursor`, or the held snapshot revision moved off the one
    the refused push carried (a pull merged a newer snapshot, so the
    compare-and-swap passes), or, for a refused unclaimed push, until the note
    can claim at all. The refusal is never met again on the spot.
  - A note leaving local-only is owed a pull (`oweCrdtPull`, `:545`): the feed
    skipped its bodies without flagging it. At runtime start every syncing
    note with a queued full-state row is flagged, without a second pull: its
    own full-state flush merges the server state first and clears the flag,
    and a flush that drops the note as no longer syncing clears it too. This
    covers a note that left local-only while no runtime ran. That flag is
    session-only: the queued row is durable and flags the note again at every
    start. The refusal and local-only owes are durable debts (§7.17.5).
  - A body the feed merges while the doc is compacting is only buffered, so it
    is reported not landed and the note is owed its whole body
    (`mergeRemoteUpdate`, `crdt-provider.ts:882`); a compaction that drops a
    non-empty buffer (its push threw, or no live doc is left) owes the note too,
    as a durable `compaction` debt.
  - The data DB and the CRDT store share one random epoch id
    (`crdtStoreEpoch` in `sync_state`, and a meta key in the store), compared
    for equality at open (`apps/desktop/src/main/sync/crdt-store-epoch.ts`). A
    mismatch (a fresh or quarantined store, either side restored or copied
    apart from the other) deletes `noteBodyLegacySweep` and
    `crdtBodyDebtMirrorAt`, raises `crdtUnmergedDebt` in the same data-DB
    transaction (the next engine start converts it into a debt for every
    note, §7.17.5) and writes a new epoch to both, before anything can push
    from the store; every install from before the epoch runs one vault sweep
    after upgrading.
  - An oversized update whose snapshot fallback fails (the note is on the
    size-capped update route until its pull merges) backs off per note, 2 s
    doubling to a minute, instead of retrying every second.
  - The vault sweep takes its note set from the data DB as well as the index
    cache, so a note missing from a rebuilding index is not skipped by the
    sweep that licenses claims.
- **The Rust core** claims its record cursor once `sync.note_body_legacy_pull`
  is `done`, and only for a document whose server body it has read (a
  `crdt:<docId>` cursor or a server snapshot row; `note_body_feed::covers_through`).
  It sends the revision its last push answered, or its last baseline, as
  `baseRevision`; an owed document is refused before any request; a refusal
  owes the document (§7.17.4).
- A client MUST NOT claim a cursor that moved past body rows it was not served:
  a page without `noteBodies`, a desktop run from cursor 0 (which does not
  declare `note_body`), and the Rust first sync's refs pass re-arm the legacy
  pull.

**Old or rolled-back servers.** They ignore the claim and prune by watermark. A
new client is exactly as safe there as before: a note with tracked unmerged
state never reaches the snapshot route, and everything else is the pre-#2299
push. This is why desktop keeps the routing: the client cannot tell which
server it talks to. Owed pulls are durable per note since #2297 part b
(`crdt_body_debts`, §7.17.5), so a crash no longer leaves a note looking merged,
and a feed debt records its lowest unmerged cursor. A flagged note still claims
nothing; claiming `min(LAST_CURSOR, lowest_cursor - 1)` for it is left to a
later change.

**Deployment: 100% at once, no gradual rollout.** A Worker older than this
change has no `MAX` on the watermark, no upsert condition and no per-write key.
Running both versions side by side (a gradual deploy) lets an old Worker lower a
watermark under rows a new one pruned, or overwrite a claimed snapshot. Deploy
the server change to every Worker at once, and set
`CRDT_CLAIM_MIN_DESKTOP_VERSION` only after that deploy has settled: before it,
no claimed row exists for an old Worker to overwrite. Treat a rollback past the
change as re-opening those overwrites (unset the env var first).

**Limit: rollback-written snapshots.** A Worker rolled back past #2295 upserts
snapshots without touching `server_cursor` (a stale value, or NULL on insert)
and without `covers_through`. After the roll-forward such a row reads as legacy
or as already read, so a claimed push can replace it although the feed never
served it. This loses no update row (a rollback-era push prunes by the old
rule), only snapshot-only content, as before #2299. A rollback runbook should
force a legacy sweep.

## 7.8 The client's baseline rule

**Normative** (`packages/sync-client/src/pull/crdt-pull.ts:162-164`). Fetch the
snapshot first when:

- the cursor is `0`; **or**
- the server advertises a snapshot whose `revision` **differs** from the
  locally stored one, whatever its `sequenceNum` (#2299; before it the rule
  also required the `sequenceNum` to be ahead of the cursor). A claimed push
  moves the watermark, and a cursor between the old and the new one is
  otherwise never told. The Rust core applies the same rule
  (`body_pull.rs::baseline_due`), reading `snapshotMeta` from the single-note
  route (§7.4.1).

Otherwise pull incrementals from `since = cursor`.

The rule exists precisely because of pruning (§7.7): updates at or below the
snapshot watermark are answered with silence, so a `since` under the watermark
MUST take the snapshot first
(`packages/sync-client/src/pull/crdt-pull.ts:155-161`). **When an old server
advertises no `snapshotMeta` at all and the cursor is not 0, the reference does
not fetch** (`:164`, the `: false` branch).

After a baseline the client stores the snapshot with its sequence number and
revision (`packages/sync-client/src/pull/crdt-pull.ts:189-194`) and advances the
cursor only if the snapshot's sequence number is ahead (`:195-197`).

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
snapshot envelope** (`apps/desktop/src/main/sync/crdt-snapshot-push.ts:90` packs
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
device until its next pull (`apps/sync-server/src/routes/sync.ts:905-913`).

## 7.13 The client snapshot obligation — Q07.2

### 7.13.1 The server never requires a snapshot

**Normative.** There is no update count, byte total, or age that triggers
server-side compaction anywhere in `apps/sync-server/src/services/crdt.ts`. **A
snapshot exists only because a client wrote one**
(`apps/sync-server/src/services/crdt-snapshot-write.ts`), and pruning (§7.7) only happens
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
   `SyncEngine.hasUnmergedRemoteCrdtState`, true for any document with a
   durable debt in `crdt_body_debts`, which engine start hydrates, or a flag
   this session raised; §7.17.5). With `coversThrough` (§7.7.1) the server
   bounds the prune by what the claim covers, but the condition stands: a
   server that predates the field ignores it;
2. the document is neither local-only
   (`apps/desktop/src/main/sync/crdt-provider.ts:559`, `:865-868`) nor purged
   (`:654`);
3. the encoded state is non-empty
   (`apps/desktop/src/main/sync/crdt-provider.ts:876-879`).

**Otherwise the client MUST NOT use the snapshot endpoint.** It MAY push the same
full state to `POST /sync/crdt/updates`, which prunes nothing
(`apps/desktop/src/main/sync/crdt-snapshot-push.ts:91`). The payload either way is
`Y.encodeStateAsUpdate(doc)` in the packed envelope
(`apps/desktop/src/main/sync/crdt-snapshot-push.ts:90`).

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
`apps/sync-server/src/services/crdt-snapshot-write.ts:43`), and it is the same token the
upsert bound, per push rather than per batch
(`apps/sync-server/src/services/crdt-snapshot-write.ts:287`). **#2187**, resolved as the
additive option: the field is new, so old clients reading these bodies through an
unvalidated cast ignore it.

**A client that sees a `revision` in the push response records it** (desktop's
`recordPushedSnapshot`; the Rust core since #2299), and names it as the
`baseRevision` of its next claimed push (§7.7.1). **A client that does not see a
`revision` in the push response MUST store a NULL local revision rather than
inventing one** — that is the case against an older
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
`apps/sync-server/src/services/crdt-snapshot-write.ts:337`), the rule chapter 05 §5.11 relies on: no reader sees a cursor
above a row that has not committed. Push requests and responses are unchanged,
and no push response carries the cursor.

- **A snapshot is re-cursored on every write**, insert and conflict alike, like
  a `sync_items` row: the upsert sets `server_cursor = excluded.server_cursor`
  (`apps/sync-server/src/services/crdt-snapshot-write.ts:114`). Its `sequence_num` stays
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
   before that upsert. A `coversThrough` push (§7.7.1) prunes only rows with
   `server_cursor <= C`, and `C` is a cursor the pusher already read from the
   feed, so those rows too committed before the upsert that reserved `s`'s
   cursor.
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
  client never sees those writes. Desktop removed the reconnect and vault
  sweeps in #2421, which ships only once the Worker is never rolled back past
  this change. A rollback still deletes desktop's legacy-sweep key on the
  first page without bodies, which puts `crdt_updated` back on the per-note
  pull and re-arms the legacy sweep for the roll-forward; edits made while the
  device's socket was down during the rollback arrive only through that sweep.
- The `crdt_updated` broadcast (chapter 09) now carries the cursor the write
  reserved (#2420), omitted when it stored nothing new; it is never a pull cursor.

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
  - It cannot close the race with the server by itself. An update another
    device commits after the encode is pruned if the server's watermark
    covers it, which is the §7.6 assumption. `SnapshotPusher` has no
    production caller yet.
  - **`coversThrough` (#2299, §7.7.1)** closes that race on a server that
    understands it. The push reads the record cursor together with its debt
    check, before the log check and the encode, and sends it once
    `sync.note_body_legacy_pull` is `done`, for a document whose server body
    it has read (`note_body_feed::covers_through`), with the revision of its
    stored server snapshot as `baseRevision`. The push records the revision the
    server answers (§7.13.4).
    A `409 CRDT_SNAPSHOT_NOT_COVERED` owes the document and answers
    `Refused(UnmergedRemoteState)`, so the next push is refused locally until
    a pull settles the debt; that pull takes the refusing snapshot, whose
    revision is not held (§7.8). A page without `noteBodies` that moves the
    record cursor (a plain pull, the CLI) and the first sync's refs pass
    delete the legacy key, so no cursor is claimed until a page that serves
    bodies owes every held document again.
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
`apps/desktop/src/main/sync/http-client.ts:27`; chapter 05 §5.3). A run from
cursor 0, which is a bootstrap or any reset of the cursor to 0, keeps the
500-row record pages. Every note and journal record it applies pulls its whole
body (the CRDT batch after each slice), and the legacy sweep below covers the
rest. A page of
a run that did not declare is read as a page without bodies: it deletes the
legacy-sweep key and discards a queued sweep, because the run moves
`LAST_CURSOR` past body rows it never serves, and a snapshot claim of that
cursor (§7.7.1) must wait for a new sweep (#2299).

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
    past that are owed; the paced drain that pays owed pulls charges its own
    GETs. Every pull outside a full sync (a wake, a reconnect, the 60 s tick)
    flushes that drain as soon as it ends, except while a full sync runs
    (whose closing flush drains it), paused or cancelled (#2421). A drained
    active-editor pull the engine refuses goes back to the pending set, and a
    pull re-queued after a failure that counted nothing (a rate limit, an
    abort) is flushed by a 60 s floor timer if nothing else does first.
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
  transaction, after its records applied and before any cursor write
  (`NoteBodyFeed.recordInPage`). Each debt is a `crdt_body_debts` row whose
  `lowest_cursor` is the lowest cursor of the note's entries on the page, or
  NULL when an entry's cursor could not be read (see "Durable body debts").

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
    write, and owed from the note's lowest page cursor (`land_failed`).
  - An abort (a vault close or switch) stops the landing and refuses nothing.
    The cursor holds, so the page is pulled again.
- **How a body lands** (`apps/desktop/src/main/sync/note-body-apply.ts:45`).
  Only a note or journal with a row here, whose doc already holds persisted
  state, takes a body.
  - It is opened without a markdown seed and merged live, so an open editor
    and the markdown write-back see it.
  - An update that changed the doc is also stored explicitly. The landing
    awaits that write and rejects if it fails
    (`apps/desktop/src/main/sync/crdt-provider.ts:823`). An update that
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
  - **A known note whose doc holds nothing:** owed its whole body
    (`missing_base`, NULL cursor), and nothing is stored. A delta merged into an empty doc can integrate in part and write
    a partial body over the file.
  - **A body the doc cannot integrate (pending structs):** the note is owed a
    whole-body pull (`missing_base`, NULL cursor).
  - **No store at all (in-memory mode):** nothing is fetched, and every entry
    that is read is owed to the CRDT pull (`note-body-feed.ts:155`).

- **Every path that applies a note or journal record pulls its whole body**,
  with one exception below. That is how a dropped body arrives. The paths are:
  - the record page (the CRDT batch after each slice);
  - the corrupt re-fetch after a page;
  - the ledger retry at pull start;
  - the deferred retry after the last page;
  - the orphan repair;
  - a socket item (chapter 09 §9.13), whose wake pull batches it.

  The re-fetch, ledger, deferred and orphan paths run the CRDT batch before
  the pull ends (`PullCoordinator.pull`). Every path goes through
  `CrdtSyncCoordinator.oweRecordBody`, which owes the note a `record` debt
  (NULL cursor) before its id joins the batch. On a record page that write is
  inside the page transaction, so the debt commits with the record, ahead of
  any cursor write. The batch pays the run's debts through the queued-pull
  path (`pullCrdtForNotes`), so an id whose row is gone by then is dropped
  with its debt (#2421).

  **The exception (#2421).** A record on a record page owes and pulls nothing
  when all of these hold (`NoteBodyFeed.servesRecordBody`, evaluated once per
  record):
  - the page carries `noteBodies` (the run declared `note_body`, so it did not
    start from cursor 0, and the server serves bodies);
  - `noteBodyLegacySweep` read `done` when the page was fetched, so no row at
    or below the cursor went unserved;
  - the note had a row here before the page applied it, so the feed landed or
    owed every earlier body row of it;
  - no entry of the note is on the page (none was skipped for its record);
  - the record did not merge as a conflict;
  - the note is not already flagged as unmerged (a debt, a failed pull, a
    broadcast);
  - the debt tables are usable, so what the feed owed survives a restart;
  - the feed never dropped a body of the id because no row existed yet. Such
    a drop is remembered in its own table, `crdt_body_withheld` (migration
    `0062`), apart from the debts: nothing lists, defers or pulls it, so no
    rowless id is owed. Every drop site writes it with the provider's claim
    hold in one helper (`NoteBodyFeed.dropRowlessBody`): a body entry with no
    row, a body whose row went while it landed, and a body skipped for a
    record on the page that did not apply and left no row. A withheld id
    reports unmerged (§7.13.2), so its pushes take `/sync/crdt/updates` and
    never prune. The whole-body walk that settles the note's debt clears it,
    and so does an applied delete tombstone for the id, row or not; a queued
    pull that drops the id as rowless leaves it. A table that is missing
    degrades to a session set. Older builds never read the table.

  Every body row of such a note above `LAST_CURSOR` is then landed by the feed
  or owed by it, and a delta the doc cannot take is owed as a missing base. A
  metadata-only edit therefore costs no whole-body pull. A run from cursor 0,
  a note created on the page, an owed note and every other path keep the rule.

- **No id without a row is ever owed or pulled.** Two places keep this:
  - `NoteBodyFeed` ledgers and owes only a note that still has a row when the
    debt is recorded (`note-body-feed.ts:262`).
  - A queued pull, from the pending pulls or the paced sweep, drops an id with
    no row before it opens a doc, and clears its flag and its debt
    (`CrdtSyncCoordinator.pullCrdtForNotes`). A note deleted after it was owed
    is therefore never merged and written back as a new file.

  The delete paths themselves record nothing.

- **Healing a refused body.** At pull start, after the pending sync intents
  drain (chapter 05, #2301), the ledger retry merges the note's whole body
  through §7.2, at most 10 notes per pull
  (`apps/desktop/src/main/sync/engine/item-recovery.ts:193`). A failed heal
  waits out the cooldown again.
  - An id with no row, or a local-only note, is resolved without a pull
    (`note-body-feed.ts:242`).
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
    (`crdt-provider.ts:847`; `apps/desktop/src/main/sync/crdt-snapshot-push.ts:110`,
    `apps/desktop/src/main/sync/crdt-snapshot-batch.ts:162`). This device's own
    snapshot then comes back through the feed as a skipped entry, not a
    download.
- **Journals.** A journal body is the same CRDT document under the journal
  record's id (§7.1), so `note_body` carries it with no extra handling.
- **`crdt_updated` is a wake once the legacy sweep is done (#2421).** With
  `noteBodyLegacySweep = done` and a frame that carries `cursor` (#2420), the
  frame schedules the same coalesced wake pull as `changes_available`, with the
  same skip filter (chapter 09 §9.11); the cursor is never the pull cursor.
  Before `done`, or for a frame without `cursor` (a server before #2420), the
  note keeps its durable per-note pull.
  - **The wake flag.** The frame records its cursor per note, session-only.
    The note reports unmerged (§7.13.2) while `LAST_CURSOR` is below it; from
    then on its body landed or left the note flagged or owed, so the entry is
    dropped and no walk is needed to clear it.
  - **The pending wake cursor.** Every wake raises one value,
    `pendingWakeCursor`, to its cursor (infinity without one). Non-null means
    a wake pull is queued or a running full sync owns it, so a later wake
    only raises it. The queued pull takes and clears it as it starts. A pull
    that a full sync refused or overlapped puts it back, and the full sync's
    end schedules the wake pull while it is above `LAST_CURSOR` (infinity
    always pulls). A reconnect that a full sync refuses raises it to
    infinity. The reconnect re-pull of open docs and
    the 15-minute, reconnect, forced and manifest vault sweeps are removed; a
    reconnect only pulls the feed. Their `lastCrdtSweepAt` row is left in place
    for older builds, which read it as their sweep throttle. Applying a Yjs
    update that a doc already holds is a no-op, so a body that still arrives by
    two paths converges; the cost is one duplicate fetch.
- **The legacy sweep.** Rows written before migration `0011` carry no cursor,
  and rows below the device cursor at first negotiation were never served as
  bodies.
  - The first page that carries a `noteBodies` array sets the sync-state key
    `noteBodyLegacySweep` to `pending` (`note-body-feed.ts:274`).
  - A full sync whose pull delivered (ran to `hasMore: false` without a refused
    page) then forces the vault-wide sweep
    (`apps/desktop/src/main/sync/engine/full-sync-runner.ts:738`).
  - Only that sweep's drain, with nothing owed back, records `done`, and only
    if the key still reads `pending` (`full-sync-runner.ts:505`). An
    interrupted or partly failed sweep stays `pending`.
  - A page without `noteBodies` while the key is set means the server stopped
    serving bodies (§7.17.3). The page deletes the key and discards the sweep
    this engine queued (`full-sync-runner.ts:528`), so that drain records
    nothing. The next negotiated page forces a new sweep.
  - A device that was offline for the whole of a server rollback never sees a
    page without `noteBodies`. It cannot tell that the rollback wrote rows with
    no cursor, so its `done` stands. Detecting this needs a server signal, such
    as a feed epoch, which this part does not have.
  - `done` is also what lets a snapshot push claim `coversThrough =
LAST_CURSOR` (§7.7.1): only then has every body row below the cursor
    either landed or left its note flagged. A CRDT store whose epoch does not
    match the data DB's deletes the key too (§7.7.1).
- **Bootstrap.** A run from cursor 0 (a bootstrap, a manifest re-pull, the
  cursor-skip repair) does not declare `note_body`, so every note and journal
  record it applies owes a durable `record` debt and pulls its whole body in
  the batch after its slice (#2421). A crash before the batch leaves the debt
  for the next engine. Besides packs, that is the run's only body path until
  the legacy sweep the next negotiated page re-arms.

#### Durable body debts (#2297 part b)

A note or journal has a row in the data-DB table `crdt_body_debts` (migration
`0060`) if and only if this device knows the server holds body state for it
that its doc has not merged
(`apps/desktop/src/main/sync/engine/crdt-body-debts.ts`).

- **Shape.** `note_id` (the CRDT doc id), `reason` (the first cause; logs and
  tests only), `lowest_cursor` (NULL: the whole body is owed), `generation`,
  `failures`, `last_failed_at`, `needs_walk`, `created_at` and `updated_at`
  (epoch ms, logs only). A second debt for the same note keeps the first
  reason and the lower cursor, and NULL wins; `needs_walk` once set stays set.
- **Pre-release tables.** Unreleased builds created `0060` without
  `generation`, `last_failed_at` and `needs_walk`. The migration's journal
  `when` is unchanged, so the migrator never reruns it there. The first use of
  the table on a database handle reads `PRAGMA table_info` and adds each
  missing column (`ALTER TABLE ... ADD COLUMN`, additive and idempotent). A
  table this build still cannot use (`no such column`) degrades like a missing
  one.
- **Generations.** Every debt raised takes the next value of one counter per
  database handle, shared by every writer in the process and seeded from
  `max(generation)`, so it never goes back, even when the table empties, and
  never reads the wall clock. A pull captures the counter when it starts.
- **Written before the cursor moves past the evidence.** Record-page debts,
  feed refusals and debts, and the notes whose feed entries were skipped
  because their record is on the page (`feed_owed` with the lowest skipped
  cursor, owed whether or not the record applies) are written inside the
  page transaction. A skipped note is owed in the slice that applied its
  record, before that slice's CRDT batch, so the batch's clean walk settles
  it; the last slice owes the notes whose record no slice applied
  (filtered, quarantined, schema-invalid or failed) and queues them for this
  session's flush, since no batch walks them (#2421). A landing failure or a missing base is written after the
  commit and before the cursor write. Snapshot refusals (#2299), a note
  leaving local-only and a compaction that dropped buffered remote updates are
  written when they happen. A rolled-back page rolls its debts back with it
  and holds the cursor. Only the sync coordinator writes the table; going
  local-only writes nothing (the OFF path owes).
- **What is session-only.** The legacy sweep writes its notes durably
  (`legacy`), so a crash mid-sweep cannot drop a note that may hold rows the
  feed never served. A `crdt_updated` frame that still takes the per-note pull
  (before `done`, or without `cursor`) is durable (`broadcast`); one that is a
  wake flags and owes nothing, because the feed re-serves that body above
  `LAST_CURSOR` after a crash. The full-state flag at runtime start (option B)
  is session-only. A session-only flag takes a generation from the same
  counter, and a walk that captured an older one does not clear it.
- **Failed pulls.** Only evidence about one note counts: the note's own
  request failing on the server (not a 429 or a 401, judged through a dead
  letter by the error it gave up on), its own payload not decrypting, or an
  update skipped because its signer could not be verified. That counts one
  failure per note per pass, writes a `pull_failed` row if the note has none,
  and defers the note at once. A rate limit, an outage or timeout, an abort,
  anything raised after the pass's signal aborted, a missing credential, and
  any failure of a chunk's shared request (the probe, a batch POST, the
  chunk's decrypt) count nothing: they re-owe an existing debt (a new
  generation) and otherwise stay in the session.
- **Dropped updates.** An update the provider refuses because the note's doc
  is closing is not in the doc: the note is flagged, owed (`pull_failed`,
  `needs_walk`, no failure counted) and its watermark dropped.
- **Settled only by a clean walk or a lost row.** A pull that walked the note's
  whole server body with no unverified update deletes the debt, guarded on
  `generation <= captured`, so a debt raised while the walk ran stands. A
  chunk's settles are one transaction. A queued id with no note row is settled
  without a pull. A local-only note is never drained, so its debt stands until
  the toggle is turned off.
- **A watermark ahead of the doc is dropped.** A compaction that dropped
  applied remote updates, or a pass that skipped or dropped an update and
  then recorded a later one, drops the note's snapshot watermark in memory and
  in the store, so the batch probe cannot settle the note without a walk. The
  row says so as well (`needs_walk`, a `compaction` reason, or `failures > 0`),
  and the probe never settles such a row: its note's watermark is dropped
  again and it takes the baseline and walk, even when a crash left the old
  watermark in the store.
- **Backoff.** A counted failure defers its note when it is counted; the
  drain defers a hydrated debt with `failures = n > 0` until
  `min(last_failed_at, now) + 2^(n-1)` minutes (capped at 32), so a clock set
  back cannot stretch it; no other debt extends it. A deferred note is not
  pending: a clean walk from any path settles it, and the legacy `done` does
  not wait for it. One timer, armed by each flush and each
  counted failure and never set past 32 minutes, fires at the earliest expiry
  and drains it. A timer that fires during a full sync only hands the notes
  back; that sync's closing flush drains them. The note stays flagged
  meanwhile.
- **Hydrated at engine start**, before the first full sync: every row becomes a
  queued pull and a flag, and that full sync's drain pays or defers it. The
  mirror conversion and the hydration fail separately, so rows already in the
  table load even when the conversion throws.
- **A missing table** (a migration that did not run) degrades to session-only
  tracking with one logged error. Loading debts, including a conversion whose
  index cache read fails (it falls back to the data DB's ids), never fails
  engine start.
- **A compaction with no sync runtime** owes the note durably all the same
  (#2421). The provider binds its vault's data DB handle and vault id when
  its store opens, and writes the `compaction` debt there while that handle
  is the open one and the table is usable; the next engine start hydrates
  it. Otherwise (the DB closed, or another vault opened since) it keeps the
  note id in its CRDT store (a reserved meta document), and owes it the
  moment a sync runtime attaches. The marker's read-modify-writes and that
  drain run one at a time, and the marker is cleared only when every owe was
  durable.
- **Claims need durable tables (#2421).** While either table is unusable, what
  was raised this session dies with it, so no snapshot push claims a cursor
  and no record takes the exception above. Each handle is probed once and the
  answer latched; a table found unusable later turns it off.
- **Teardown (#2421).** The engine's teardown disposes the full-sync runner:
  its timers are cleared and its re-queue and deferral hooks unwired, and no
  flush, pump or floor timer runs until a later full sync. A chunk that the
  teardown aborts re-queues its notes, and nothing pulls them for a vault the
  engine no longer owns.
- **Downgrade round trip (#2421).** Every `LAST_CURSOR` write also writes
  `noteBodyFeedCursor` with the same value, in the same transaction. At engine
  start a `LAST_CURSOR` that differs was moved by another build, which does not
  serve bodies into this data dir the way the feed does, so
  `noteBodyLegacySweep` is deleted: the legacy sweep, the per-note
  `crdt_updated` pull and claims-off re-arm. A missing `noteBodyFeedCursor` is
  this build's first run: it is written and nothing is reset.
  - **Residual (accepted).** That first run trusts a `done` written before
    it, even when another build moved `LAST_CURSOR` since past body rows it
    never pulled: a device that reached `done` on a build with the feed,
    downgraded to one before #2297, then upgraded straight to this build.
    It cannot be told apart from an ordinary first upgrade, so nothing is
    reset, and those rows reach the doc only through a later whole-body pull
    of the note.
- **`crdtUnmergedDebt` is a write-only mirror.** It reads `'1'` while the table
  has a row and `'0'` once it is empty, for builds before the table, which
  route every push around the prune on `'1'`. `crdtBodyDebtMirrorAt` records the
  `sync_state.updated_at` of each mirror write. At engine start a `'1'` with no
  marker, or whose row time differs from it, was written by someone else: an
  older build after a downgrade, or a CRDT store whose epoch does not match the
  data DB's (the reset deletes the marker and writes `'1'` in one transaction). It is converted once into a
  `legacy` debt for every syncable note and journal of the data DB and the
  index cache. The column has second precision, so a foreign write in the same
  second as this build's own reads as its own.
  - The conversion runs at engine start only. A store epoch reset that lands
    after the engine started (a runtime started while the store init was
    deferred) is converted at the next start; until then its notes are not
    flagged. The base had the same window once its latch had been read.
- **Still to delete (#2421 part c, gated on `minWriteVersion`).** The legacy
  sweep, the `noteBodyLegacySweep` key, the `crdtUnmergedDebt` mirror, and the
  batch probe with the sequence half of the watermarks, which only the legacy
  sweep's warm pass still needs.
