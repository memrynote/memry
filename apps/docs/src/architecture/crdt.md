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

### When the vault's uuid changes

A vault's uuid is stable for as long as it stays open, with one exception:
**device linking**. A device joining an existing vault adopts the account's uuid
(`adoptVaultLocally`), rewriting the `vault_metadata` singleton in place — and
the store directory is named after the value that function replaces.

Nothing breaks in the session where it happens; the directory is already open
and stays open. The next open is the problem: it resolves the adopted uuid,
finds no directory, and every note re-seeds from markdown as an independent
insertion instead of merging with the history the device already had.

So the adoption records where the store is (`crdtStore.pendingRenames`, adopted
uuid → the name the directory still has), and `prepareVaultCrdtStore()` moves it
before the store is opened. Doing it there rather than inside the linking flow
is deliberate: at that point the previous provider has always been destroyed
(`closeVault` awaits `destroy()`, which closes LevelDB, before
`resetCrdtProvider()`), so the directory is never moved out from under an open
LevelDB lock.

The record is written **before** the uuid it describes, for the same reason the
legacy claim is written before its move:

- crash after the record, before the rewrite → the vault still has its old uuid,
  so nothing fires and the store opens where it always was. The entry names a
  uuid no vault holds and is inert; retrying the link records it again,
  identically;
- crash after the rewrite, before or during the move → the record still names
  the old directory, so the next open finishes the move;
- crash after both → the record is cleared and there is nothing to redo.

Two edges are handled by leaving things alone rather than guessing. If the
adopted uuid **already** has a store — two local vaults claiming one uuid, or a
copy+delete whose delete failed — neither directory is touched and the record
stays pending, because the destination is somebody's history too. And a uuid
that changes twice before the store is next opened collapses onto the directory
that was actually written, rather than pointing at a middle name no directory
ever had.

The rename settles **before** the legacy inherit above. Both want to move a
directory into this vault's name and only one can: the pre-adoption store is
history this vault provably wrote, while the legacy store is history it can only
claim.

A device that linked under a build without this has an orphaned directory under
`<userData>/crdt-stores/<old uuid>`. Nothing recovers it automatically — the old
uuid was never recorded, and guessing from the directory listing is how the
wrong vault's history gets attached. No note content is at risk (markdown is the
source of truth); what is lost is the merge history, so those notes behave like
notes the account has never seen.

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
  utility process dies in Chromium/crashpad init with exit `0xFFFF7003`.
- `binding` — the child ran but the native binding failed to load. The store
  was never opened.
- `store` — the binding loaded and the probe died using it. The child also
  announces each store operation _before_ running it (`open`, `write`, `read`,
  `clear`, `close`), so a native abort — which unwinds nothing — still names
  the operation that was in flight.
- `binding-in-use` — a `store` failure that reproduced against an empty
  directory. Not a marker the child can write; the provider assigns it (below).

A `bootstrap` **or** `store` failure is retried once as a plain node child
(`ELECTRON_RUN_AS_NODE`), which starts no Chromium and no crash handler. A
verdict reported with `transport: node` therefore means the Chromium-free
fallback failed too — the binding is broken on that machine rather than the
utility process being unable to start.

Only a `store` verdict implicates the store, and it has to prove it. Before
anything is moved, the same probe is run against an **empty control directory**
(`<store>.probe`, cleared before and after use) that the user's data cannot be
responsible for:

- **Control passes** — the data was at fault. The store is **quarantined**
  (renamed to `<vault uuid>.broken-<timestamp>`, next to the store it came
  from) and the app continues on a fresh store, reseeded from vault markdown.
  Moving falls back to retries and then copy+delete if the directory is locked.
- **Control fails** — the binding is at fault and the data is innocent. The
  store is **not touched at all**, and the failure is restaged as
  `binding-in-use` so telemetry stops reporting a data problem that does not
  exist.

If the control directory cannot be cleared, no control is run and the store is
left alone: no evidence means no reason to move a user's CRDT history.

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

### What else the store holds

Besides each note's update log and state vector, the store holds one **snapshot
watermark** per note — `{ appliedSequence, snapshotRevision }`, written as a
y-leveldb document meta key. It is what lets the vault-wide sweep skip a
snapshot baseline the document already contains, across app restarts and a fresh
sign-in (see
[the sweep's conditional baseline](/architecture/sync-protocol#the-vault-sweep-s-conditional-baseline)).

It lives here rather than in the index DB or in settings because a watermark
that outlives the document it describes makes the sweep skip that baseline
forever, leaving a permanently stale body. Inside the store, the two share one
lifetime by construction:

- a meta key is inside the key range `clearDocument` clears, so purging a note
  or setting a legacy document aside drops its watermark in the same operation;
- quarantine, a rebuild and a re-path all move or destroy the whole directory,
  so watermarks travel with the documents or vanish with them;
- in-memory mode has no store handle at all, so nothing is read and nothing is
  written — every note falls back to downloading its baseline.

Losing a watermark costs one extra request. Keeping a stale one costs a note
body, so every unknown — no record, an unreadable record, a store written by a
build that predates the key — resolves to "download the baseline".

### Telling the user

In-memory mode is silent by design for one launch — a store that quarantined
itself is usually healthy on the next one. It is not silent forever. Each
launch records its outcome once (the first store it opens; a vault switch does
not count again) as a consecutive-degraded-launch streak in
`memry-config.json` under `crdtStore.inMemorySessions`, reset to `0` the moment
a store opens. After **three consecutive launches with no durable store**, the
app shows one calm notice: notes are safe — vault markdown is the source of
truth and still loads and saves — but this device's edit history and merge
state are running in memory and start fresh each launch.

The renderer **pulls** this over `crdt:get-health`
(`window.api.syncCrdt.getHealth()`) rather than being pushed it: the store's
verdict lands while the window is still loading, so a broadcast would routinely
arrive before anything was listening. The streak is persisted, so the answer is
correct whenever it is asked.

There is deliberately no bounded retry of a failed store open within a session.
The failure it guards against is a native abort in the binding, which in the
field is deterministic per machine rather than transient, and every retry costs
a multi-second child process on the launch path. The one transient-shaped cause
— a utility process that cannot boot — already gets its retry on the
Chromium-free transport inside a single open.

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

## Undo Belongs to the Doc, Not the Plugin

With a Yjs fragment bound, undo is no longer ProseMirror's `history` plugin — it is a
`Y.UndoManager` scoped to the note's fragment, created once by y-prosemirror's yUndo
plugin and shared by every surface on that doc.

That manager does not survive a plugin registration on its own. ProseMirror rebuilds
**every plugin view** whenever `state.plugins` changes identity, which
`registerPlugin` / `unregisterPlugin` both do, and the yUndo view destroys the manager on
teardown. `reconfigure` keeps plugin _state_, so the replacement view hands back the same
destroyed manager: detached from the doc's `afterTransaction` and dropped from its own
`trackedOrigins`. Nothing is captured after that, and undo is a silent no-op for the rest
of the session.

So a plugin registered after mount goes through
`content-area/register-editor-plugin.ts`, which re-arms both on the way in and on the way
out. The editor registers three that way today — CriticMarkup decorations, the `@`-date
ghost, and the hash-tag inline plugin — and any new one must take the same path.

This only became reachable once every note got a local Y.Doc: before that, a signed-out
editor fell back to ProseMirror's `history`, whose state survives a view rebuild.

## Open Doc Lifecycle

Main keeps a Y.Doc open while an editor window is attached to it. Sync pulls may also
open a Y.Doc without a window so remote updates can be applied, but those sync-only
docs are closed again after the pull if they are still inactive.

Inactive docs are capped with least-recently-used eviction. The eviction path only
targets docs with zero attached windows, so active editor docs are never evicted. The
provider metrics expose the open doc count, encoded size, and per-doc `windowCount`
so memory growth can be observed without inspecting private provider state.

That cap bounds how many notes one sync pass may hold at a time — but only the **apply**
phase of it. The apply phase opens every note it is about to fetch before it sends the
request and keeps them open until their updates are applied, so it splits into sub-chunks
of `CrdtProvider.inactiveDocCapacity`. An unsplit pass larger than the cap evicts the
notes it opened first, and their updates are then dropped as "unopened doc" — a
whole-vault pass, which is what a sign-in or a reconnect sweep produces, is several times
the cap.

The **probe** phase is not bound by it, because it opens no document at all. Its only
ceiling is the server's 100-note limit on the `notes` array of
`/sync/crdt/updates/batch`, so `applyCrdtBatch` chunks at 100 and sub-chunks the apply
phase at the doc cache inside each one. Sizing the outer loop at the doc cache instead
would spend one probe request per 32 notes rather than per 100, and the probe request is
the entire cost of a warm sweep.

The vault-wide sweep hands its work to that same batch path rather than pulling one note
at a time, and sizes its own chunks at `CRDT_SWEEP_CHUNK_NOTES` — the probe's size.
Batching alone is not a fix for request volume: the batch endpoint batches the
**incrementals**, not the snapshot baselines, which are still fetched one note at a time
whenever a baseline is actually needed. A cold 121-note sweep goes from 242 requests to
roughly 125 — half, not a handful. What keeps it under the server's limits is the pacing
described in [Reconnect Recovery](#reconnect-recovery).

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
  destroyed, which covers vault switch.
- **A quit flushes write-backs first, not last** — the provider is destroyed at the _end_
  of the shutdown chain, so relying on `destroy()` alone meant a slow teardown step could
  spend the whole shutdown budget and the forced exit would kill the process with the
  debounce timers still armed, losing up to 5 s of typing. `before-quit` therefore runs
  the window flush and `flushPendingWritebacks()` as its first two steps, and runs the
  write-back flush again — followed by `closeAllDatabases()` — on the timeout and
  cleanup-error paths before it force-exits. See
  [Shutdown Budget](/architecture/observability#shutdown-budget).
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
- **An empty serialization of a note that is not empty is refused** — empty markdown is a
  real body, the body of a note nobody has written in, so the pass cannot simply reject
  every empty result. It uses the document's own emptiness to tell them apart: every block
  a note holds is a `blockContainer`, so a fragment that holds one and converts to no
  blocks means the converter's repair deleted the whole document on the way out. The scan
  above stays silent for that — an emptied table row is still a registered node name — so
  without this the emptied file would be written and replicated. The pass keeps the file
  instead, and reports it the way it reports a failed conversion.

While a write-back is queued or mid-write the `.md` file is knowingly behind the Y.Doc, so
markdown-as-truth readers (task checkbox reconciliation) stand down for that window. Search
results and the file on disk catch up when the pass runs.

## Hybrid Sync Model

Notes flow through **both** sync paths:

- **Snapshot** — periodic full encrypted state, via the `SyncItemHandler` pipeline. Used for new devices, big diffs, and recovery.
- **Incremental** — small Yjs binary updates via `/sync/crdt/updates`. Used for live collaboration during a session.

Snapshots are pushed **pre-batch** so other devices receive correct state before the sync notification reaches them.

## Local-Only Notes Keep Their Body

A note marked **Local only** never sends its body to the server. The record feed has always
honoured this — `seedUnclockedNotes` excludes `localOnly IS NOT 1`, `incrementNoteClockOffline`
returns early, `buildNotePushPayload` returns `null` — and the CRDT body path now does too.

The flag is cached on the open doc, read once from the `note_cache` row in `doOpen`.
`onDocUpdate` runs on every keystroke and cannot afford a database round-trip; opening a doc
already pays an async store read plus, usually, a file stat, read and markdown parse, so one
more primary-key lookup there is not measurable. `setNoteLocalOnlyState` corrects the cached
flag in place after it writes both databases, so toggling takes effect on the next keystroke
rather than the next time the note is closed and reopened.

Five paths send a body, and each refuses independently:

| Path                              | Guard                         |
| --------------------------------- | ----------------------------- |
| `onDocUpdate` → `CrdtUpdateQueue` | cached flag on the doc        |
| `close()` snapshot                | cached flag on the doc        |
| `pushAllSnapshots()` at shutdown  | cached flag on the doc        |
| `compactDoc()` snapshot           | cached flag on the doc        |
| `pushSnapshotForNote()`           | re-reads the `note_cache` row |

`pushSnapshotForNote` re-reads the row because it is the one push path reached for a note with
no open doc — the pending-note replay and the push coordinator's `create` both land there.
`CrdtSyncCoordinator` re-reads it as well, through the same `isNoteLocalOnly`, for the pull side
described below.

`pendingSnapshotBytes` keeps counting for a local-only note. It means "written locally, not yet
on the server", which stays true, and suppressing it would make three of the guards above look
redundant when they are the only thing holding the body back.

Nothing local changes. The Y.Doc, the local CRDT store, the window broadcast and the markdown
write-back all sit upstream of the single branch that sends bytes, so a local-only note edits
exactly like any other — signed out, offline, or with no account.

### Clearing the flag owes the server the whole document

Turning **Local only** off is the case that would otherwise lose data. Nothing else pushes an
existing note's body: the push coordinator's CRDT snapshot is gated on `operation === 'create'`
and clearing the flag raises an `update`, an update payload carries `content: null`, and the
vault sweep only pulls. The note would resume syncing its metadata with its body frozen wherever
the server last saw it.

So `setNoteLocalOnlyState` records the note in the durable pending-CRDT store when the flag
clears. `drainPendingCrdtNotes` then pushes full document state — pulling and merging the
server's state first, and keeping the id until that push actually lands. Setting the flag clears
that record instead, the CRDT twin of the `removePendingNoteSyncItems` call beside it; nothing is
lost, because the updates stay in the local store and a later clear re-records the note, whose
replay pushes full state anyway.

Either direction also drops the doc's snapshot debt, so the next `close()` cannot fire a _blind_
snapshot ahead of the merge-first replay. A snapshot asserts completeness and the server prunes
every incremental below it, and a note that has just stopped being local-only is the population
most likely to have diverged from a peer.

### The pull half, and the flush window

The setting reads as "this note and the server have nothing to do with each other", so the pull
side refuses too. `CrdtSyncCoordinator.applyCrdtIncrementals` returns before it opens the doc,
and `applyCrdtBatch` filters the list before it chunks it — so the paced vault sweep, the
`crdt_updated` broadcast and the pending-note drain all skip a local-only note, and none of them
spends `crdt_pull` budget on a note that can never push. Filtering before the chunking matters:
each paced chunk stays filled with notes that can actually sync.

A skipped note is deliberately **not** owed a retry. `owePendingPull` there would be a debt
nothing can ever settle, and the note would be re-queued in every sweep for the life of the
session. Its `unmergedRemoteNotes` flag is left standing instead — free while the note cannot
push, and the conservative answer for its first push if the flag is ever cleared.

Setting the flag also empties the update queue's buffer for that note. `onDocUpdate` reads the
flag at _enqueue_ time but `CrdtUpdateQueue` flushes on a ~1 s loop, so everything typed in the
second before the toggle is already past the guard. `CrdtUpdateQueue.dropNote` discards it —
nothing is lost, because those updates are also in the local CRDT store — and
`CrdtProvider.setNoteLocalOnly` calls it ahead of its `docs` lookup, so a note whose doc the LRU
has already evicted is covered too. A push already in flight cannot be recalled, but a retryable
failure no longer re-buffers its batch, which would otherwise have pushed it seconds after the
note stopped syncing.

Finally, the pending-note replay asks `CrdtProvider.isNoteSyncable` — `validateNoteForCrdt`
plus the local-only check — rather than `validateNoteForCrdt` alone, so an id that reached the
durable store through that race is cleared instead of retained forever. The two halves stay
separate because `validateNoteForCrdt` also gates the renderer's editor handshake, where a
local-only note must still open and edit like any other.

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

**A sync the user asked for by name forces it.** "Sync now" is the escape hatch for a note
that looks stale, and it is the one caller that cannot flap, so it sweeps whatever the gate
would otherwise have said. Without that, a live socket that provably missed no broadcast
still answered the button with "nothing to fetch" — and if the broadcast had in fact been
lost (the device was offline at the HTTP layer while its socket stayed nominally up), the
body stayed stale for the whole 15-minute interval with the app reporting a clean sync.
The throttle still applies to every automatic caller: reconnects, auth refresh, and
rate-limit release.

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

The sweep is therefore drained in **paced chunks of `CRDT_SWEEP_CHUNK_NOTES`** against
**two independent server budgets**, both keyed by device rather than by account:

| Endpoint                                                    | Bucket            | Limit      | Spent by                         |
| ----------------------------------------------------------- | ----------------- | ---------- | -------------------------------- |
| `GET /sync/crdt/snapshot/:noteId`, `GET /sync/crdt/updates` | `crdt_pull`       | 600 / 60 s | the apply phase                  |
| `POST /sync/crdt/updates/batch`                             | `crdt_batch_pull` | 30 / 60 s  | the probe, and every apply round |

The margin is **never more than 50 % of either bucket**. The other half pays for editor
traffic, the un-paced priority batch, broadcast-driven single-note pulls, and a second
sweep a flapping socket may start before the first has drained. That gives 300 GET/min and
15 POST/min, or **200 ms per snapshot GET** and **4 s per batch POST**.

**Two paces, not one.** Since the snapshot baseline became conditional, the two phases of
a chunk spend different buckets and cannot share a cadence:

- the **probe** is one `POST /sync/crdt/updates/batch` with `limit: 1` for the whole
  chunk. It opens no document and downloads no snapshot, so the doc cache does not bound
  it and it is sized at the server's 100-note cap;
- the **apply** phase opens each remaining note, fetches its baseline if the probe could
  not rule it out, and loops the batch endpoint for incrementals. It is bounded by
  `inactiveDocCapacity`.

100 notes every 4 s is the right warm pace and 1,500 GET/min if the chunk turns out to be
cold; 32 notes every 6.4 s is the right cold pace and takes a warm 1,000-note vault three
and a half minutes to confirm nothing changed. So the interval is **charged, not fixed**:
`pullCrdtForNotes` returns what the chunk actually spent per bucket, and the next chunk
waits for the slower of the two to earn it back —

```
delay = max(CRDT_SWEEP_CHUNK_INTERVAL_MS,
            batchPosts   * CRDT_SWEEP_MS_PER_BATCH_POST,
            snapshotGets * CRDT_SWEEP_MS_PER_SNAPSHOT_GET)
```

Both rates are then ≤ 50 % by construction, in every regime, without the client having to
know in advance which regime it is in — which it cannot, because that is what the probe is
for. For a 1,000-note vault:

| Regime     | Per 100-note chunk                   | Charged delay | GET/min    | POST/min  | Wall clock  |
| ---------- | ------------------------------------ | ------------- | ---------- | --------- | ----------- |
| Warm       | 1 probe POST, 0 GETs                 | 4 s           | 0 (0 %)    | 15 (50 %) | ~40 s       |
| Cold       | 100 GETs, 4 apply POSTs, no probe    | 20 s          | 300 (50 %) | 12 (40 %) | ~3 min 20 s |
| Old server | one wasted probe, then the cold cost | 20 s          | 300 (50 %) | 12–15     | ~3 min 20 s |

Before this, at 25 notes every 15 s with an unconditional baseline, all three regimes cost
100 GET/min and 4 POST/min and took **ten minutes**. A cold vault costs no probe at all —
no note has a watermark, so nothing could be skipped and the request is not sent.

The batch POST figure is a **floor rather than an exact count**, because an apply
sub-chunk loops while any of its notes still reports `hasMore`. That is precisely why the
counts are measured rather than predicted: at one round per sub-chunk the GET slice binds,
and from two rounds the POST slice binds and the sweep slows down instead of bursting
through the batch bucket. A fixed 6.4 s interval with two rounds would have been 64 POSTs
across 200 s — 64 % of the bucket, silently.

Only the _rate_ matters, not the total: cost per minute is constant in vault size and only
the duration grows, so no vault can reproduce the 242-requests-in-4-seconds storm. For the
same reason the per-note snapshot GETs inside a chunk stay **serial**; firing them in
parallel is that storm again, whatever the chunk size.

The sweep is paced, never **selective**. Every note in the vault is still named in every
pass; these numbers decide what a note costs, never whether it is looked at. Note bodies
never travel in the record change feed, so the sweep is the only channel by which a
body-only remote edit reaches a device that missed the broadcast.

**Notes with a live editor skip the queue.** They are pulled in their own batch ahead of
the paced drain, because the note the user is looking at is the one whose stale body is
the bug, and a large vault's catch-up takes minutes. Their cost is bounded by the number
of open editors.

#### Sweep priority

A paced drain on a large vault takes minutes, and it is FIFO, so the order the work list
arrives in decides which stale body a user watches get repaired first. There are three
tiers:

1. **Notes with a live editor** — pulled in their own batch, outside the pace, as above.
2. **Open-but-inactive docs** — everything `crdtProvider.getOpenNoteIds()` reports minus
   the active set, spliced in at the _front_ of the paced queue. The provider's LRU is
   already a list of up to 32 recently-opened notes held in memory, so this costs nothing
   to read and names exactly the notes the user is one click away from. It is front-
   inserted rather than appended because a sweep landing mid-drain would otherwise put
   those notes behind everything the previous pass still had waiting.
3. **The rest of the vault**, `modifiedAt DESC` — `getAllCrdtNoteIds` orders by
   `note_cache.modified_at`, covered by the existing `idx_note_cache_modified`. A note
   that changed recently, by this user or by the device being caught up with, is both the
   likeliest to actually be stale and the likeliest to be opened next.

Priority is never filtering. The sweep is the only channel by which a body-only remote
edit reaches a device that missed the `crdt_updated` broadcast — bodies do not travel in
the record change feed — so every markdown note still enters the queue, exactly once, and
only its position changes. A vault whose mtimes are uniform (restored from backup,
freshly cloned, bulk-imported) simply falls back to an arbitrary tail order.

Notes a chunk failed are re-added to the pending set by `owePendingPull`, so they rejoin
at the _end_ of the next drain rather than at the front: a note that just failed is the
worst candidate for an immediate retry.

Ordering changes perceived latency only. It does not change the request count, the
request rate, or how long a full catch-up takes — the budgets above are untouched.

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

That is a property of teardown, not of sign-out. `teardownSession` takes a
reason, and every reason that leaves the app running reopens the store:

| Reason      | Reopens the store | Why                                                                                                                                                                                                              |
| ----------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `logout`    | yes               | The user signed out and kept working. Editing is never gated on a session.                                                                                                                                       |
| `integrity` | yes               | An involuntary sign-out, triggered when the device signing key reads back absent. The user did not ask for it and is not told the editor went read-only, so leaving the provider dead here is worse, not better. |
| `shutdown`  | no                | The app is quitting: no editor is left to serve, and the vault uuid the store is scoped to is read from a data DB that `closeVault()` is about to close.                                                         |

The store path resolves through `getOrCreateVaultUuid` against the open data DB,
which is why `shutdown` is the exception rather than a harmless no-op — a reopen
racing the close would leave a freshly opened LevelDB store behind on the way
out. Nothing routes an app quit through `teardownSession` today; `before-quit`
calls `stopSyncRuntime()` directly and then `closeVault()`.

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

That write is **crash-atomic**, because a recorder whose whole purpose is to
survive a crash cannot be the thing the crash truncates. The full list is staged
in a fresh temp file in the same directory — `rename` is only atomic within a
filesystem — flushed, then renamed over the live path, so the previous list
stands until a complete replacement is in place and there is no moment where the
store holds half a JSON array. The flush is one `fsync` per note touched, not per
keystroke, which is what the per-note dedupe buys. Clearing the last id still
unlinks the file: unlink is already atomic, and "no file" has always meant
"nothing pending".

A store that does not parse is **preserved, salvaged, and reported** rather than
treated as an empty backlog. Failing open would be right for a cache; this file
is the only record that a signed-out edit is owed to the server, so reading it as
"nothing pending" discards that debt in silence. The damaged bytes are moved to
`crdt-pending-notes.corrupt.json` — one fixed name, so a device with a failing
disk cannot accumulate copies in userData forever — every complete `"id"` token
still in them is recovered, and the recovered list is written back to the live
store so the drain's second read (`clearPendingCrdtNotes`) does not find it gone.
An id the damage landed inside is a prefix, not an id, and is lost; a recovered
string that is not really a note id costs nothing, because the drain checks
`isSyncable` before it pushes. The on-disk format is unchanged — a plain JSON
array of note ids at the same path — so stores written by older builds read
exactly as before.

`startSyncRuntime` drains that store once, after `crdtProvider.init()` has
installed the snapshot push function and after `engine.start()` has awaited the
first full sync. Signing in runs `startSyncRuntime`, which is what makes a
signed-out backlog reach the server **with no further user input**; leaving the
replay to `NetworkMonitor` alone was not enough, because signing in is not a
network transition. `drainPendingCrdtNotes` clears an id only once its state has
actually reached the server, so the startup replay and a network-transition
replay firing together cannot double-push, and a still-offline start leaves the
entry queued for the next attempt.

Those two triggers can arrive within the same second — coming back from offline
does both — so the replay serialises itself: two runs must never overlap,
because each one re-reads the durable store at the top and rewrites it at the
end. A trigger that lands mid-drain is **deferred, not dropped**. Dropping it
was safe in the sense that nothing was lost, but the running drain had already
read the store, so an id recorded in between waited on some unrelated later
event to be replayed — and pulling before pushing made each drain slow enough
for that to matter.

Deferral **coalesces**: at most one run waits behind the running one. Every run
is "replay whatever the store holds when you start", and that is re-read per
run, so a third trigger asks for nothing the second has not already asked for,
and a deferred run naturally picks up ids recorded while its predecessor was
working. The queued run uses the **newest** trigger's dependencies: those close
over one runtime's `SyncEngine` and `CrdtProvider`, and neither survives
`stopSyncRuntime`, so a session torn down and replaced mid-drain hands the
deferred run to the live session rather than replaying the dead one's closure. A
teardown with nothing replacing it leaves the queued run holding the dead
session's dependencies — which is safe for the reason the next subsection
describes, not because the queue knows a session ended.

Notes that no longer exist, or never sync via CRDT (binaries), are dropped at
drain time rather than retried forever, and a doc with no content is not pushed
at all — a snapshot is a full note body and an R2 write, so the replay only pays
for notes that need it.

### A drain stops when the runtime that started it does

Nothing awaits the replay. `startSyncRuntime` fires it and returns, the network
monitor fires it from an event handler, and `stopSyncRuntime` does not wait for
it — so a drain can still be walking the backlog while the session that owns its
`SyncEngine` and `CrdtProvider` is torn down underneath it.

The push half of each note already failed closed: `CrdtProvider.destroy()` nulls
the snapshot push function, and `pushSnapshotForNote` returns `false` without
one. The **merge runs first**, and it had no equivalent guard. It reaches
`crdtProvider.open(noteId)` on the destroyed provider, whose persistence is now
`null`, so the provider builds a fresh doc, seeds it from markdown and applies
the server's merged updates to something nothing will ever save — and can drive
a markdown write-back into a vault the session no longer owns.

So the runtime owns a liveness signal. One `AbortController` per session covers
both pieces of work started and not awaited — the initial CRDT seed and the
pending-note replay — and it is created before the network listener that can
trigger a replay exists. `stopSyncRuntime` trips it **before** it destroys the
provider, and the start-failure path trips it too, because that path destroys the
provider as well. The drain checks it at the top of each note and again
immediately before the merge, since `isSyncable` runs the caller's code in
between and the merge is the destructive half.

The signal travels **with the drain's dependencies**, not in the drain module's
own state, and that is what makes the deferral queue correct without teaching it
about sessions. A queued run holding a dead session's dependencies reads that
session's tripped signal and clears nothing; a queued run whose dependencies were
replaced by a new session reads the new session's live signal and runs in full.
Liveness kept as module state would latch on the first teardown and silently
strand every backlog for the rest of the process.

An aborted drain still clears only the ids whose state actually reached the
server. Everything it did not get to stays in `crdt-pending-notes.json` for the
next session, which is what makes stopping early a delay rather than a loss.

One note's failure also no longer abandons the rest of the pass. `isSyncable` is
`CrdtProvider.validateNoteForCrdt`, which reads the index database, and
`closeVault` closes it — so it throws for every remaining id. It is inside the
per-note `try` now, the same shape the CRDT batch pull uses: a note that throws
is not cleared and is retried next pass, and the notes behind it are still
attempted.

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

### Unmerged server state routes the push away from the snapshot endpoint

Failing closed covers the one caller that reads a merge's return value — the
pending-note replay. Nothing else does. The 30 s snapshot scheduler, `close()`,
`pushAllSnapshots`, `compactDoc` and the push coordinator never see it, so a
snapshot push can still assert a completeness this device does not have.

The condition that makes a push destructive is **known-unmerged server state**,
not any one cause of it. `CrdtSyncCoordinator` keeps a per-note set,
`unmergedRemoteNotes`, read through `hasUnmergedRemoteState` and surfaced as
`SyncEngine.hasUnmergedRemoteCrdtState`. A note is in it when:

- a merge pass skipped a payload whose signer `resolveDeviceKey` could not
  resolve;
- a merge pass failed — a rate-limited or failed snapshot baseline, failed or
  dead-lettered incrementals, an aborted pass, a missing token or vault key, a
  doc that would not open;
- the server named the note in a `crdt_updated` broadcast, or a vault-wide
  sweep queued it, and its pull has not run yet.

Every one of those is destructive at the same moment, and the moment is
**before a note's first snapshot**. `storeSnapshot` computes
`sequenceNum = existingSnapshot?.sequence_num ?? currentSeq`, so the watermark
freezes at the first snapshot: the first prune deletes every row the note has,
and every later one deletes nothing new. Until its first snapshot lands, every
note is in that window.

Failing closed is not available for any of them. `GET /auth/devices` returns
only non-revoked devices, so once a peer is revoked its key never comes back and
a note held until the signer resolves is held forever; a device that is offline
or rate-limited may not merge for a long time either. Holding the note back
strands this device's own edits to protect a peer's — a certain loss traded for
a possible one. The client also cannot tell transient from permanent:
`getDeviceSigningKey` already refetches the device list on a cache miss, so a
surviving `null` carries no signal.

Nor is a skipped payload dead bytes. The signer key is only ever a signature
check; the payload itself is sealed with a file key wrapped by the vault key, so
what a prune deletes is still-decryptable user content.

The endpoint resolves it. `pruneUpdatesBeforeSnapshot` has exactly one caller,
`POST /sync/crdt/snapshot`. `POST /sync/crdt/updates` appends, prunes nothing,
and wakes peers the same way. So the snapshot push fn sends a flagged note's
full doc state through `pushCrdtFullUpdate` — the same encrypted bytes, on the
update endpoint — instead of `pushCrdtSnapshot`. Every push path inherits this,
because they all funnel through that one function.

The flag is deliberately **not** `pendingPulls`. That set is emptied by
`drainPendingPulls()` at the top of a cycle and refilled only on failure, so a
note is in it for neither the minutes it waits in the paced sweep queue (25
notes / 15 s) nor the seconds it is actually being pulled — which is exactly the
window the bug loses data in. `unmergedRemoteNotes` is instead raised whenever a
note enters `pendingPulls` and cleared only by a pass that walked the note end
to end. A pass settles its own debt up front, so an entry still standing at the
end was raised _while_ the pass ran — a broadcast, a concurrent failure — and
its payload is by definition not in the doc that pass walked, so the flag
survives.

Cost. Routing does not change the request count: both endpoints share the
`crdt_push` bucket (300 / 60 s per device), one request either way. It changes
what the server stores — a flagged push writes one full-state `crdt_updates` row
instead of upserting one R2 blob, at most one per note per 30 s quiet period,
and only for notes edited while flagged. For a note with no snapshot yet, every
such row is reclaimed by the first unflagged snapshot push, which prunes at
`currentSeq`. Pull cost rises by at most one 100-row page.

One narrow failure mode: `pushCrdtFullUpdate` throws above
`MAX_CRDT_UPDATE_PAYLOAD_CHARS`, because the update endpoint stores each payload
in a D1 row rather than an R2 object. A flagged note over that ceiling stays
pending and retried rather than snapshotted — a stall, not a loss, its content
already durable in the local CRDT store — and it ends as soon as the note merges
and the snapshot route reopens.

### The flag does not survive a session; the fact that debt existed does

The set is in-memory and per session; `clearCaches()` empties it on vault switch
and teardown. A note whose pull failed in one session therefore carried no flag
in the next, and the next launch did not necessarily re-raise it:
`shouldSweepAllCrdtNotes` reads the _persisted_ `LAST_CRDT_SWEEP_AT`, so a
restart inside the sweep interval with no reconnect gap sweeps nothing. Edit
that note, wait out the 30 s quiet period, and its snapshot push prunes at
`currentSeq` — the peer rows the last session failed to merge, gone.

What is persisted is one boolean, `sync_state.crdtUnmergedDebt`, written on the
set's empty ↔ non-empty edges (`CrdtSyncCoordinator.onUnmergedDebtChange` →
`FullSyncRunner.recordCrdtUnmergedDebt`). Written as the edges happen rather
than at teardown, because the session this has to survive is one that never runs
a teardown at all.

While it reads `'1'`, `FullSyncRunner.crdtUnmergedStateUnknown` is true and
`SyncEngine.hasUnmergedRemoteCrdtState` answers `true` for **every** note — the
same conservative answer the per-note flag gives, applied vault-wide because
this session cannot yet name the notes the last one left behind. It is dropped
by the first vault-wide sweep, which queues a pull for every note in the vault
and so flags each one individually: the blanket retires because it has been made
redundant, not because it went stale. That sweep is at most
`CRDT_FULL_SWEEP_MIN_INTERVAL_MS` away, and it re-states the key from this
session's own set so an empty or already-clean vault cannot carry a stale `'1'`
into every launch from then on.

Cost while the blanket is up: those pushes take the update endpoint instead of
the snapshot one, with the request count and the `MAX_CRDT_UPDATE_PAYLOAD_CHARS`
stall described above, and nothing else. A missing row reads as `'0'`, which is
what every install written before the key existed has and what a vault with
nothing outstanding means, so no migration is involved.

Persisting the note ids instead is worse on both counts: a new on-disk format in
a live beta, and a crash can still leave it missing whatever it had not written
yet, while a boolean already at `'1'` cannot become wrong by not being written
again.

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

Some inline nodes have no `parse` rule that could recognise their markdown form, because
that form is ordinary text: `[[wiki link]]`, a table cell's `[ ]`, and a link mention's
`((mention:…))` all reach the shared doc as plain text runs. The renderer promotes those
back into nodes when the note opens (`use-editor-sync.ts`), which is the only thing that
turns a saved mention back into a chip — without it a mention lives only as long as its
Y.Doc and comes back as literal text after a restart or a vault switch. Every promoter has
to be idempotent: the promoted node serialises back to the exact token it was built from,
so `((mention:` is gone from the document and the second open writes no CRDT update at all.

That in turn constrains the token: its payload alphabet is closed to `[A-Za-z0-9.%-]`, so
nothing in it can be reinterpreted as markdown. `encodeURIComponent` alone is not enough —
it leaves `_ ! ~ * ' ( )` raw, and two mentions on one line whose URLs each hold a `*` are
read back as a single emphasis run spanning both tokens, destroying both. The parser is
correspondingly tolerant: a token written by an older build can carry a stray space or
escape, and it is repaired on open rather than left broken.

Callouts are parsed back **only in the exact shape Memry itself writes**: a marker that is
one of the four supported types with nothing after the `]`, followed by one `> ` per body
line. The claim is proven per note — the body is re-serialized and must reproduce the file
byte-for-byte, or the run is declined. Everything else — `> [!note]`, `> [!tip]`, a title
after the marker, a blank `>` line, a list in the body — stays a quote block and its bytes
stay untouched, which is what keeps an Obsidian-authored vault byte-identical through Memry.
Both processes share the claim rules (`readCalloutRun` / `resolveCalloutRun` in
`@memry/editor-schema/blocks`), so a callout survives create → sync → main-process
write-back → reopen on the collaborative and non-collaborative paths alike. A note already
damaged into a bare `[!info]` line with its body directly below heals into a callout on
parse; a lone marker, a marker mid-paragraph, or a body the schema could not reproduce stays
the author's text.

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
