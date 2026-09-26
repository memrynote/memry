# 06 — Vector clocks and field merge

**Status**: normative. Every normative sentence carries a `path:line` citation
(chapter 00 §0.1).

This is the chapter FR-002 names explicitly and the one where an ambiguity costs
a user their edit. It is written so that two implementations given the same
inputs produce the **same winner and the same conflict set**, with no appeal to
"whatever the TypeScript does".

## 6.1 The clock algebra

**Normative** (`packages/sync-client/src/vector-clock.ts`):

- A vector clock is a map from device id to a non-negative integer. **A missing
  key reads as 0** (`:11`, `:17`, `:29-30`).
- `increment(clock, deviceId)` adds exactly 1 and is non-mutating (`:9-12`).
- `merge(a, b)` is the **pointwise maximum** and is commutative (`:14-20`).
- `compare(a, b)` returns `equal | before | after | concurrent`, computed over
  the **union** of both key sets (`:22-41`). `before` means a happened-before b;
  `after` means a dominates b. The loop short-circuits to `concurrent` as soon as
  both directions are seen (`:35`).
- `getTick(clock, deviceId)` is `clock[deviceId] ?? 0` (`:43`).

`_offline` is a reserved pseudo device id, the literal string `_offline`
(`packages/contracts/src/sync-api.ts:183`). **The clock algebra gives it no
special treatment**: it is an ordinary key in `increment`, `merge` and `compare`.
It is special only in the merge tie-break (§6.3) and in rebinding (§6.6).

## 6.2 `clockTotal`

**Normative.** `clockTotal(clock)` is the plain sum of **every** tick in the
clock, `_offline` included; no key is filtered
(`packages/sync-client/src/field-merge.ts:74-78`).

A second implementation MUST accumulate in a 64-bit signed integer. Key iteration
order is irrelevant to the sum.

## 6.3 The complete winner-selection rule

**Normative**, per field `f`, iterating `syncableFields` **in list order**
(`packages/sync-client/src/field-merge.ts:117`):

1. `L = localFieldClocks[f] ?? {}`, `R = remoteFieldClocks[f] ?? {}`
   (`:118-119`). **A missing field clock is the empty clock.**
2. `tL = clockTotal(L)`, `tR = clockTotal(R)` (`:121-122`).
3. `cmp = compare(L, R)` (`:120`). **Computed, but used only for the conflict
   flag — never for the winner.**
4. `differ = canonical(vL) != canonical(vR)` (`:127`; see §6.4).
5. Winner:
   - `tR > tL` → remote (`:129-130`)
   - `tL > tR` → local (`:131-132`)
   - `tL == tR` → **local iff `'_offline' ∈ keys(L)` and `'_offline' ∉ keys(R)`
     and `differ`** (`:134-137`); **otherwise remote** (`:138-139`).
6. Conflict flag, **only inside the tie branch**: `cmp === 'concurrent' &&
differ` (`:141-151`). The recorded conflict carries `mergedClock =
merge(L, R)` (`:149`).
7. `mergedFieldClocks[f] = merge(L, R)` **unconditionally**, on every field,
   whichever branch won (`:154`).
8. `merged[f] = winner` **even when the winner is `undefined`**; the caller's
   spread then leaves that column untouched
   (`apps/desktop/src/main/sync/item-handlers/task-handler.ts:170-171`,
   `:178-180`).

Three things a second implementation must get exactly right:

- **The winner is chosen by sum of ticks, never by `compare`.**
- **The `_offline` tie-break is a key-presence test, not a tick-value test**:
  `OFFLINE_CLOCK_DEVICE_ID in localFC`
  (`packages/sync-client/src/field-merge.ts:135`), so `{_offline: 0}` counts as
  present. Note the asymmetry with §6.6: `rebindClockDevice` only acts when the
  tick is `> 0` (`packages/sync-client/src/offline-clock.ts:41`), so a
  zero-valued `_offline` key survives rebinding **and** still wins ties.
- **The test is asymmetric**: there is no branch for "remote has `_offline` and
  local does not". Remote is the default winner on every tie.

### 6.3.1 The document-level gate runs first

**Normative.** Before `mergeFields` runs at all,
`resolveClockConflict(localClock, remoteClock)` decides the document's fate
(`packages/sync-client/src/item-handlers/types.ts:58-68`):

| `compare(local, remote)`      | Action                                                       |
| ----------------------------- | ------------------------------------------------------------ |
| local clock is null or absent | **apply** remote wholesale (`:62`)                           |
| `after`                       | **skip** the remote entirely (`:65`)                         |
| `concurrent`                  | **merge**, with `mergedClock = merge(local, remote)` (`:66`) |
| `before` or `equal`           | **apply** remote wholesale (`:67`)                           |

**Remote wins on `equal` here too.** On the apply path the remote's field clocks
are stored verbatim
(`apps/desktop/src/main/sync/item-handlers/task-handler.ts:244`, `:269-270`).

### 6.3.2 Worked examples

Every row below is the output of the rule above. `x` and `y` are two distinct
values; `vL`/`vR` are the local and remote values.

| #   | L                  | R                  |  tL |  tR | vL  | vR          | winner                                             | conflict     | merged field clock     |
| --- | ------------------ | ------------------ | --: | --: | --- | ----------- | -------------------------------------------------- | ------------ | ---------------------- |
| 1   | `{A:2,B:1}`        | `{C:5}`            |   3 |   5 | x   | y           | remote `y`                                         | no           | `{A:2,B:1,C:5}`        |
| 2   | `{A:1}`            | `{B:1}`            |   1 |   1 | x   | y           | remote `y`                                         | **yes**      | `{A:1,B:1}`            |
| 3   | `{A:3,B:1}`        | `{A:3,B:1}`        |   4 |   4 | x   | y           | remote `y`                                         | no (`equal`) | `{A:3,B:1}`            |
| 4   | `{A:1,_offline:1}` | `{B:2}`            |   2 |   2 | x   | y           | **local `x`**                                      | yes          | `{A:1,B:2,_offline:1}` |
| 5   | `{A:1,_offline:1}` | `{B:1,_offline:1}` |   2 |   2 | x   | y           | remote `y`                                         | yes          | `{A:1,B:1,_offline:1}` |
| 6   | `{A:1,_offline:1}` | `{B:2}`            |   2 |   2 | x   | x           | remote `x` (rule needs `differ`)                   | no           | as row 4               |
| 7   | `{}`               | `{}`               |   0 |   0 | x   | y           | remote `y`                                         | no (`equal`) | `{}`                   |
| 8   | `{A:4}`            | `{A:1,B:1,C:1}`    |   4 |   3 | x   | y           | **local `x`** though `compare` is `concurrent`     | no           | `{A:4,B:1,C:1}`        |
| 9   | `{A:2}`            | `{A:1}`            |   2 |   1 | x   | y           | local `x`                                          | no           | `{A:2}`                |
| 10  | `{A:1}`            | `{A:2}`            |   1 |   2 | x   | `undefined` | remote; the column is left untouched by the spread | no           | `{A:2}`                |

Rows 1 and 8 are the cases where the **sum overrides causality**. Row 1 is pinned
by `packages/sync-client/src/field-merge.test.ts:120-141`, row 4 by
`apps/desktop/src/main/sync/item-handlers/task-handler.test.ts:81-124`, row 3 by
`packages/sync-client/src/field-merge.test.ts:107-118`.

## 6.4 Value equality — Q06.3

### 6.4.1 What the code did before #2185

`JSON.stringify(a) !== JSON.stringify(b)` over the raw JavaScript values.
Reproducing that in Rust means reproducing ECMAScript `JSON.stringify` byte for
byte: `undefined` differs from `null` while `undefined` equals `undefined`;
**object key order is significant**, in ES own-property order (integer-like keys
ascending first, then string keys in insertion order); nested `undefined` omits a
key in an object but becomes `null` in an array; `NaN` and `±Infinity` become
`null`; `-0` becomes `0`; numbers use JavaScript shortest-round-trip formatting
with the `1e+21` exponent form that `serde_json` does not produce; lone
surrogates escape as `\uXXXX`. **This is history, not the rule; §6.4.2 is the
rule.**

**Only one field in scope carries an object**: `repeatConfig` in
`TASK_SYNCABLE_FIELDS` (`packages/sync-client/src/field-merge.ts:22`,
`packages/contracts/src/sync-payloads.ts:36`). `PROJECT_SYNCABLE_FIELDS` has
none; everything else is string, number, boolean or null. Key order comes from
whoever last wrote the row, so two devices that build `repeatConfig` from the UI
with different insertion orders compare as differing **forever**, even when
semantically identical.

### 6.4.2 The rule this specification states

**Decision, 2026-09-13 — a canonical comparison is mandated. This is the
normative rule.** `differ` is computed over a canonical form:

1. recursively sort object keys by their UTF-16 code-unit sequence;
2. format numbers with `serde_json`-style shortest round-trip, with no
   `1e+21`-style exponent special case;
3. keep `null` distinct from absent: a key whose value is `null` is present and
   encodes as `null`; a key that is absent is omitted; `undefined` is treated as
   absent.

Consequently `{a:1,b:2}` and `{b:2,a:1}` are **equal**, and `null` and
`undefined` **differ**.

`valuesEqual` (`packages/sync-client/src/field-merge.ts:57-72`, called at
`:127`) implements it: a recursive structural comparison, so key order cannot
reach the result and no canonical string is built. Arrays stay
**order-significant**; a key whose value is `undefined` compares as absent.
Shipped for **#2185**. This chapter states the canonical form, not
`JSON.stringify`.

**Negative zero canonicalises to `0`.** IEEE 754 has two spellings of zero and
the three rules above do not choose between them, which leaves the one hole a
port can fall into silently: `-0` and `0` are `==` in every language here, so a
naive comparison calls them equal while a naive serialiser writes `-0` and
makes the canonical forms differ. Normalise both to `0` before comparing or
emitting, which is also what `JSON.stringify(-0)` already does.

### 6.4.3 Blast radius of the decision, exhaustive

`differ` flips true → false **only** for pairs that are JSON-equal modulo key
order and number formatting.

| Consumer                          | Effect                                                                                                                                                                                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| winner rules 1 and 2 (`:129-132`) | do not read `differ`; unaffected                                                                                                                                                                                                                      |
| winner rule 3 (`:136`)            | for an order-only difference both sides hold the same value, so only the stored serialisation changes: remote's key order persists instead of local's. **No semantic change.**                                                                        |
| the conflict flag (`:141`)        | stops firing for such pairs, so there are fewer `'conflict'` returns (`apps/desktop/src/main/sync/item-handlers/task-handler.ts:242`) and fewer `superseded` activity rows. **This is the only user-visible effect, and it removes false positives.** |
| the wire                          | nothing changes; the clock union is untouched                                                                                                                                                                                                         |

**Disposition of Q06.3: answered and implemented (canonical comparison, #2185).**

## 6.5 Convergence — Q06.1 and Q06.2

### 6.5.1 Is the outcome evaluator-dependent

Two devices X and Y holding `(Cx, vx)` and `(Cy, vy)`; X evaluates `W(Cx, Cy)`
and Y evaluates `W(Cy, Cx)`:

| Case | Totals               | `_offline` present in | X picks          | Y picks          | Converge |
| ---- | -------------------- | --------------------- | ---------------- | ---------------- | -------- |
| 1    | `tx ≠ ty`            | any                   | the larger total | the larger total | yes      |
| 2    | `tx = ty`, `vx = vy` | any                   | same             | same             | yes      |
| 3a   | `tx = ty`, differ    | X only                | `vx` (rule 3)    | `vx` (rule 4)    | **yes**  |
| 3b   | `tx = ty`, differ    | Y only                | `vy` (rule 4)    | `vy` (rule 3)    | **yes**  |
| 3c   | `tx = ty`, differ    | neither               | `vy`             | `vx`             | **no**   |
| 3d   | `tx = ty`, differ    | both                  | `vy`             | `vx`             | **no**   |

**The asymmetric `_offline` test is the part that saves 3a and 3b**: from either
seat, rule 3 means "the side carrying `_offline` wins". The branch that flips
with the seat is the plain "remote wins" default at
`packages/sync-client/src/field-merge.ts:138-139`.

### 6.5.2 Why 3c and 3d do not diverge in production

**The merge rule alone does not converge. Three system properties carry FR-002,
and a client that breaks any of them reintroduces divergence.**

- **P1 — one row per item; any push with one component ahead is accepted.**
  `ON CONFLICT … DO UPDATE SET … clock = excluded.clock`
  (`apps/sync-server/src/services/sync.ts:668-686`), `version = existing.version
  - 1` (`:575`), and `detectReplay`
(`apps/sync-server/src/services/sync.ts:179-190`), which rejects only when **no**
    incoming component exceeds the stored one. A concurrent push overwrites the
    row, so the earlier concurrent payload stops existing.
- **P2 — a queued push is rebuilt from the live row at dequeue.**
  `resolvePushPayload` → `buildPushPayload`
  (`apps/desktop/src/main/sync/engine/push-coordinator.ts:598-641`),
  `{...task}` from the current row
  (`apps/desktop/src/main/sync/item-handlers/task-handler.ts:367-379`), same for
  projects (`apps/desktop/src/main/sync/item-handlers/project-handler.ts:340`).
- **P3 — a merge apply re-queues the merged row, and the union clock makes that
  push dominate the server's row.** The handler itself stores the union clock
  and enqueues nothing
  (`apps/desktop/src/main/sync/item-handlers/task-handler.ts:178-186`; union
  from `packages/sync-client/src/field-merge.ts:154` and
  `packages/sync-client/src/item-handlers/types.ts:66`), but a `'conflict'`
  return re-queues the item one level up, in the pull coordinator
  (`apps/desktop/src/main/sync/engine/conflict-report.ts:56-61`, called from
  `apps/desktop/src/main/sync/engine/pull-coordinator.ts:861-864`, `:559-562`,
  `:648-651` and `:942`), and an enqueue requests a push
  (`apps/desktop/src/main/sync/runtime.ts:949`). The queued row is rebuilt from
  the live — merged — row by P2, and its union clock has one component the
  stored row lacks, so `detectReplay` accepts it.
- **P4 — an EQUAL incoming clock applies the remote row, it does not skip it.**
  `packages/sync-client/src/item-handlers/types.ts:67`. This is what settles the
  two devices whose P3 re-pushes collide: the first is accepted, the second is
  refused as a replay (`apps/sync-server/src/services/sync.ts:179-190`) and
  marked done anyway
  (`apps/desktop/src/main/sync/engine/push-coordinator.ts:299-305`), and the
  refused device then pulls the accepted row under the same clock and takes it.

In the ordinary interleavings P1 to P3 leave **at most one device running
`mergeFields` on a given concurrent pair**; the other sees its own row (`equal` →
apply) or a strictly dominating one (`before` → apply). Trace, with ancestor
`{X:1,Y:1}`, X editing `title` to `{X:2,Y:1}` and Y editing `title` to
`{X:1,Y:2}`, both totals 3:

| Interleaving                   | Server row               | X ends                                       | Y ends                    | Merger |
| ------------------------------ | ------------------------ | -------------------------------------------- | ------------------------- | ------ |
| X push, Y push, both pull      | `(vy, {X:1,Y:2})`        | merge, tie, remote → `vy`, clock `{X:2,Y:2}` | own row, `equal` → `vy`   | X      |
| X push, Y pull, Y push, X pull | `(vx, {X:2,Y:2})` via P2 | `before` → `vx`                              | merge, tie, remote → `vx` | Y      |

Both converge. **Which value survives is "last pusher wins", not a property of
the merge rule.** A third device pulls the single latest row and behaves
identically.

**Core obligation — this is the load-bearing one.** An outbox that freezes the
push payload at enqueue time reintroduces the 3c divergence **deterministically,
not as a race**. A conforming client MUST rebuild the payload from the live row
at send time (P2), MUST re-queue a merged item so the union-clocked row is
pushed (P3), MUST apply — never skip — a remote row whose clock is EQUAL to the
local one (P4), and MUST implement rule 3's asymmetric key-presence test
exactly — a "symmetric" rewrite breaks 3a and 3b against desktop.

P3 and P4 are what make the seat-dependent winner of 3c/3d survivable: the value
that wins is whichever merged row the server accepted first, and every other
device ends up on it. A core that stored the union clock **without** re-queueing
would strand a pair of devices that both merged, on values they never push and
that no later pull can dislodge until the item is edited again.

**Disposition of Q06.1: answered (converges via P1 + P2 + P3 + P4, not via the
merge rule).**

### 6.5.3 The tick sum is a proxy for edit count, not causality — Q06.2

**Normative and frozen.** A device with more edits wins a concurrent pair,
regardless of causality (row 8 of §6.3.2). This is not a standard vector clock
rule. It is frozen because desktop's activity log and its pinning tests are built
on it.

The core MUST use the sum, never `compare`, for the winner; MUST iterate the
field list in order, because `conflictedFields` is consumed in order by activity
logging; and MUST treat a missing field clock as `{}`.

**Disposition of Q06.2: answered (tick-sum frozen as an edit-count proxy).**

### 6.5.4 A concurrent pair with unequal totals — Q06.4

**Normative.** A field is reported as conflicted **iff** the field-clock totals
are **equal**, `compare(L,R)` is `concurrent`, **and** the serialised values
differ. The conflict block sits inside the tie branch
(`packages/sync-client/src/field-merge.ts:133-152`, with the `isConcurrent &&
valsDiffer` test at `:114` nested under the `else` of `:102`/`:104`).

**A concurrent pair with unequal totals is resolved by the larger total and is
not a conflict: an edit is lost with nothing surfaced to the user.**
`hadConflicts` stays false, the handler returns `'applied'` rather than
`'conflict'` (`apps/desktop/src/main/sync/item-handlers/task-handler.ts:242`),
and no `superseded` activity row is written
(`apps/desktop/src/main/sync/item-handlers/task-handler.ts:228-236` iterates
`result.conflicts`). Pinned by
`packages/sync-client/src/field-merge.test.ts:120-141`.

**Decision — freeze.** Changing it would rewrite desktop's activity log and break
the pinning test for a notice nobody asked for.

**Core obligation.** The core MUST NOT report it. A core that surfaced it would
write `superseded` rows desktop never writes, and those rows sync as
`task_activity` items to every device.

**Disposition of Q06.4: answered (decision: freeze).**

## 6.6 `_offline` minting and rebinding

**Normative.** While the sync runtime is down, edits tick `_offline` instead of a
device id: the document clock at
`packages/sync-client/src/offline-clock.ts:112` and each changed field's clock at
`:96`.

When the device later has an id, `rebindClockDevice` **deletes** the `_offline`
key and **adds** its tick count to the target device's existing tick
(`packages/sync-client/src/offline-clock.ts:39-47`), and the same transformation
runs over every field clock (`:49-57`, driven from `:68-84`). Rebinding is a
no-op when the tick is `<= 0` (`:41`, `:51`).

**A clock containing `_offline` MUST never reach the server**, and rebinding MUST
happen before the first push.

### 6.6.1 Fixed — `_offline` no longer rides the record create path (#2179)

Desktop used to violate the rule above. `recoverDirtyItems` routes
`syncedAt IS NULL` rows to `enqueueCreate`, not `enqueueRecoveredUpdate`
(`enqueueCreateOrRecoveredUpdate` in
`apps/desktop/src/main/sync/dirty-recovery.ts`), and rebinding ran only
from `recoverPendingChange`, which only `enqueueRecoveredUpdate` called;
`applyLocalChange` increments the real device id but never strips `_offline`,
and `seedUnclocked` only touches `clock IS NULL` rows
(`apps/desktop/src/main/sync/item-handlers/task-handler.ts:385-386`), so an
offline-created task carrying `{_offline:1}` was never seeded either. Using the
app with no account, creating and editing a task, then signing in shipped
`clock = {_offline: 2, A: 1}` on the first recovery.

**Fix.** `RecordSyncController.enqueueMutation` now calls `recoverPendingChange`
before `applyLocalChange` (`packages/sync-core/src/record-sync.ts`), so every
create _and_ update of a record-shaped item rebinds and persists first. A row
with nothing offline about it returns `null` and is untouched. Pinned by
`packages/sync-core/src/record-sync.test.ts` and the create-path case in
`apps/desktop/src/main/sync/dirty-recovery.test.ts`.

**Residual, still open.** The fix reaches the types that implement
`recoverPendingChange`: tasks and projects (field clocks), and since #2286 the
doc-clock types inbox, saved filters, templates, home pages, custom icons,
bookmarks, reminders, canvas folders and task activity, through
`recoverOfflineDocClock` (`packages/sync-client/src/offline-clock.ts`). Canvases
still mint `_offline` through `local-mutations.ts` with no rebinding hook, so
their `_offline` still reaches the wire. Notes and journals are unaffected:
`incrementNoteClockOffline` ticks the real device id and skips the bump when
none is registered (`packages/sync-client/src/offline-clock.ts`). **The server
filters nothing**: there is no reference to `_offline` anywhere under
`apps/sync-server/src`.

Why it matters wherever it remains: `_offline` is a device id two machines can
both claim, so their clocks compare equal for edits that are genuinely
concurrent, and a peer that later rebinds its own `_offline` folds the
**remote's** ticks into its own device id
(`packages/sync-client/src/offline-clock.ts:39-47`). **It is also what makes case
3d of §6.5.1 reachable at all.**

**Core obligation.** Never emit `_offline` on the wire. On inbound, treat it as an
ordinary key with no special case, exactly as
`packages/sync-client/src/vector-clock.ts` does, so clocks stay comparable with
desktop's.

### 6.6.2 The push-build / pull-apply race (#2180) — not a divergence

**Normative, and it supersedes the "undefined" note this section used to
carry.** The race itself is real to describe: two devices can both run
`mergeFields` on the same concurrent pair and end mirrored — X holding `vy`, Y
holding `vx`, both under clock `{X:2,Y:2}`. **It does not leave them there.**

On desktop the window is additionally narrow, because a push drain and a pull
apply cannot interleave in the first place: both take the same engine sync lock
(`apps/desktop/src/main/sync/engine/push-coordinator.ts:70`,
`apps/desktop/src/main/sync/engine/pull-coordinator.ts:133`,
`apps/desktop/src/main/sync/engine.ts:630-643`), which is held across the whole
push including its `POST /sync/push`. Only the stale-lock watchdog
(`apps/desktop/src/main/sync/engine.ts:686-697`, 15 minutes) can overlap them.
A client without such a lock — or a core with a background outbox — hits the
mirrored state routinely.

What happens from the mirrored state, by P3 and P4 of §6.5.2:

1. both devices return `'conflict'` and re-queue the merged row;
2. both push it under the union clock; the first is accepted (one component
   ahead of the stored row), the second is refused `SYNC_REPLAY_DETECTED` (no
   component ahead of an identical clock) and its queue row is marked done;
3. the refused device pulls the accepted row, whose clock EQUALS its own, and
   `resolveClockConflict` applies it wholesale (P4).

Both devices end on the value whose re-push landed first, within one sync cycle.
Pinned by `apps/desktop/src/main/sync/engine/conflict-report.test.ts` and
`packages/sync-client/src/item-handlers/types.test.ts`.

**Residual, cosmetic.** Both devices also write a `superseded` activity row with
the **same id**, minted from `mergedClock`
(`apps/desktop/src/main/tasks/activity-log.ts:385`), carrying opposite
`winningValue`s. One overwrites the other on the server (P1), so an activity
entry can name as "winning" the value that the convergence step then discarded.
The task itself is not affected.

**Core obligation.** Implement P3 and P4. A core that merges without re-queueing,
or that treats an equal clock as a no-op, turns this race back into the
permanent divergence this section once described.

## 6.7 Field lists

**Normative.**

`TASK_SYNCABLE_FIELDS`, **15** entries in order
(`packages/sync-client/src/field-merge.ts:11-27`):

```
title, description, projectId, statusId, parentId, priority, position,
dueDate, dueTime, startDate, repeatConfig, repeatFrom, sourceNoteId,
completedAt, archivedAt
```

`PROJECT_SYNCABLE_FIELDS`, **9** entries in order
(`packages/sync-client/src/field-merge.ts:29-39`):

```
name, description, color, icon, position, isInbox, archivedAt, modifiedAt,
homeNoteId
```

**A field absent from the list is not merged at all** and does not appear in
`merged` (`packages/sync-client/src/field-merge.ts:117`).

`initAllFieldClocks(docClock, fields)` seeds **every listed field** with a copy of
the document clock (`packages/sync-client/src/field-merge.ts:41-45`). It is what
a client uses when a row has a document clock but no field clocks yet
(`packages/sync-client/src/offline-clock.ts:76`, `:92`).

## 6.8 Which types merge which way — Q06.5

**Normative.**

| Type                            | Algorithm                                        |
| ------------------------------- | ------------------------------------------------ |
| `task`                          | field-level merge over `TASK_SYNCABLE_FIELDS`    |
| `project`                       | field-level merge over `PROJECT_SYNCABLE_FIELDS` |
| `settings`                      | dotted-path field clocks, §6.9                   |
| **every other subscribed type** | the document-level resolver of §6.3.1            |

The field-level path exists only where a payload carries `fieldClocks`
(chapter 13 §13.5); the two lists above are the only two in the tree
(`packages/sync-client/src/field-merge.ts:11-39`). Every other type carries only
`clock` and takes the `resolveClockConflict` path
(`packages/sync-client/src/item-handlers/types.ts:58-68`).

**A client MUST NOT infer the algorithm from the absence of a list.** The table
above is the enumeration.

**Disposition of Q06.5: answered** (this section).

## 6.9 Settings use a third shape

**Normative.** Field clocks for `settings` are keyed by **dotted path at
arbitrary depth** — `general.theme`, `journal.weekdayTemplates.3`,
`sidebar.sortModes.collections`
(`packages/contracts/src/settings-sync.ts:78-93`, `:111-116`). The whole settings
blob is **one sync item** with `itemId = 'synced_settings'`
(`packages/sync-client/src/settings-sync.ts:196`,
`packages/sync-client/src/settings-sync-keys.ts:12`).

Some sub-objects are deliberately single-clocked as a unit, and the reasons are
in the schema comments:

- `sidebar.sectionOrder` — one list, one clock, because reordering is a
  whole-list operation and the last device to drag wins rather than two partial
  orders interleaving (`packages/contracts/src/settings-sync.ts:97-100`);
- `sidebar.navCollapsed` — one flag, one clock, because collapsing hides the
  whole block at once (`packages/contracts/src/settings-sync.ts:102-105`);
- `sidebar.notesFirst` and `sidebar.showFiles` — one flag and one clock each,
  same shape as `navCollapsed`: each is one whole-tree view choice for the
  Collections tree, and absent means today's tree (folders first, files shown)
  (`packages/contracts/src/settings-sync.ts:107-112`).

By contrast `journal.weekdayTemplates.<day>` carries a clock per day, so two
devices editing different days both keep their edit
(`packages/contracts/src/settings-sync.ts:78-87`).

**A key outside the modelled set MUST ride along rather than fail the payload**:
the schemas leave these keys unconstrained strings precisely so that one
malformed or future key cannot stall every other synced setting
(`packages/contracts/src/settings-sync.ts:83-86`, `:99-100`). This is chapter 13
§13.2 applied to settings.

### 6.9.0 The winner rule, and what an absent winner means here

§6.9 gives settings a key space and §6.9.1 gives the write rules; neither gave
the **arbitration** rule, so a port had to infer one.

**Normative: a settings path is arbitrated by §6.3's rule, unchanged.** They are
called field clocks because they are field clocks — the tick sum, the asymmetric
`_offline` key-presence tie-break of row 8, and §6.4.2's canonical comparison all
apply per path exactly as they apply per field. The merge unit set is the
**union of both payloads' `fieldClocks` keys**, which is also what makes the
single-clocked sub-objects work without a table: the unit is whatever key the
writer declared, so `sidebar.sectionOrder` arrives as one key holding the whole
list and `journal.weekdayTemplates.3` as a key per day. A port that derived the
unit from a hard-coded list of paths instead would drift from the writer the
first time a new setting was added.

**Normative, and it diverges from §6.3.2 row 10 on purpose: when the winning
side has no value at that path, the path is REMOVED from the merged settings.**
Row 10 leaves a column untouched when the winner is `undefined`, because for a
task field an absent value means "the sender does not model this" (§13.4) and
overwriting would let an older build delete a newer build's data. **Settings are
not like that.** §13.2 makes a settings payload carry every preference its sender
holds, so an absent path is the sender saying the preference is gone, not that it
cannot see it.

The consequence of getting this wrong is not subtle. §6.9.1 requires a removal to
tick its clock precisely so it can beat the peer still holding the old value; if
a ticked removal then failed to remove, the peer's value would win on the next
pull, the clearing device would re-clear, and the two would **diverge
permanently** under FR-002. The tick and the removal are one mechanism and a port
MUST implement both halves.

**A `fieldClocks` key that is not an addressable path** — `""`, or one with an
empty segment such as `general.` — **rides along as a clock and arbitrates
nothing.** §6.9 already requires a key outside the modelled set to ride along
rather than fail the payload; an unaddressable key is that rule's limiting case,
and refusing the payload over one would stall every other synced setting.

### 6.9.1 Every clocked path is a leaf, including a removal

Every example above is a leaf, and that left two questions a writer has to
answer on its first line of code.

**A write MUST clock the path it wrote, and MUST NOT clock an ancestor of it.**
Ticking `journal` because `journal.weekdayTemplates.3` changed would make an
edit to Wednesday beat a concurrent edit to Thursday, which is exactly the
interleaving the per-day clock exists to allow. The single-clocked sub-objects
above are single-clocked because their **declared** path is the whole object,
not because a writer chose to clock higher.

**Removing a key MUST tick that key's clock.** This is the one that is silently
wrong if you do not think about it: a removal that ticks nothing loses to the
peer still holding the old value, and the setting the user cleared comes back on
the next pull. A removal is a write.

**This specification defines no rule for pruning the clocks under a path whose
value is replaced by a non-object, and a client MUST NOT invent one.** Dropping
a clock is not reversible and changes a future winner, so it falls under §6.10's
reasoning: it would be a format change under chapter 00 §0.8 obligation 3. A
client that replaces a subtree leaves the descendant clocks where they are; they
are keys outside the modelled set, and the paragraph above already says those
ride along.

## 6.9.2 Unknown keys on the merge branch, and the tombstone short-circuit

Chapter 13 §13.2 rule 3 says what a **local edit** does with a key this build
does not model: it keeps it. Nothing said what the **merge** branch does, and
the two are not the same operation — a merge has two payloads and has to choose
whose unmodelled keys survive.

**Normative: a field merge keeps the local copy's unmodelled keys and does not
carry the remote's.** This is the generalisation of §6.7's rule that a field
absent from the syncable list is not merged at all: the merge writes exactly the
listed fields it decided, and everything else in the stored payload is left
where it was. A remote key this build does not model is not lost — it is in the
remote payload, which the sender still holds, and it arrives through the listed
fields the moment a build that models it adds them to the list. Carrying it
instead would make a merge silently import state no clock arbitrated.

**Normative: a tombstone bypasses the field merge entirely.** §13.7.2 already
says deletes never reach any parser; the consequence for this chapter is that a
delete is applied without reading `fieldClocks`, without the document gate, and
without a per-field decision. There is nothing to merge — a deleted row has no
fields — and a merge attempted on one would fail to parse a payload that is
legitimately absent and record a delete as corrupt.

## 6.10 Clock growth — Q06.6

**Normative: nothing prunes a vector clock, and this specification defines no
pruning rule.** There is no pruning in
`packages/sync-client/src/vector-clock.ts`, none in
`packages/sync-client/src/field-merge.ts`, and none on the server: the push path
stores `clock = excluded.clock` verbatim
(`apps/sync-server/src/services/sync.ts:668-686`).

The growth is bounded by the device cap, not by time: at most 50 active devices
per account (chapter 02 §2.3.3), so at most 50 keys per document clock and 50 per
field clock, times 15 fields for a task. **A conforming client MUST accept a
clock with a key for a device it has never heard of and MUST NOT drop it**;
dropping a key lowers `clockTotal` and changes the winner.

**This is recorded as a known unbounded-in-principle growth.** A pruning rule
cannot be added by one implementation alone: dropping a key changes
`clockTotal` and therefore the winner, so any future rule is a format change
under chapter 00 §0.8 obligation 3.

**Disposition of Q06.6: answered (no pruning rule; growth is bounded by the
device cap and recorded).**
