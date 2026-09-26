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

If the move itself fails (every rename retry and the copy fallback), the store
opens **in place**, under the pre-adoption name, for that session, and the
record stays pending so the next open retries the move. Opening the adopted path
instead would let LevelDB create an empty store there, and from then on the
"adopted uuid already has a store" edge would keep the history stranded. The
legacy inherit is skipped in that session for the same reason: it would fill the
adopted path the retried rename needs.

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

The markers name the failing operation, not its cause. y-leveldb opens its
database lazily and runs every call inside a transaction wrapper that catches,
warns and resolves `null` — so a store that could not be opened at all used to
walk past the `write` and `read` markers and die on a null dereference, with the
LevelDB error never printed anywhere. The child therefore hands y-leveldb its
own level adapter, opens it **explicitly** right after the `open` marker, and
prints the whole cause chain root cause first (`IO error: lock <dir>/LOCK:
already held by process`, `Corruption: …`) — which is what tells a store held
open by a previous process apart from a store that is genuinely damaged. The
parent attaches that line to the failure `reason`, bounded and with absolute
paths stripped, so it reaches the `CRDT_PERSISTENCE_UNAVAILABLE` telemetry event
too.

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

The same streak is what stops the preflight itself from running forever. The
preflight's whole job is to contain a binding that takes the process down with
no catchable error, and containing it costs a crashed child — on the Windows
machines where the binding access-violates, two per launch (the store and the
empty control directory), with an identical verdict every time. So
`openCrdtPersistence` reads the streak _before_ spawning anything: at three or
more consecutive in-memory launches it skips straight to in-memory mode without
running the preflight, and reports that as
`CRDT_PERSISTENCE_UNAVAILABLE:guard` so the fleet count of degraded installs
stays honest.

Giving up is scoped to one build. The streak is stamped with the app version
that recorded it (`crdtStore.inMemoryAppVersion`), and a streak is only honoured
while that version is still running — so shipping a new binary re-arms the
preflight automatically, the same way `gpu-crash-guard.json` re-enables hardware
acceleration on a new version. A streak written by a build that predates the
field has no owning version and is re-armed once.

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
whole-vault pass, which is what a sign-in or the legacy sweep produces, is several times
the cap.

The **probe** phase is not bound by it, because it opens no document at all. Its only
ceiling is the server's 100-note limit on the `notes` array of
`/sync/crdt/updates/batch`, so `applyCrdtBatch` chunks at 100 and sub-chunks the apply
phase at the doc cache inside each one. Sizing the outer loop at the doc cache instead
would spend one probe request per 32 notes rather than per 100, and the probe request is
the entire cost of a warm sweep.

The legacy sweep hands its work to that same batch path rather than pulling one note
at a time, and sizes its own chunks at `CRDT_SWEEP_CHUNK_NOTES` — the probe's size.
Batching alone is not a fix for request volume: the batch endpoint batches the
**incrementals**, not the snapshot baselines, which are still fetched one note at a time
whenever a baseline is actually needed. A cold 121-note sweep goes from 242 requests to
roughly 125 — half, not a handful. What keeps it under the server's limits is the pacing
described in [Pacing the drain](#pacing-the-drain).

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

Compaction rebuilds the doc by copying each root into a fresh one, so it can only carry
over root types it recognises — `Y.XmlFragment`, `Y.Map`, `Y.Array`, `Y.Text`. A root that
arrived in an update but was never requested by name is still a bare placeholder, and a
root added by a newer app version is unknown outright. Because the compaction output
replaces both the pushed snapshot and local persistence, copying only the recognised roots
would delete the rest on every device on the account. Compaction refuses instead: an
unrecognised root aborts it and the doc stays large until the root is typed. The note's
seven known roots — the ProseMirror fragment, `meta`, `tags`, `criticMarkupMarks`,
`markdownSource`, `linkReferenceDefinitions`, `linkReferenceUsages` — are typed when the
doc is created, before any persisted update is applied, so the ordinary note never trips
this and an editor-less doc still compacts.

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
3. **The note-body outbox** keeps each note's updates in enqueue order.

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

| Path                             | Guard                         |
| -------------------------------- | ----------------------------- |
| `onDocUpdate` → note-body outbox | cached flag on the doc        |
| `close()` snapshot               | cached flag on the doc        |
| `pushAllSnapshots()` at shutdown | cached flag on the doc        |
| `compactDoc()` snapshot          | cached flag on the doc        |
| `pushSnapshotForNote()`          | re-reads the `note_cache` row |

`pushSnapshotForNote` re-reads the row because it is the one push path reached for a note with
no open doc — the push coordinator's `create` and the oversized-update fallback both land there.
A full-state outbox row re-reads it too, through `isNoteSyncable`.
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
and clearing the flag raises an `update`, an update payload carries `content: null`, and every
pull path only pulls. The note would resume syncing its metadata with its body frozen wherever
the server last saw it.

So `CrdtProvider.setNoteLocalOnly(noteId, false)` queues a **full-state row** for the note in
the note-body outbox (see [Note-Body Outbox](#note-body-outbox)), which pushes full document
state after pulling and merging the server's state, and keeps the row until that push lands.
Setting the flag drops the note's queued rows instead, the CRDT twin of the
`removePendingNoteSyncItems` call beside it; nothing is lost, because the updates stay in the
local store and a later clear queues full state again.

Either direction also drops the doc's snapshot debt, so the next `close()` cannot fire a _blind_
snapshot ahead of the merge-first full-state push. A snapshot asserts completeness and the server prunes
every incremental below it, and a note that has just stopped being local-only is the population
most likely to have diverged from a peer.

### The pull half, and the flush window

The setting reads as "this note and the server have nothing to do with each other", so the pull
side refuses too. `CrdtSyncCoordinator.applyCrdtIncrementals` returns before it opens the doc,
and `applyCrdtBatch` filters the list before it chunks it — so the paced drain, the
`crdt_updated` pull and a full-state outbox flush all skip a local-only note, and none of them
spends `crdt_pull` budget on a note that can never push. Filtering before the chunking matters:
each paced chunk stays filled with notes that can actually sync.

A skipped note is deliberately **not** owed a retry. `owePendingPull` there would be a debt
nothing can ever settle, and the note would be re-queued in every drain for the life of the
session. Its `unmergedRemoteNotes` flag is left standing instead — free while the note cannot
push, and the conservative answer for its first push if the flag is ever cleared.

Setting the flag also drops the note's queued outbox rows. `onDocUpdate` reads the flag at
_enqueue_ time but the outbox flushes on a ~1 s window, so everything typed in the second before
the toggle is already past the guard. `NoteBodyOutbox.dropNote` deletes those rows — nothing is
lost, because the updates are also in the local CRDT store — and `CrdtProvider.setNoteLocalOnly`
calls it ahead of its `docs` lookup, so a note whose doc the LRU has already evicted is covered
too. A push already in flight cannot be recalled, but its ack deletes by row id and its failure
keeps nothing, so the rows cannot come back.

Finally, a full-state row asks `CrdtProvider.isNoteSyncable` — `validateNoteForCrdt` plus the
local-only check — rather than `validateNoteForCrdt` alone, so a row that reached the outbox
through that race is dropped instead of retained forever. The two halves stay
separate because `validateNoteForCrdt` also gates the renderer's editor handshake, where a
local-only note must still open and edit like any other.

## Note Bodies From the Change Feed

The desktop declares `note_body` in `X-Memry-Sync-Types` (#2297) on the `/sync/changes` requests
of a pull run that starts past cursor 0. Those pages carry the page's body rows in `noteBodies`, on
the same cursor as the records. A run from cursor 0 (a new device, or any reset of the cursor)
does not declare it: it keeps 500-row record pages and gets bodies from the records it applies and
from the legacy sweep.

- **Which entries.** Only a note or journal this device has, that is not local-only and whose record
  is not on the same page. A record on the page pulls that note's whole body anyway. Of several
  snapshot entries for one note, only the newest counts.
- **Fetch.** Inline updates are used as is. A larger update and every snapshot are refs, fetched
  through the CRDT GET routes before the page transaction opens (the apply loop inside it must stay
  synchronous):
  - one attempt each, four at a time, and at most 16 per page;
  - a vault close cancels a request in flight;
  - an expired session is refreshed once.

  Each body is decrypted (on the crypto worker when it runs) and decoded once before anything is
  stored. A snapshot whose revision the store already merged is skipped, and that includes the
  device's own snapshots, whose revision it records when it pushes them.

- **Per entry, never per page.**
  - **A fault in the entry itself** goes to the schema-invalid ledger, flags its note as unmerged and
    owes it a whole-body pull. That is its schema, its signer, its decryption, its decode, or a 4xx
    other than 401 and 429 on its fetch.
  - **Anything else only owes the pull:** a pruned update, a snapshot with no blob, an entry past the
    16, or a transport failure (a rate limit, a network error, a 5xx, an expired session). The first
    transport failure stops the page's fetches, and every entry not yet fetched is owed too.
  - **Every body fails to decrypt:** the account-key check the records use runs, and a mismatch or a
    key mid-swap holds the cursor.
- **Apply.** After the page is written and its note files land, the bodies land in the CRDT store. A
  note or journal this device has, whose doc holds state, is opened and merged live, so an open
  editor and the markdown write-back see the change. An update that changed the doc is also stored
  explicitly.

  Nothing else is stored: bytes the store holds unmerged would make the later whole-body merge a
  no-op, and the vault file would never be written. So:
  - a body for an id with no row is dropped;
  - a known note whose doc holds nothing is owed its whole body instead of taking a delta that could
    write a partial one.

- **Every record pulls its whole body**, with one exception. This is how a dropped body arrives. It
  holds for a record applied on its page, and for one applied by the deferred retry, the corrupt
  re-fetch, the ledger retry, the orphan repair or a socket frame. The exception (#2421,
  `NoteBodyFeed.servesRecordBody`) is a record on a page that carries `noteBodies`, while the legacy
  sweep is `done` and the debt tables are usable, for a note that already had a row, has no entry on
  that page, did not merge as a conflict, is not already owed, and whose body the feed never dropped
  as rowless (a `crdt_body_withheld` row, never a debt). The feed delivers every body row of such a
  note, so a metadata-only edit costs no whole-body pull. A record that does not apply leaves its
  skipped bodies owed and queued for the session's flush.
- **Downgrade round trip.** `noteBodyFeedCursor` shadows every `LAST_CURSOR` write. At engine
  start a `LAST_CURSOR` that differs was moved by another build, so `noteBodyLegacySweep` is
  deleted and the legacy sweep re-arms.
- **No deleted note comes back.** A note is ledgered or owed only while it still has a row. A queued
  pull (the pending pulls and the paced sweep) drops an id whose row is gone before it opens a doc,
  so a note deleted after it was owed is never merged and written back as a new file.
- **Cursor.** Landing is post-transaction work, so `LAST_CURSOR` moves only after it. Nothing is
  written ahead of it: a crash before the landing re-pulls the page, and applying a Yjs update twice
  is a no-op. A body that fails to land is refused like a bad entry, before the cursor moves. A
  vault close during the landing stops it and refuses nothing; the page is pulled again.
- **Healing.** The ledger retry pulls a refused note's whole body, at most ten per pull, and never
  pulls a note with no row or a local-only one. Refused bodies heal by themselves, so they are not
  listed as quarantined items.
- **Journals** are the same CRDT documents under the journal id, so they need nothing extra.
- **Legacy sweep.** Rows written before the server's cursor migration never enter the feed, and
  neither do rows below the device's cursor when it first negotiated bodies.
  - The first page that carries `noteBodies` marks one vault-wide sweep `pending` (sync-state key
    `noteBodyLegacySweep`).
  - A full sync whose pull reached the head of the feed forces the sweep. Only its clean drain
    records `done`, and only if the key still reads `pending`.
  - A page without `noteBodies` (a server rollback) clears the key and discards that queued sweep,
    so the sweep runs again once bodies are served again.
  - A device offline for the whole rollback cannot notice it.

## Reconnect Recovery

The feed is the body channel. Once the legacy sweep is `done`, a `crdt_updated` broadcast that
carries a `cursor` is only a wake: the same coalesced pull a `changes_available` frame schedules,
skipped when the cursor is at or below `LAST_CURSOR` (#2421). Before `done`, and for a frame
without a cursor (a server before #2420), the broadcast still pulls the named note, durably owed.

- **Wake flag.** The note counts as unmerged until `LAST_CURSOR` reaches the frame's cursor, so
  no snapshot push prunes the write just announced.
- **Pending wake cursor.** Every wake raises one `pendingWakeCursor` (infinity for a wake without
  a cursor, or a reconnect a full sync refused). The queued wake pull takes and clears it as it
  starts; a pull a full sync refused or overlapped puts it back, and the full sync's end pulls
  again while it is above `LAST_CURSOR`.
- **Flush rule.** Every pull outside a full sync (a wake, a reconnect, the 60 s tick) flushes the
  paced drain when it ends, unless a full sync runs (its own closing flush drains it), sync is
  paused or the engine is cancelled. A body the feed owed (past the page's GET budget, a missing
  base) is paid at once. An active-editor pull the engine refuses goes back to the pending set, and
  a 60 s floor timer flushes pulls re-queued after a rate limit.

A reconnect pulls the feed and nothing else: every body row written while the socket was down sits
above `LAST_CURSOR` and arrives with that pull.

The 15-minute, reconnect, forced ("Sync now") and manifest vault sweeps, and the per-reconnect
re-pull of open docs, are gone (#2421). A manifest re-pull runs from cursor 0, so every record it
applies pulls its whole body. Their `lastCrdtSweepAt` sync-state row is left for older builds,
which read it as their sweep throttle after a downgrade.

### When the server goes away but the network does not

An unreachable **server** is not an offline **device**. `NetworkMonitor` reads OS-level
connectivity, so a server that stops answering fires no `status-changed` event: the
note-body outbox is never paused and no full sync is scheduled when the server returns.
The outbox keeps retrying its rows each window, but a **peer's** body edit across that kind of
outage arrives through a wake or a reconnect pull, and both need the WebSocket back (the 60-second
tick pulls meanwhile).

Two things have to hold for that to work, and both are load-bearing:

- **The socket must keep trying.** Every exit from `connect()` re-arms the retry,
  including the one where the access token read comes back empty. That case is not
  hypothetical during an outage: `/auth/refresh` lives on the same unreachable server, so
  roughly fourteen minutes in, the access token passes its pre-expiry margin and cannot be
  renewed. An exit that did not re-arm left the device with no socket for the rest of the
  session, and with it no wake and no reconnect pull.
- **The outbound backlog must survive.** The push function rejects rather than returns
  when credentials are momentarily unavailable, so the outbox keeps the rows instead of
  acknowledging them — see [Note-Body Outbox](#note-body-outbox).

### Pacing the drain

The paced drain pays the queued pulls: durable debts and the legacy sweep. A sweep fires
against every note in the vault at once. Down the one-note-at-a-time path that was two GETs per note:
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

The drain is paced, never **selective**. Every note queued (a debt, or the legacy sweep's
whole vault) is still pulled; these numbers decide what a note costs, never whether it is
looked at. The legacy sweep is the only channel for body rows the feed never serves.

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

Priority is never filtering. The legacy sweep is the only channel for body rows the feed
never serves, so every markdown note still enters the queue, exactly once, and only its
position changes. A vault whose mtimes are uniform (restored from backup,
freshly cloned, bulk-imported) simply falls back to an arbitrary tail order.

Notes a chunk failed are re-added to the pending set by `owePendingPull`, so they rejoin
at the _end_ of the next drain rather than at the front: a note that just failed is the
worst candidate for an immediate retry.

Ordering changes perceived latency only. It does not change the request count, the
request rate, or how long a full catch-up takes — the budgets above are untouched.

One drain runs at a time and one timer is armed at a time. Debts landing mid-drain re-queue
into the running one instead of starting their own, which would double the request rate;
engine teardown cancels the timer and drops the queue.

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
the next vault-wide sweep, which no longer exists (#2421). Opening the note does not help,
because that reads the main process's Y.Doc rather than the server.

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

Nothing about that reaches a push, and nothing needs pausing: `CrdtProvider.destroy()` clears
the outbox reference and `resetCrdtProvider()` replaces the instance outright, so a signed-out
session never retries a push and never reads the keychain for a token that is not there. Queued
note-body rows are **kept** across sign-out — teardown deletes every other `sync_queue` row — so
an edit made before sign-out still reaches the server on the next sign-in.

### Recording what the server is owed

Having no outbox is not the same as owing nothing. A signed-out (or unpaid) edit is durable
locally and would otherwise be unknown to sync forever. So `onDocUpdate`, with no outbox,
writes one **full-state row** for the note straight into this vault's `sync_queue`, deduped per
note for the queue-less stretch: one small synchronous write per note touched, not per
keystroke. Full state rather than one row per update, because an install that never syncs would
otherwise grow `sync_queue` by every keystroke it makes. `CrdtProvider.init()` clears the dedupe
set, so the next queue-less stretch starts fresh.

The next `startSyncRuntime` — which is what signing in runs — starts the outbox, and the rows
flush with no further user input. Builds before #2298 kept these ids in
`crdt-pending-notes.json` in userData; `startSyncRuntime` imports that file once into
full-state rows (salvaging the complete ids of a torn write) and deletes it.

### Full-state rows merge first, one at a time

A full-state row is pushed as `Y.encodeStateAsUpdate(doc)` to `POST /sync/crdt/updates`, which
prunes nothing. The notes behind these rows are still the ones most likely to have diverged from
a peer, so the runtime's reader pulls and merges the server's state
(`SyncEngine.mergeRemoteCrdtForNote` → `CrdtSyncCoordinator.pullCrdtForNote`) **immediately
before** that note's push, and only after `engine.start()` has awaited the first full sync. A
merge that does not complete (missing token or vault key, an abort, a rate-limited or failed
fetch) keeps the row. State too large for the update route falls back to the snapshot endpoint,
which the merge just made safe.

The outbox runs one full-state flush at a time, as the retired replay did, so an upgrade that
imports a long list does not fire every merge at once. Notes that no longer exist, are
local-only, or never sync via CRDT (binaries) have their rows dropped instead of retried.

### A flush stops when the runtime that started it does

Nothing awaits a flush, and `stopSyncRuntime` does not wait for one, so a full-state flush can
still be merging while the session that owns its `SyncEngine` and `CrdtProvider` is torn down.
The merge reaches `crdtProvider.open(noteId)`, and on a destroyed provider (persistence `null`)
that builds a doc from markdown, applies the server's updates and saves none of it — possibly
into a vault the session no longer owns.

So the runtime owns a liveness signal. One `AbortController` per session covers both pieces of
work started and not awaited — the initial CRDT seed and a full-state flush. `stopSyncRuntime`
trips it **before** it destroys the provider, and the start-failure path trips it too. The
full-state reader checks it before the merge and again before reading state, and throws, so the
row stays queued for the next session. The signal lives in the runtime's closure, not in module
state, so the next session's outbox runs in full.

### Unmerged server state routes the push away from the snapshot endpoint

Failing closed covers the one caller that reads a merge's return value — a
full-state outbox flush. Nothing else does. The 30 s snapshot scheduler, `close()`,
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
- the server named the note in a `crdt_updated` broadcast that still takes the
  per-note pull, or the legacy sweep queued it, and its pull has not run yet.

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

### Snapshot pushes claim `coversThrough`

A snapshot push can say which change-feed rows its state holds: `coversThrough`,
the feed cursor through which every body row of the note has been merged, plus
`baseRevision`, the server snapshot the doc last merged or pushed (protocol 07
§7.7.1). A server that understands it prunes only rows at or below that cursor,
moves the watermark over exactly what it pruned, and records the claim on the
snapshot row. From then on the pruned rows exist only inside that snapshot, so
the server refuses (`409 CRDT_SNAPSHOT_NOT_COVERED`, with the refusing
snapshot's cursor) any write that does not cover it: an unclaimed push onto a
claimed snapshot, and a claimed push onto a snapshot whose cursor its feed has
not passed unless `baseRevision` names it. The signing device does not matter:
a restored or cloned data dir signs with the same id. The check is part of the
upsert, every write has its own R2 object, and the prune runs in the same D1
batch only when the upsert applied. Claims stay dormant until the server's
`CRDT_CLAIM_MIN_DESKTOP_VERSION` is set and the desktop write floor has reached
it, so no desktop that predates them meets the refusal.

Desktop claims `coversThrough = LAST_CURSOR` only when the legacy body sweep is
`done`, the cursor is above 0, the note is not flagged (a `crdt_updated` wake the
cursor has not reached counts), the debt tables are usable, the feed never dropped
a body of the id as rowless, and no refusal of the note is outstanding. `encodeForPush` in the provider is the only way to produce
push bytes: it reads the base revision first, then the claim and the encode in
one synchronous step, because a feed page can land bodies and move
`LAST_CURSOR` during any await. A refused note takes the update route until the
feed passes the refusing snapshot's cursor or a pull merged a newer snapshot. A
note leaving local-only, a note with a queued full-state row at runtime start,
a body landed while its doc compacted, and every note after the CRDT store's
epoch fails to match the data DB's (fresh, quarantined, or either side restored
apart), claims nothing until a pull or the legacy sweep has merged it; that
sweep takes its note set from the data DB as well as the index cache. A doc that
cannot vouch for itself (in-memory store, seeded from markdown or created this
session, or an id the feed dropped as rowless) pushes unclaimed until a
whole-body pull merges it.

The routing above stays: a server that predates `coversThrough` ignores it and
prunes by watermark, and a flagged note claims nothing. The server change must
deploy to every Worker at once: an older Worker running beside it could
overwrite a claimed snapshot.

### Unmerged notes are durable debts

The in-memory set is backed by the data-DB table `crdt_body_debts` (migration
`0060`, #2297). A row means this device knows the server holds body state for
the note that its doc has not merged; `crdt-body-debts.ts` owns it.

- **Written before the cursor moves past the evidence.** An applied note or
  journal record (`record`), a refused or owed feed entry, a note whose feed
  entries were skipped because its record is on the page (owed even if that
  record fails to apply), a failed landing or a missing base, a snapshot
  refusal, a note leaving local-only, and a compaction that dropped buffered
  remote updates. Record-page and feed debts are written inside the page
  transaction, so a rolled-back page takes them with it; a skipped note is
  owed in the slice that applied its record, before that slice's CRDT batch.
  Feed debts keep the lowest cursor of the note's entries on the page; every
  other debt is NULL, meaning the whole body. The coordinator is the only
  writer.
- **Session-only:** the full-state flag at runtime start, and a pull of a note with no
  debt that was rate limited, aborted, offline, timed out, credential-less, or
  failed on a request the whole chunk shared. A session-only flag takes a
  generation, so a walk that started before it does not clear it. Only
  evidence about the note itself (its own request failing on the server, its
  own payload not decrypting, an unverifiable signer) writes a row, counts one
  failure per pass, and defers the note at once.
- **Cleared only by a clean walk or a lost row.** A pull that walked the whole
  server body with nothing unverified deletes the row, guarded on a generation
  captured when it started, so a debt raised during the walk stands; the
  counter is per database and never goes back. A queued id with no note row is
  settled without a pull. A local-only note is never drained.
- **A watermark ahead of the doc is dropped** (a compaction that lost applied
  updates, an update skipped for its signer or dropped by a closing doc), so
  the batch probe cannot settle the note without a walk. The row records it
  too (`needs_walk`, `compaction`, or a counted failure), so a watermark a
  crash left in the store cannot settle it after a restart either.
- **Backoff.** A failing note is deferred until `2^(n-1)` minutes (capped at 32)
  after its last failure, counted from now if that failure is dated in the
  future; other debts do not extend it. A deferred note does not hold up the
  legacy `done`, any clean walk settles it, and a timer
  (never set past 32 minutes) drains it at the earliest expiry.
- **Engine start** hydrates every row into the pending pulls and the flags
  before the first full sync, whose drain pays or defers them. A crash between
  a record page and its CRDT batch therefore does not leave a stale body. A
  missing table, a table missing columns
  it cannot add, or an unreadable index cache degrades with a logged error; it
  never stops sync, and a failed mirror conversion does not stop the rows
  already in the table from loading. A table an unreleased build created
  without the later columns gains them on first use.
- **Rowless drops are not debts.** A body the feed dropped because the id had no row yet is
  remembered in `crdt_body_withheld` (migration `0062`, #2421), apart from the debts, so nothing
  pulls it. `NoteBodyFeed.dropRowlessBody` writes it with the provider's claim hold at every drop
  site, including a body skipped for a record that did not apply. The id reports unmerged, so its
  pushes never prune, and a later record of it pulls the whole body. The walk that settles the
  note, or an applied delete tombstone for the id, clears it; a missing table falls back to a
  session set. Both tables are probed once per handle for `durable()`.
- **A compaction with no sync runtime** owes its debt to the data DB handle and vault the store
  was opened with, while that handle is still the open one; otherwise the store keeps the id and
  the next runtime owes it. The store marker's writes and its drain run one at a time, and the
  marker clears only after durable owes.
- **Teardown** disposes the full-sync runner: timers cleared, re-queue and deferral hooks
  unwired, and no flush, pump or floor timer until a later full sync, so a chunk the teardown
  aborts pulls nothing afterwards.

`sync_state.crdtUnmergedDebt` is no longer written on owe or settle (#2421 part c); earlier
builds mirrored the table into it for builds before the table, which the `minWriteVersion` gate
has retired. At engine start a `'1'` whose row time differs from `crdtBodyDebtMirrorAt` came from
an older build or from a CRDT store whose epoch did not match the data DB, and is converted once
into a `legacy` debt for every syncable note and journal of the data DB and the index cache; the
marker then records that row time. The vault-wide blanket (`crdtUnmergedStateUnknown`) is gone.

#2421 removed the reconnect and vault sweeps, made `crdt_updated` a wake once the legacy sweep is
`done`, and made the per-page CRDT batch the payer of the run's debts. The legacy sweep stays: its
`done` is the only licence for coverage claims, and a new device, a run from cursor 0 or a store
epoch reset needs it again. The batch probe and the watermark sequence stay with it.

## Sign-Out / Sign-In Ordering

A sign out → sign in cycle has a sharp ordering rule:

```
engine.start()       # pull from server FIRST
  └─ seedExistingCrdtDocs()   # fire-and-forget; only fills truly orphaned notes
```

Reversing this order causes split-brain: stale markdown seeds Y.Docs with new client IDs, server pull then sees non-trivial state vectors and skips bootstrap, and the device diverges.

## Note-Body Outbox

Body updates ride the same durable `sync_queue` as records, as `note_body` rows (#2298).
`CrdtProvider.onDocUpdate` appends one row per local Yjs update — base64 in the existing
`payload` column, no schema change — before it returns, so a crash, a quit while offline or a
401 pause loses nothing. The rows are **append-only**: the record queue's `enqueue` coalesces into
the pending row for the same item and overwrites its payload, which for updates would keep only
the last unflushed one. Every record method of `SyncQueueManager` skips `note_body` rows, so the
record push never sees them.

`NoteBodyOutbox` (`note-body-outbox.ts`) flushes them through the runtime's CRDT update push:

- **Order and size.** A note's rows are read in enqueue order, packed into `Y.mergeUpdates` runs
  of at most 256 KiB, up to 512 KiB per flush, and posted to `POST /sync/crdt/updates`.
- **Ack.** Exactly the rows a push carried are deleted once it succeeds; rows enqueued while it
  was in flight stay queued. A push whose ack is lost to a crash is sent again, which Yjs applies
  as a no-op.
- **Pacing.** A note's first update after a quiet second flushes at once; later ones wait for
  one trailing flush per second. A 429 holds **every** note until `Retry-After`, because the
  server's `crdt_push` bucket is per device.
- **Failures.** A 401 or a storage-quota 413 pauses the outbox until a token refresh or reconnect
  resumes it; network errors and 5xx keep the rows for the next window; any other 4xx drops the
  rows it sent. The push function rejects rather than returns when a credential is momentarily
  missing, because returning would ack the rows.

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

The same heuristic punishes a wrong _shape_, not just a wrong node name, and that trap is
worth naming because nothing reports it. A note's fragment is
`prosemirror > blockGroup > blockContainer > block > text` — exactly one `blockGroup` at
the top, because that is the node BlockNote builds the fragment's root from. A writer that
appends a `blockContainer` beside that group produces a document the schema cannot
construct, and y-prosemirror answers a non-constructible node by removing it. Every check
a naive writer can run still passes: the update applies, the document encodes, extracting
the text may even return the new words. The block is simply gone the next time the note is
opened. Any client writing into a body has to find the existing `blockGroup` and append
inside it, and refuse a top-level layout it does not recognise rather than guess.

### Two conformance classes make that a red build

The trap above used to be documented and unenforced, so a second client reading or writing
a body could diverge and nothing would say so. Two vector classes under
`packages/contracts/test-vectors/` now hold every port to the same document.

`note-blocks.json` is the **read** direction: document bytes in, the block list a shell
renders out. Its corpus is authored through BlockNote's own `blocksToYXmlFragment` — the
path main already calls — so the bytes are the bytes a real note carries rather than a
hand-built approximation. Coverage is asserted against `registry-manifest.json`, so a node
type added to the schema with no case is a failing test. That gap was not theoretical: a
`divider` was being dropped before it left the core, and inline colour values never crossed
at all. Both passed the only test that existed, which compared the block walk against the
text walk of the _same_ port — two readings that agree with each other whether or not
either is right.

`block-edit.json` is the **write** direction: a base document, one operation, and the
document the operation must leave behind, both authored through BlockNote. The assertion is
therefore "the writer produces the document BlockNote would have produced", which is the
only form of the rule above that a test can actually check.

Neither class compares Yjs update bytes, and that is deliberate. An update encodes
`clientID` and per-client clocks, and struct ordering, origin ids and run-length packing are
free choices an implementation may make differently while still converging — two different
updates that converge are both correct. So the classes compare the resulting **document**,
through a canonical textual rendering of the fragment (node names, nesting, attributes
sorted, text) that every port emits identically.

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

The custom **blocks** — `callout`, `youtubeEmbed`, `bookmark`, `file`, `taskBlock` and
`diagram` — work the same way. `file` is worth calling out: the renderer overrides
BlockNote's default `file` spec, so before the config was shared the main process built the
_default_ one and wrote `[name.pdf](url)` where the vault file held `<!-- file:{…} -->`,
dropping size, MIME type and any width/height/alignment.

`diagram` is the one block whose renderer spec is a third party's. Desktop registers
`createReactDiagramBlockSpec()` from `@blocknote/diagram-block`, which brings the source
popup, the live Mermaid preview and the fence parse rule. Main and the mobile WebView cannot
register the same thing — the package's entry point pulls React and ~3 MB of mermaid, and
both of those surfaces exist to avoid exactly that weight — so they build the node from
`diagramConfig` in `@memry/editor-schema` instead, and the renderer↔main parity gate compares
every block's config field by field so the restatement cannot drift from the package's.

Its markdown form is a plain ` ```mermaid ` fence, so there is no marker to recognise: a
Memry build without the block reads a diagram back as a code block tagged `mermaid` and
writes the same bytes out again, and a fence written by Obsidian or GitHub opens as a
diagram. What the parse rule adds is priority — it runs before `codeBlock`'s, which would
otherwise claim every `<pre><code>`.

`whiteboard` is a pointer, not a drawing: its one prop is `canvasId`, the drawing stays in
the canvas's own `.excalidraw` file, and the note holds one
`![whiteboard](memry://canvas/<id>)` line. Main writes that line through the server spec's
`<img>` like `bookmark`; a whiteboard with no `canvasId` writes nothing rather than a marker
that would re-open as a plain image.

Main is also the parser. A note's Y.Doc is seeded from its vault file in the main process
(`crdt-provider.ts`), and the renderer does not parse markdown when a Yjs fragment is
present — so the `<!-- file:… -->`, `![embed](…)`, `![bookmark](…)` and
`![whiteboard](memry://canvas/…)` marker lines are recognised there, using the same rules
the renderer uses on its own save path. Markers
inside a code fence are the author's text and stay text; the fence tracker follows
CommonMark, so a longer fence quoting a shorter one is not mistaken for a closing one.

Some inline nodes have no `parse` rule that could recognise their markdown form, because
that form is ordinary text: `[[wiki link]]`, a table cell's `[ ]`, a link mention's
`((mention:…))` and a date pill's `((date:…))` all reach the shared doc as plain text runs.
Hash tags are the exception that stays text, because they need the note's tag list and
colour map, which only the editor has. The renderer promotes the rest
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
├─ note-body-outbox.ts      # durable CRDT body outbox (note_body rows)
├─ note-body-apply.ts       # lands change-feed bodies in the CRDT store
├─ engine/note-body-feed.ts # fetches and verifies a page's noteBodies
├─ crdt-snapshot-push.ts    # snapshot vs update route, coversThrough, 409 handling
├─ crdt-store-epoch.ts      # withholds claims for a store whose epoch differs from the data DB's
└─ engine.ts                # ordering: pull → seed → per-batch push

apps/desktop/src/renderer/src/sync/
├─ yjs-ipc-provider.ts      # renderer-side Y.Doc proxy
└─ use-yjs-collaboration.ts # editor hook
```
