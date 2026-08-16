# CRDT & Notes Sync

Notes and journal entries use Yjs CRDTs so concurrent edits across devices merge cleanly.

## Source of Truth

The Y.Doc is canonical. Markdown is a derived, lossy export — useful for `.md` interop but not authoritative.

Which makes the corollary a rule rather than a preference: **the editor writes to the
Y.Doc whenever a vault is open — signed in or not, online or not, with an account or
with none.** An edit that does not enter the Y.Doc does not exist. It can be written to
the markdown file and to the database and still be gone, because the next thing to
rebuild the Y.Doc — a sign-in pulling this note's snapshot from the server — writes that
doc back over the file. Nothing fails to merge in that sequence; there is simply nothing
to merge.

That is not hypothetical. Until this rule was made explicit, the note editor was gated on
`isCollaborationActive(syncStatus)` — a predicate about whether a _remote sync session_
exists. With no session the editor was never bound to a Y.Doc at all, so a signed-out
edit reached markdown alone and was destroyed by the next sign-in, from the file on disk.

The two questions are now two predicates, in
`renderer/src/sync/collaboration-status.ts`:

| Predicate                       | Question                        | Read by                                      |
| ------------------------------- | ------------------------------- | -------------------------------------------- |
| `isLocalCrdtDocLive(noteId)`    | Should the local Y.Doc be live? | `ContentArea` (the editor gate)              |
| `isCollaborationActive(status)` | Is a remote session available?  | the canvas note-card lock, on its _negation_ |

Session state may decide whether anything is **synced**. It may never decide whether the
editor writes to the canonical store.

One consequence is worth stating plainly: because
[`useCreateBlockNote`](https://www.blocknotejs.org) builds its collaboration extension
exactly once per editor instance, the fragment has to be present when the editor is
created or it can never attach. So the note view waits on the binding rather than opening
a non-collaborative editor and upgrading it later — and `crdt:open-doc` waits for a store
init already in flight (`CrdtProvider.awaitPendingInit()`) instead of rejecting, since
vault open starts that init without awaiting it and a rejection would be permanent for
that editor. It waits for an init; it never starts one, because during a vault switch the
uuid it would resolve is still the outgoing vault's.

## Where Y.Docs Live

The **main process** owns Y.Doc instances, persists them to disk via y-leveldb, and exposes them to the renderer through an IPC provider.

```
renderer  ──Yjs IPC provider──▶  main (Y.Doc)  ──y-leveldb──▶  disk
                                       │
                                       └──network sync──▶  /sync/crdt/updates
```

## One Store Per Vault

The store lives in `userData`, not inside the vault folder, and is scoped to the
vault that owns the notes in it:

```
<userData>/crdt-stores/<vault uuid>/
```

The uuid is the vault's own identity — the `vault_metadata` singleton in its
`data.db`, the same value `X-Memry-Vault-Id` carries to the sync server. It is
stable across restarts, travels with the vault folder, and a linked device
adopts the initiator's value so both ends of a shared vault agree on it. The
directory name is the canonical uuid; anything that is not one is hashed rather
than placed in a path.

Scoping is not cosmetic. Store entries are keyed by **note id alone**, and note
ids are not unique across vaults: journal notes use deterministic date-based ids
(`j2026-08-13`), so two vaults' journals for the same day were genuinely one key
in the one store every install used to share.

Because the identity lives in the vault's database, the store can only be opened
once a vault is open. `CrdtProvider.initPersistence()` called before that
**defers** — it opens nothing and, importantly, does not mark itself settled, so
the vault-open path's call runs it for real. Vault open is what brings the store
up; a vault switch destroys the provider and the next vault's open brings up its
own.

### Inheriting the pre-scoping store

Installs upgrading from a build that used the single `<userData>/crdt-store`
directory hand it to the **first vault that opens after the upgrade, and to no
other**. The claim is recorded in `memry-config.json`
(`crdtStore.legacyStoreClaimedBy`) and the directory is then moved into that
vault's path. Every other vault starts from an empty store and re-seeds from its
own markdown, which is the ordinary path for a note with no stored history.

The legacy store is deliberately **not** a read fallback for every vault: its
contents belong to whichever vault last wrote a given note id, so sharing it out
would recreate exactly the cross-vault bleed scoping exists to remove. For the
overwhelming majority — single-vault installs — the one claimant is their vault,
and nothing about the upgrade is visible.

#### Documents two vaults could both have written

One claimant is not enough on its own. On an install that has opened more than
one vault, the claimant also inherits entries for ids it does not own. Random
note ids are inert — nothing ever asks for them. Deterministic ids are not: the
legacy store's `j2026-08-13` is _every_ vault's journal for that day merged into
one document, and a document that already has content is never seeded from
markdown, so the claimant would open its journal and silently get another
vault's text.

So on a multi-vault install the claim also records that those documents still
have to be set aside (`crdtStore.legacyStorePartitionPendingFor`), and the pass
runs before the provider opens the store. Each ambiguous document is copied to a
reserved `__memry_unattributable__/` name — which no note id can collide with —
and then cleared from its own, so the journal re-seeds from that vault's own
markdown while the ambiguous history stays on disk rather than being deleted.

Only an install that has known more than one vault pays for this. A single-vault
install has nothing ambiguous to set aside and inherits its journal history
whole.

#### Crash safety

The claim, and the partition it owes, are one file write made **before** the
move:

- crash after the claim, before the move → the directory is still there and
  still claimed, so the same vault finishes the move on its next launch and no
  other vault may take it;
- crash after the move, before or during the partition → the pending record
  still names that vault, and it — not the legacy directory, which by then is
  gone — is what drives the pass, so the next launch partitions the store the
  vault now owns;
- crash after both → the record is gone and the claim is settled, so there is
  nothing to apply twice.

Setting a document aside is idempotent (re-archiving replays the identical Yjs
update, which is a no-op, and clearing an already-cleared document does
nothing), so an interrupted pass is simply repeated. The record is cleared only
after a complete pass.

The move is a plain directory rename (falling back to copy+delete on a locked
Windows directory). Nothing about it bypasses the checks below: the inherited
store still goes through the full preflight, quarantine and probe — the
partition pass opens it through `openCrdtPersistence` for exactly that reason,
at the cost of one extra preflight child on the single launch that migrates.

## Persistence Resilience

Opening the store is a self-contained step that lives in `crdt-persistence.ts`,
separate from the provider that owns the Y.Docs: it runs the checks below and
hands back either a usable store or nothing, which is what puts the provider
into in-memory mode.

The classic-level native binding is first exercised in a **disposable
utilityProcess** (`crdt-preflight-child.ts`) against the **real store
directory**: a binding that hard-aborts (unsupported CPU instructions, AV
interference) — or a store whose on-disk state (torn LDB/MANIFEST from a past
crash or full disk) aborts the binding — kills that child, not the app, and
the main process then never loads the binding at all.

The child reports how far it got by writing **stage markers** to stderr
(`crdt-preflight-protocol.ts`), because the exit code alone cannot tell a bad
store from a machine that cannot start a child at all:

- `bootstrap` — the child never reached JS. Observed on Windows, where the
  utility process dies in Chromium/crashpad init with exit `0xFFFF7003`. The
  same probe is then retried as a plain node child
  (`ELECTRON_RUN_AS_NODE`), which starts no Chromium and no crash handler.
- `binding` — the child ran but the native binding failed to load. The store
  was never opened.
- `store` — the binding loaded and the probe died using it.

Only a `store` verdict implicates the store. When it fails and a store
exists, the store is **quarantined** (renamed to
`<vault uuid>.broken-<timestamp>`, next to the store it came from) and the preflight retried once against a
fresh directory: a pass means the data was at fault, so the app continues
with a fresh store; a second failure means the binding itself is broken, so
the original store is restored for a future launch and the provider goes
in-memory. Restoring first clears the partial fresh store the failed re-probe
left behind (renaming onto an existing directory is `EPERM` on Windows), and
falls back to retries and then copy+delete if the directory is still locked.
Only after the child survives is the y-leveldb store probed
in-process (a write/read/clear round-trip with a timeout) before it is
trusted. A broken `classic-level` native binding doesn't
fail cleanly — it throws outside the promise chain or hangs its callbacks — so
the probe captures both. If the probe fails, the provider degrades to
**in-memory mode**: notes still load from vault markdown and write back to
disk, and the editor keeps working; only CRDT history persistence across
restarts is lost for that session. A mid-session load failure for a single doc
falls back to seeding from the vault file instead of blocking the note from
opening.

## Why the Main Process Owns Y.Docs

- Single writer per document avoids merge complexity across renderer windows.
- Persistence via y-leveldb is a Node-side concern.
- Main can broadcast updates to multiple renderer windows (when split view exists).

## Renderer Update Delivery

Main broadcasts every CRDT update on one channel (`crdt:state-changed`), scoped to the
windows attached to that doc. Inside a window, the preload layer keeps a
`noteId → subscribers` registry behind a single channel listener, so an update is
dispatched only to the provider that owns the note. Opening ten notes still installs one
Electron listener, and a keystroke in one note does not wake the other nine providers.

Each provider subscribes with its own `noteId` before it opens the doc, so no broadcast
can land in the gap between opening a note and being wired to it. Unsubscribing the last
provider for a note drops its entry, and the channel listener is released once nothing is
listening — note close, window reload, and vault switch all take that path.

## Open Doc Lifecycle

Main keeps a Y.Doc open while an editor window is attached to it. Sync pulls may also
open a Y.Doc without a window so remote updates can be applied, but those sync-only
docs are closed again after the pull if they are still inactive.

Inactive docs are capped with least-recently-used eviction. The eviction path only
targets docs with zero attached windows, so active editor docs are never evicted. The
provider metrics expose the open doc count, encoded size, and per-doc `windowCount`
so memory growth can be observed without inspecting private provider state.

That cap bounds how many notes one sync pass may hold at a time. The batch CRDT pull
opens every note it is about to fetch before it sends the request and keeps them open
until their updates are applied, so it splits its work into chunks of
`CrdtProvider.inactiveDocCapacity`. An unsplit pass larger than the cap evicts the notes
it opened first, and their updates are then dropped as "unopened doc" — a whole-vault
pass, which is what a sign-in or a reconnect sweep produces, is several times the cap.
Chunking also keeps each request under the server's 100-note limit on
`/sync/crdt/updates/batch`.

The vault-wide sweep hands its work to that same batch path rather than pulling one note
at a time, and sizes its own chunks at `min(CRDT_SWEEP_CHUNK_NOTES, inactiveDocCapacity)`
so a paced chunk is one batch request rather than several. Batching alone is not a fix for
request volume, though: the batch endpoint batches the **incrementals**, not the snapshot
baselines, which are still fetched one note at a time inside the pass. A 121-note sweep
goes from 242 requests to roughly 125 — half, not a handful. What keeps it under the
server's limits is the pacing described in [Reconnect Recovery](#reconnect-recovery).

For the same reason, "this doc has no state" and "this doc is not open" are treated as
different answers when the pass decides whether to seed a note from local markdown. A
doc the provider closed mid-pass reports no state vector at all; seeding on that would
write this device's markdown over a body the pass never managed to apply, losing the
other device's edit rather than merely showing it late. Those notes are left for the
next pass.

Because "attached window" is what makes a doc safe from eviction, every IPC entry point
that can open a doc attributes it to the sender window — `crdt:open-doc` and the
`crdt:sync-step-1` handshake alike. The handshake matters because it can be the call that
creates the doc: `crdt:open-doc` may have been skipped or failed, or a provider reset
during a vault switch may have dropped the entry in between. A doc opened without a window
would count as inactive while an editor was typing into it, and an update that arrives
after its entry is gone is dropped rather than applied.

Attribution is released on every path that ends a window's interest in a doc, so it never
pins a doc for the rest of the session: the renderer's `crdt:close-doc` on unmount, a
`closed` hook per window for ⌘W and renderer crashes, a broadcast-time backstop for any
window that turns out to be gone, and provider teardown on vault close or switch. Once
released, the doc is evictable and compactable again.

### Rebinding After a Provider Reset

Sign-out — and any other provider reset — drops the instance that owned every open doc,
while renderer editors stay mounted. Their providers are then bound to docs nothing
serves: main goes on applying remote updates, to the _new_ instance's docs, and
broadcasts them to a window set the editor is no longer in. Nothing about that is visible
to the user, so the note silently shows stale content until it is closed and reopened or
the app restarts.

Recovering from that takes two signals, because "the binding died" and "a binding is
possible again" are not the same moment.

`crdt:provider-reset` is the first. It goes to every window — one reset strands every open
doc at once — and a provider that hears it marks its binding **stale**: it stops reporting
itself as synced, and it sends nothing. It explicitly does not re-open. The reset is
broadcast from inside teardown, with the old instance destroyed and no replacement
initialized, so `crdt:open-doc` is rejected with `CRDT provider not initialized` at exactly
that instant. A provider that answered the reset by re-opening therefore failed every
single time, logged the failure and dropped it, and stayed unbound for the rest of the
session — the same stale note the reset exists to prevent.

`crdt:provider-ready` is the second, and it is what drives the re-open. Main broadcasts it
from the one assignment that makes `crdt:open-doc` stop rejecting: the flag
`CrdtProvider.isInitialized()` reads, set when `initPersistence()` has finished opening
(or deliberately given up on) the local store. That happens once per usable provider — at
app bootstrap, and again whenever the sync runtime brings one up on vault open or
sign-in. A provider whose binding is stale re-opens its note and redoes the sync handshake
there. Re-opening is the part that matters: that is what re-attributes the window to the
fresh doc and puts the editor back in the broadcast set.

Marking the binding stale never touches the editor. The note stays mounted and fully
editable — signed out, offline, and with no account at all — because those edits exist
only in that window's Y.Doc. The doc is merged rather than replaced on rebind, and
`crdt:sync-step-1` / `-2` are what carry them across to whatever main now holds.

A rebind that fails leaves the binding stale, so the next ready signal re-drives it. That
is the retry: there is no timer and no polling loop, which matters because a reset with no
provider ever following it — the signed-out steady state — has to settle to nothing
pending rather than to a retry that runs forever.

The reset also logs how many docs had an editor attached when it happened. That is the
number the rebind has to bring back to zero, and it is the only signal that this class of
failure occurred — a stale editor is otherwise indistinguishable from a quiet note.

Local compaction runs under that same condition as closing and eviction — a doc with no
windows attached — and it is asynchronous for the same reason, so the two can be in flight
at once for one note. Compaction therefore treats the entry it captured as provisional: it
does not start on a doc that is already closing, and before swapping the compacted doc in
it re-checks that the provider's map still holds the same entry. If the note was closed —
or closed and reopened onto a fresh entry — in the meantime, the compaction is abandoned
rather than written into an entry nothing reads. Remote updates that arrive during a
compaction are buffered for it rather than applied directly, so an abandoned compaction
hands its buffer to whichever doc is live at that point instead of discarding it: the sync
coordinator counts those updates as applied and will not fetch them again.

A compaction that succeeds hands its buffer over the same way, and only after the compacted
doc has taken the entry's place and had its update handler attached. That handler is the one
funnel that stores an update, broadcasts it to open editors and schedules the vault
write-back, so replaying ahead of it would leave the compaction window's remote updates in
memory alone — absent from the CRDT store after a restart and from the note's markdown file
on disk. The compacted snapshot itself is applied before the handler is attached, on purpose:
compaction has already persisted and pushed it, and routing it through the handler would
store and broadcast the whole note a second time.

Closing is asynchronous — it flushes the doc to persistence first — so a note can be
reopened while its own close is still in flight. The reopen builds a fresh Y.Doc and takes
over the provider's entry for that note, and the close then finds that the entry no longer
belongs to it. It leaves that entry alone, because the reopened doc is the one the editor
is typing into, and destroys only the doc it superseded. Nothing can reach the superseded
doc at that point: every route into a Y.Doc looks the note id up in the provider's map,
which now resolves the replacement. That includes a write-back armed before the close —
destroying the superseded doc is not what makes it safe, since a destroyed Y.Doc can still
be read; resolving the note id when the pass runs is.

## IPC Loop Prevention

Three pieces of metadata prevent feedback loops:

1. **`sourceWindowId`** on every IPC update.
2. **Y.Doc origin parameter** distinguishes local typing, IPC re-application, and network apply.
3. **Update buffering** in `CrdtUpdateQueue` orders updates per `noteId`.

## Markdown Write-Back

Every local or remote Y.Doc update schedules a write-back that re-serializes the whole
document to its vault `.md` file and re-indexes it for search.

- **Debounce** — 500 ms after the last update, re-armed per update, so a fast typing run
  produces one write-back at the end rather than one per keystroke.
- **Cost-proportional cooldown** — a pass re-serializes the entire document, so it costs
  what the note is big rather than what the edit was. After a pass finishes, the next one
  waits until the note has been idle for nine times what that pass cost, capped at 5 s.
  Small notes never reach the 500 ms debounce floor and are unaffected; large notes settle
  at roughly a tenth of wall clock instead of saturating a core while the user types.
- **Nothing is deferred indefinitely** — the trailing pass always runs, and
  `flushPendingWritebacks()` forces any pending pass through before the CRDT provider is
  destroyed, which covers app quit and vault switch.
- **The doc is resolved when the pass runs, not when it is scheduled** — a note closed and
  reopened inside the debounce window gets a fresh Y.Doc, so the pass looks the note id up
  in the provider's map at fire time rather than serializing the doc it captured. Otherwise
  the file would be overwritten with the superseded doc's content, discarding whatever
  landed in the meantime. A note that is genuinely gone from the map — closed and not
  reopened, or LRU-evicted — still has its pending pass written from the captured doc, so
  no edit is dropped.
- **Per-vault bookkeeping** — write-back tracks self-written files and recent inbound
  network updates in short-TTL maps. Entries are evicted in an amortized pass (at most one
  sweep per TTL window) rather than scanned on every watcher event, and
  `CrdtProvider.destroy()` clears the maps outright, so no vault's note ids or file paths
  survive into the next one.

- **The export path cannot write** — a pass serializes from a detached copy of the Y.Doc,
  never the live one. The BlockNote/Yjs converter answers a node type its schema cannot
  build by _deleting_ that element; run against the live doc that turns a serialization
  gap into a real CRDT delete which replicates to every device. Reading from a copy keeps
  any such repair inside a throwaway document.
- **Write-back fails closed** — before serializing, the pass scans the fragment for node
  types this build's schema cannot construct. If it finds any, the `.md` file is left
  exactly as it is and the pass reports `writeback_unrepresentable_node` rather than
  writing a version with that content missing. The note resumes normal write-back as soon
  as the document no longer holds such a node; the refusal does not latch.
- **Constructible is not the same as serializable** — the scan above answers "can this
  build construct this node name", which is exactly the question the converter's delete
  depends on. It is not "will this node survive serialization". A node whose spec is
  registered under a key that is not its `config.type` builds fine and serializes to
  nothing, and the scan cannot see it. That invariant is enforced where it can be, at
  schema construction in `@memry/editor-schema`: a mis-keyed spec fails the schema build
  in both processes instead of quietly dropping content on the next write-back.

While a write-back is queued or mid-write the `.md` file is knowingly behind the Y.Doc, so
markdown-as-truth readers (task checkbox reconciliation) stand down for that window. Search
results and the file on disk catch up when the pass runs.

## Hybrid Sync Model

Notes flow through **both** sync paths:

- **Snapshot** — periodic full encrypted state, via the `SyncItemHandler` pipeline. Used for new devices, big diffs, and recovery.
- **Incremental** — small Yjs binary updates via `/sync/crdt/updates`. Used for live collaboration during a session.

Snapshots are pushed **pre-batch** so other devices receive correct state before the sync notification reaches them.

## Reconnect Recovery

A note body only ever travels as a CRDT update, so a remote body edit reaches a device
as a `crdt_updated` WebSocket broadcast — record changes in the pull feed carry no body.
Anything broadcast while the socket was down therefore has to be re-discovered when it
comes back.

When the socket reconnects, the engine pulls the record feed, then re-pulls the CRDT for
every note that still has an editor window attached. The rest of the LRU-cached docs —
the ones the provider retains after their editors closed — are swept too, but at most
once per five minutes, because each pull costs a snapshot fetch, paged incrementals, and
a vault-key derivation, and reconnect backoff caps at 30 seconds. A sweep suppressed by
that window is not dropped: it is paid by the next reconnect or by the 60-second pull
tick, and the vault-wide sweep at the end of a full sync covers every note regardless.

That end-of-full-sync sweep is itself gated, because `fullSync` also re-runs on auth
refresh and rate-limit release, where an O(vault) pass buys nothing. The gate reads the
WebSocket connection generation: same generation and still connected means no broadcast
could have been missed, so the sweep is skipped; a new generation means the socket
dropped and came back, so it runs. A manifest re-pull forces it, being offline skips it,
and when the socket cannot answer at all a 15-minute interval decides.

A reconnect sweep is also floored at one per 60 seconds so a flapping connection cannot
buy one pass per flap; inside the floor it is deferred on a single re-used timer rather
than dropped. That floor counts from the last sweep that actually closed a reconnect gap,
not from any sweep — measuring it against the startup or interval sweep made the first
reconnect after app start wait out the whole floor, which left the device showing a stale
body for that window.

### When the server goes away but the network does not

An unreachable **server** is not an offline **device**. `NetworkMonitor` reads OS-level
connectivity, so a server that stops answering fires no `status-changed` event: the CRDT
update queue is never paused, no full sync is scheduled when the server returns, and the
durable pending-note replay — which runs on a network transition and once per sync-runtime
start, neither of which happens here — never fires
either. Everything that heals a body edit across that kind of outage therefore rides on
the two routes above, the `crdt_updated` broadcast and the reconnect catch-up, and both
of them need the WebSocket back.

Two things have to hold for that to work, and both are load-bearing:

- **The socket must keep trying.** Every exit from `connect()` re-arms the retry,
  including the one where the access token read comes back empty. That case is not
  hypothetical during an outage: `/auth/refresh` lives on the same unreachable server, so
  roughly fourteen minutes in, the access token passes its pre-expiry margin and cannot be
  renewed. An exit that did not re-arm left the device with no socket for the rest of the
  session, and with it no broadcast and no reconnect catch-up.
- **The outbound backlog must survive.** The push function rejects rather than returns
  when credentials are momentarily unavailable, so the queue re-buffers the batch instead
  of losing it — see [Memory bounds while paused](#memory-bounds-while-paused).

### Pacing the sweep

Deciding _whether_ to sweep is not enough, because a sweep that runs fires against every
note in the vault at once. Down the one-note-at-a-time path that was two GETs per note:
121 notes meant 242 requests in about four seconds, and the server refused most of them.

The sweep is therefore drained in chunks — `CRDT_SWEEP_CHUNK_NOTES` notes every
`CRDT_SWEEP_CHUNK_INTERVAL_MS` — against **two independent server budgets**, both shared
by every device on the account:

| Endpoint                                                    | Bucket            | Limit      | Cost per chunk    |
| ----------------------------------------------------------- | ----------------- | ---------- | ----------------- |
| `GET /sync/crdt/snapshot/:noteId`, `GET /sync/crdt/updates` | `crdt_pull`       | 300 / 60 s | one GET per note  |
| `POST /sync/crdt/updates/batch`                             | `crdt_batch_pull` | 30 / 60 s  | at least one POST |

At 25 notes every 15 seconds that is 100 snapshot GETs and 4 batch POSTs per minute per
sweeping device — 200 and 8 with two devices sweeping at once, inside both ceilings with
room left for the record-change pull, pushes and attachment fetches, which draw on the
same buckets. Only the _rate_ matters, not the total: a 1,000-note vault is 40 batch
POSTs, which would blow the 30-per-minute bucket fired at once but is 4 per minute spread
over the ten minutes the paced sweep takes. Cost per minute is constant in vault size;
only the duration grows.

The batch POST figure is a floor rather than an exact count, because a chunk loops while
any of its notes still reports `hasMore`. That only binds on a first-sync backlog, and it
is no longer destructive when it happens — see below.

**Notes with a live editor skip the queue.** They are pulled in their own batch ahead of
the paced drain, because the note the user is looking at is the one whose stale body is
the bug, and a large vault's catch-up takes minutes. Their cost is bounded by the number
of open editors.

One drain runs at a time and one timer is armed at a time. A second sweep landing
mid-drain re-queues into the running one instead of starting its own, which would double
the request rate; engine teardown cancels the timer and drops the queue.

Teardown also aborts the chunk already in flight. Cancelling the timer only stops the
_next_ one, and a paced sweep spans minutes, so at teardown there is almost always one
running — it would otherwise pull into a provider and a vault the engine no longer owns,
and spend request budget for a session that is over. The abort signal is rebuilt per
drain rather than reused, because an aborted controller stays aborted and the next
engine's pulls must not start cancelled.

## Snapshot Failure Handling

A snapshot is a **compaction optimization**, not the source of truth: the authoritative
server-side state is the `crdt_updates` log. A failed snapshot is therefore recoverable,
and the write path is ordered so it stays that way.

- **R2 put before D1 upsert.** A failed put writes no metadata row, so there is never a
  row pointing at an object that does not exist.
- **Prune only after a successful store.** `pruneUpdatesBeforeSnapshot` runs only once
  the snapshot is durable, so a failed snapshot never deletes the update log behind it.
- **Transient puts are retried.** The R2 key is deterministic
  (`<userId>/vaults/<vaultId>/crdt/<noteId>/snapshot`), so a retry overwrites the same
  object and is idempotent. `putBlob` retries a transient failure twice with a short
  bounded backoff; quota and permission rejections are terminal and are not retried.
- **Failures are typed.** CRDT blob access goes through `putBlob`/`getBlob`, which
  classify R2 failures into `AppError`s (`STORAGE_UPLOAD_FAILED`, and so on). A raw
  storage error would otherwise reach the error handler as `UNHANDLED_ERROR` and make
  a transient provider incident look like an application crash in telemetry.
- **Quota refunds never mask the cause.** A reservation refund is itself a D1 write and
  can fail during a D1 incident. The refund is isolated so the original error always
  propagates; a failed refund is logged and leaves the reservation charged until it is
  reconciled.

The client mirrors this. CRDT pulls run in a **serial loop over notes**, so they do not
retry `429`s inline — honouring `Retry-After` per note would stall the whole pass, and the
sync cadence is the retry instead. A single note that fails its snapshot baseline is
skipped and retried on the next pass rather than abandoning the remaining notes.

"Retried on the next pass" is a property of the code, not an assumption: a pull that does
not complete puts its notes back into the pending-pull set, which the next cycle drains.
That covers a rate-limited chunk (all of its notes), a rate-limited snapshot baseline (only
that note), a failed single-note pull, and a batch that could not obtain credentials. The
rule is deliberately not 429-specific — a transient 5xx, an unreachable server and a rate
limit all leave the same stale body, so "failed, retry next cycle" needs no taxonomy.

Without that, a rate-limited note was logged and dropped, and its body stayed stale until
the _next_ vault-wide sweep — a 60-second reconnect floor or a 15-minute interval away.
Opening the note did not help, because that reads the main process's Y.Doc rather than the
server.

Whether a note still owes the server a snapshot is tracked per open doc as a byte count of
the local updates applied since the last successful push; closing a note and the push-all
pass both skip a note whose count is zero. A push therefore subtracts only the bytes its
payload actually covered instead of resetting the count to zero. The payload is encoded
before the push is awaited, and typing can reach the doc during that await — compaction is
the widest window, since it encodes its snapshot up front and buffers only remote updates,
not local ones. Discarding the whole count marked that edit as pushed, and the note was
then skipped until some later edit re-armed it.

## Sign-Out Keeps the Store

Signing out does **not** delete the CRDT store. It used to, and that was the
containment for the cross-vault key collision described in
[One Store Per Vault](#one-store-per-vault) — a problem the store path now makes
structurally impossible, so the wipe has nothing left to defend.

What the wipe cost was the merge history. Vault markdown survived it, but
markdown is a lossy export with no causal information in it: with no local
history left, a note edited while signed out could not _merge_ with the server's
version on sign-in. It could only be taken wholesale, or re-seeded from markdown
as an independent insertion, which duplicates the body. Sign out, edit a note,
sign back in, and the edit was silently gone.

Sign-out teardown therefore reopens the store rather than deleting it. It has to
reopen it explicitly, because stopping the sync runtime destroys the provider on
the way through, and **editing is never gated on a session** — the note stays
fully editable signed out, offline, and with no account at all. Editors bound to
the destroyed provider rebind on `crdt:provider-ready`, exactly as they do after
any other reset (see
[Rebinding After a Provider Reset](#rebinding-after-a-provider-reset)).

The editor keeps the same Y.Doc across that whole cycle. A reset marks the
binding stale, which is a statement about main, not about the doc: unbinding the
fragment would tear the editor's collaboration extension off a document it can
never re-attach to and re-arm the renderer's own markdown save against a body
main is about to merge. Signed-out keystrokes land in that doc, `crdt:apply-update`
carries them to main, and main persists them to this vault's store and writes the
markdown back — no server involved at any step.

Nothing about that reaches the push queue, and it does not need to be paused to
stay quiet: teardown drops it. `CrdtProvider.destroy()` clears the queue
reference and `resetCrdtProvider()` then replaces the instance outright, so
`onDocUpdate` has nothing to enqueue into while there is no session. The 1s flush
loop is stopped with the runtime that owned it, so a signed-out session never
retries a push and never reads the keychain for a token that is not there.

### Recording what the server is owed

Having nothing to enqueue into is not the same as owing nothing. A signed-out
edit is durable locally and **unknown to sync**: the queue never saw it, so the
queue's own shutdown recorder — which reports the updates it accepted but could
not flush — cannot report it either. Left there, the edit reached no other
device, ever; not on sign-in, not on reconnect, not on restart.

So `onDocUpdate` records the note id instead. Any non-network update that
arrives with no update queue goes to the same durable pending-note store
(`crdt-pending-notes.json`) the paused queue writes to, through the same
`recordPendingCrdtNotes`. Only the id: the update itself is already in this
vault's local CRDT store, and full doc state is what the replay pushes anyway.

The write is deduped per note for the lifetime of the queue-less stretch, so a
signed-out editing session costs one small synchronous JSON write **per note
touched**, not one per keystroke. It is eager rather than debounced because the
id has to survive a crash or a kill, and after the first update for a note there
is nothing left to pay. `CrdtProvider.init()` clears the dedupe set, so the next
queue-less stretch starts fresh.

`startSyncRuntime` drains that store once, after `crdtProvider.init()` has
installed the snapshot push function and after `engine.start()` has awaited the
first full sync. Signing in runs `startSyncRuntime`, which is what makes a
signed-out backlog reach the server **with no further user input**; leaving the
replay to `NetworkMonitor` alone was not enough, because signing in is not a
network transition. `drainPendingCrdtNotes` is re-entrant-safe and clears an id
only once its state has actually reached the server, so the startup replay and a
network-transition replay firing together cannot double-push, and a
still-offline start leaves the entry queued for the next attempt.

Notes that no longer exist, or never sync via CRDT (binaries), are dropped at
drain time rather than retried forever, and a doc with no content is not pushed
at all — a snapshot is a full note body and an R2 write, so the replay only pays
for notes that need it.

### Merge before push, and fail closed

A snapshot push is not an addition, it is an **assertion**: `storeSnapshot` is
followed by `pruneUpdatesBeforeSnapshot`, which runs

```sql
DELETE FROM crdt_updates WHERE user_id = ? AND vault_id = ? AND note_id = ? AND sequence_num <= ?
```

bound to the new snapshot's sequence number. The server takes the pushing device
at its word that the snapshot contains everything up to that point. Push a
snapshot for a note whose peer edits this device has not merged, and those edits
are deleted from the server _and_ absent from the snapshot — destroyed for every
device.

The pending list is exactly the notes this device edited while it could not
push, which is also the population most likely to have diverged from a peer, so
the merge is mandatory. `drainPendingCrdtNotes` therefore pulls and merges each
note's server state (`SyncEngine.mergeRemoteCrdtForNote` →
`CrdtSyncCoordinator.pullCrdtForNote` → `applyRemoteUpdate`) **immediately
before that note's own push**.

Per note, not "once the sweep finishes": the vault sweep is paced at 25 notes /
15 s, so waiting on it would stall the replay for minutes and still not
guarantee a given note had been reached. Being placed after `engine.start()` is
necessary — the first full sync is awaited there — but not sufficient, because
that sync only _queues_ the paced body sweep.

A pull that does not complete leaves the note pending and **unpushed**.
`pullCrdtForNote` returns `false` for every incomplete outcome: missing token or
vault key, an abort, a rate-limited or failed baseline or incrementals fetch.
Being late is recoverable — the next runtime start or network transition retries
— while deleting another device's edits is not.

Cost: one extra snapshot GET plus at least one incrementals GET per replayed
note, both on the `crdt_pull` bucket (600 / 60 s per device). The pending list is
tens of notes in practice, so ~40–50 GETs, alongside the paced sweep's 100/min —
comfortably inside the budget, and no pacing is added.

## Sign-Out / Sign-In Ordering

A sign out → sign in cycle has a sharp ordering rule:

```
engine.start()       # pull from server FIRST
  └─ seedExistingCrdtDocs()   # fire-and-forget; only fills truly orphaned notes
```

Reversing this order causes split-brain: stale markdown seeds Y.Docs with new client IDs, server pull then sees non-trivial state vectors and skips bootstrap, and the device diverges.

## CrdtUpdateQueue

A separate queue from `SyncQueueManager`:

- Handles binary `Uint8Array` updates
- Respects sequence ordering per `noteId`
- Buffers updates when the network is paused

### Memory bounds while paused

While the queue is paused (offline, expired token, storage quota) nothing drains, so the buffers are capped on two axes:

- **Per note** — a buffer that reaches the batch size is merged in place with `Y.mergeUpdates`, and merged updates and flush payloads are size-bounded. Merging is lossless; a long offline edit costs the size of the edit, not one array per keystroke.
- **Across all notes** — the queue also caps its total buffered bytes, because the map keeps one live buffer per note touched since the pause. Crossing the ceiling first flushes whatever the server will take and merges every buffer, and only if that is not enough does it release the oldest notes' payloads.

A release is never a drop. The note ids go to the durable pending-note store (`crdt-pending-notes.json`) **before** their payloads are freed, and `drainPendingCrdtNotes` pushes each note's full doc state — which supersedes the buffered updates — on the next reconnect or app start. If no durable store is wired up, or recording fails, the queue keeps the memory instead of releasing it.

The same store carries edits the queue never saw at all, because there was no queue: see [Recording What the Server Is Owed](#recording-what-the-server-is-owed). For those, full doc state is not merely a superset — it is the only shape available, since a queue-less edit produced no incrementals to replay.

### A failed push keeps its batch

`flushNote` takes a note's updates out of its buffer before it calls the push function, so only a **rejected** push puts them back. The push function therefore has to reject, not return, whenever it cannot send — including when the access token, vault key or device signing key is momentarily unavailable. That is never the signed-out steady state (the sync runtime does not wire the queue up at all without a session, a paid plan and a verified vault key), so a missing credential there is one that went away mid-session and will come back. The only exception is a non-retryable 4xx that is neither 429 nor 401, which the queue discards on purpose.

## BlockNote Compatibility

BlockNote uses Yjs natively. The renderer's BlockNote editor binds to the renderer-side Y.Doc proxy provided by the IPC provider; edits flow through main and back to disk.

Markdown cannot represent arbitrary nested BlockNote paragraphs. Note markdown export and CRDT writeback preserve those unsupported child blocks with hidden nesting markers, then restore them when a note reloads. Inbox note reload also reads BlockNote's saved `data-nesting-level` HTML metadata so captured note indentation round-trips through the editor.
Marker parsing trims imported markdown with a linear scan so malformed or very large note bodies cannot trigger regex backtracking during reload.

### The schema is a cross-process contract

The custom node types memrynote adds to BlockNote — wiki links, hash tags, link and date
mentions, and the custom blocks — live in the `@memry/editor-schema` workspace package so
both processes can build from one definition. This matters more than a shared-code tidy-up:
the main process converts the shared Y.Doc through y-prosemirror, which deletes any element
whose node name its schema does not know. A spec registered on only one side is data loss,
not a missing style — the same class of cross-process contract that [IPC](/architecture/ipc)
gates with `ipc:check`.

The package owns each node's config, `parse` and `toExternalHTML` — the half that decides
what reaches the vault file — and each process supplies its own presentation. The renderer
gives the editor chip; the main process gives an implementation that emits the node's plain
markdown form.

**Main's implementations are not decoration.** BlockNote serializes inline content inside a
**table** through the spec's `render`, not through `toExternalHTML`, so for that one block
type main's rendering is what lands on disk. A `render` that throws makes the whole note's
conversion fail — it stops writing back rather than losing a cell — and a `render` carrying
the editor's rich markup rewrites the cell: a link mention's `((mention:…))` token becomes a
plain markdown link and its domain, title, favicon and site name are gone. Every server-side
`render` therefore emits exactly what `toExternalHTML` emits. No spec is shared whole.

Whatever still cannot be represented is caught by the fail-closed guard in
[Markdown Write-Back](#markdown-write-back).

The custom **blocks** — `callout`, `youtubeEmbed`, `bookmark`, `file` and `taskBlock` — work
the same way. `file` is worth calling out: the renderer overrides BlockNote's default `file`
spec, so before the config was shared the main process built the _default_ one and wrote
`[name.pdf](url)` where the vault file held `<!-- file:{…} -->`, dropping size, MIME type and
any width/height/alignment.

Main is also the parser. A note's Y.Doc is seeded from its vault file in the main process
(`crdt-provider.ts`), and the renderer does not parse markdown when a Yjs fragment is
present — so the `<!-- file:… -->`, `![embed](…)` and `![bookmark](…)` marker lines are
recognised there, using the same rules the renderer uses on its own save path. Markers
inside a code fence are the author's text and stay text; the fence tracker follows
CommonMark, so a longer fence quoting a shorter one is not mistaken for a closing one.

Callouts are deliberately **not** parsed back. Their marker carries a type and an optional
title that the block config cannot hold, and the renderer's parser coerces any unrecognised
type to `info`. Parsing them on this path would rewrite `> [!note]` as `> [!info]` in every
Obsidian-authored vault, so a callout read from a file stays a quote block and its bytes stay
untouched. A callout created in the editor round-trips through the live document normally.

## Files Worth Knowing

```
apps/desktop/src/main/sync/
├─ crdt-store-path.ts       # per-vault store path + legacy-store migration
├─ crdt-legacy-partition.ts # sets aside inherited docs no vault can claim
├─ crdt-update-queue.ts
└─ engine.ts                # ordering: pull → seed → per-batch push

apps/desktop/src/renderer/src/sync/
├─ yjs-ipc-provider.ts      # renderer-side Y.Doc proxy
└─ use-yjs-collaboration.ts # editor hook
```
