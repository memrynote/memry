# G4 and G5 evidence — `memry-cli` against staging

Recorded as the runs happened, not reconstructed. Every number below is copied
out of the run's own output. The account is the staging account; its address is
redacted here because this file is committed and the transcript is not.

Server: `https://sync-staging.memrynote.com`. Client platform: `ios`.
Largest vault: `692184c5-c51c-48b4-9fba-0771ed37e34e`.

## T115 — G4, the headless read path

### `login` completing

```
$ memry --server staging --client-platform ios login --email <redacted>
a six-digit code was sent to <redacted>
one-time code: signed in as <redacted>
state Registered
```

The code was read from the account's mail and fed on stdin; §G4 gives no flag
for it. The device is registered and visible in the desktop device list.

### `unlock`, and the four vaults

```
$ memry ... unlock --recovery-phrase-file <outside the repo, mode 600>
unlocked

$ memry ... vaults
692184c5-c51c-48b4-9fba-0771ed37e34e	7L2zcivUAUvqgdDuzZogvRvYuU4rDtO5H8cUI7jxVNat++BC
201e9e92-7fec-4c6d-9feb-e4a65b0a1ede	gLcLApsCCaYDbbl3sp4sU2GG
329c33a9-166b-4ac0-80a3-1b258ac1abc3	K7luymgdzFjskz0cm4DNsEzOPi9obOzmnPjbR1k=
46c45221-a14a-4393-86e3-3600190bb037	vY6qUP1mjxmfxDm1cuE1N/ek4HTb7nHSiQ==
```

### `pull`, both halves

The record feed was already at its cursor from an earlier session, so this run
shows the steady state rather than a first sync. **`corrupt 0` is the line that
matters**: the five wire mismatches this phase found were all discovered as
non-zero corrupt counts.

```
pages 1   applied 0   deleted 0   skipped 0   corrupt 0   expired 0
dropped-pages 0   cursor 7598   has-more false   refused false
bodies 136   updates 4254   baselines 48
```

A second, previously unpulled vault, to show a live apply:

```
$ memry ... pull --vault 201e9e92-7fec-4c6d-9feb-e4a65b0a1ede
pages 1   applied 1   deleted 0   skipped 0   corrupt 0   expired 0
cursor 5989   has-more false   refused false
```

`skipped` is new in this transcript: §6.3.1's document gate landed in this
phase, and folding a legitimate skip into `applied` or `corrupt` would
misreport the run.

### `notes list`, `notes text`, `notes state-vector`

94 notes in the largest vault. For `dzxnhc9p3gk3`, a desktop-authored note:

```
## Boundaries
- Renderer — React 19, no Node access
- Main — Electron, owns SQLite + Y.Docs
...
```

Real heading and list text, and a non-empty state vector:

```
09e0f4d0b50b3c8695a2a30a11c7d1eaf10bab03e8ffc5d60a39c9feaac90d319884eae20401b7ac8cb30781018ca0edc20206b79585bd0808
```

**Two observations recorded rather than smoothed over.** The blanks in
`"See  and  for the data layer."` are expected — `extract_text` drops wiki-link
nodes (§12.1). But `"Why Electronss"`, `"#projectsa/memry #architectur"` and
`"never sees killall Simulator"` read like character-level CRDT interleaving
from past concurrent edits. That is plausible for a note edited on several
devices, and it is **not** evidence that `extract_text` is wrong: the
`text-extract` vector class is green. It must be compared against desktop's
own extraction before SC-010's cross-shell digest treats this note as a
reference.

## T137 — the kill-switch drill

`client_policies` for platform `ios`, flipped on staging and restored.
The client **parks rather than earning a literal 403**: §11.8.1 and §11.9
require the policy to be learned on a `GET` _before_ a write is attempted, so
the evidence is the server's own `clientPolicy` echoed beside the derived gate.

### 1. Switch off, a write queued

```
$ memry ... notes edit z01wzfmf44ka --append "G5 blocked-write probe"
appended 156 bytes as block f889bc8f-..., local update 1
```

### 2. `push` — parked, not attempted

```
gate read-only          writes-enabled false     min-write-version -
pending 1   iterations 0   accepted 0   rejected 0   retired 0
crdt-updates 0   batch-ceiling 0   halvings 0
queued 1    attempts 0   refused -
memry: writes are blocked (read-only): the outbox is parked, not drained (chapter 11 §11.9)
exit=1
```

`iterations 0` is the assertion that no request was made. Exit 1, because a
parked queue is not a successful push.

### 3. Reads continue, ungated

```
$ memry ... pull --vault 692184c5-...
pages 1   applied 0   deleted 0   skipped 0
```

### 4. A second blocked pass — `attempt_count` still untouched

```
gate read-only   queued 1   attempts 0
```

§11.9: a blocked state parks the outbox with no attempt, no backoff and no row
removed, so the queue drains at full speed the moment the policy clears.

### 5. First pass after the switch cleared

```
gate open   writes-enabled true   min-write-version -
pending 1   iterations 1   accepted 1   rejected 0   retired 0
crdt-updates 1   batch-ceiling 100   halvings 0
queued 0    attempts 0   refused -
exit=0
```

Drained on the **first** pass, and `attempts 0` throughout: the parked passes
cost the row nothing.

**Staging was restored**: `client_policies.writes_enabled = 1` for `ios`,
verified by reading the row back.

## The first real headless write

Before the drill, the append queued during it was pushed and read back:

```
$ memry ... push --vault 692184c5-...
gate open   pending 1   iterations 1   accepted 1   crdt-updates 1   queued 0

$ memry ... pull --vault 692184c5-...      # updates 1
$ memry ... notes text dzxnhc9p3gk3 --vault 692184c5-...
...
T137 kill-switch drill
```

The appended paragraph survives the round trip through the server. This is the
first time anything in this feature has written to a server: `PushSealer` had
no production implementation until this phase closed it.

## What G5 still needs, and why it is not here

T139 also requires a **recorded round trip against a running desktop** —
`memry-cli` edit to desktop under 5 s and desktop edit to `memry-cli` under
5 s, and concurrent edits converging with both field changes surviving. Those
halves need a desktop app running against the same staging account and are not
recordable from a headless session alone. SC-014's injected unknown item type
and SC-010's cross-shell digest are likewise pending.

## T139 — G5, partially closed

### `memry-cli` edit to desktop: **PASS, 2.16 s**

A desktop was running against the same staging account and the same vault
(`pnpm --filter @memry/desktop dev:a:staging`, vault `692184c5-…`). Its vault
is a real directory of markdown files, so the propagation was measured against
**what the desktop wrote back to disk** — not against a database row, and not
against a UI observation.

```
marker: cli-to-desktop 141820
$ memry ... notes edit z01wzfmf44ka --append "cli-to-desktop 141820" --vault 692184c5-…
$ memry ... push --vault 692184c5-…
accepted 1   crdt-updates 1   queued 0
elapsed: 2.16s
PRESENT in the desktop vault file
```

That 2.16 s covers the whole path: the yrs append, the seal, the push, the
server, the desktop's realtime receive, its CRDT apply, its render, and its
write-back to `projects/Conference Talk.md`. **Under the 5 s bar.**

An earlier CLI write, `G5 blocked-write probe`, was already present in the same
file before this run — so the direction was proven twice, once incidentally.

### Desktop edit to `memry-cli`: **PASS, 1.86 s**

Measured with `notes fetch`, a single-document body pull added because the 5 s
bar could not be evaluated without one. The probe's own cost, with nothing to
fetch, is **0.44–1.84 s** against the full pull's **31.9–36.4 s**.

```
marker: d2c 143816
DESKTOP -> CLI in 1.86s
```

Desktop PID liveness was checked inside the loop, so a dead desktop reports
itself instead of looking like a timeout — the failure mode that made the first
attempt worthless.

**Both directions of T139's timing now pass**: `memry-cli` → desktop **2.16 s**,
desktop → `memry-cli` **1.86 s**, against a 5 s bar.

The edit is made by writing to the vault's markdown file, which the desktop
watcher ingests through `feedExternalEditToCrdt` — the desktop performs the
Y.Doc replace and the push. It is a desktop-side write, not a UI gesture; an
edit typed into the editor exercises the same path from `replaceNoteBodyInCrdt`
onward. The file was restored and verified identical after every run.

### Superseded measurement, kept because its correction matters

Re-run with the desktop confirmed alive and a liveness check on its PID **inside**
the poll loop, exactly as the first attempt's correction prescribed.

```
marker: desktop-to-cli 143520
REACHED CLI in 41.10s
```

**The direction works.** The desktop ingested the external vault-file edit,
replaced the note body in its Y.Doc, pushed, and the CLI read it back. The first
attempt's failure is explained: every Electron PID from that run had exited.

**But 41.10 s is the instrument, not the latency.** A bare `pull` on this vault
with **nothing to fetch** was then measured twice:

```
pull 1: 31.91s
pull 2: 36.41s
```

The probe walks the record feed and then all 136 document bodies on every
iteration, so the loop cannot resolve anything finer than one pull. Actual
propagation was under roughly 9 s and is not resolvable further from this data.

**T139's "under 5 s" therefore cannot be evaluated with a full-vault pull as the
probe, and `memry-cli` currently offers no cheaper one.** That is a gap in the
task's measurability rather than a property of the protocol: the CLI needs a
single-document body fetch — `pull --document <id>` or equivalent — before this
half of T139 can be stated as a pass or a fail. Recorded rather than papered
over with the 41.10 s figure, which would have read as a 5 s-bar failure and
would have been wrong.

**Separately worth Kaan's attention**: a no-op pull costing 32–36 s on a 94-note
vault is slow in its own right, independent of T139.

### First attempt, superseded — kept because its correction matters

Attempted by appending a line to the vault's markdown file directly, on the
theory that the desktop watches the vault directory and would ingest it as its
own edit. After 90 s the line had not reached the CLI.

**An earlier version of this note claimed the unchanged mtime proved the desktop
never ingested the edit. That inference was wrong and is withdrawn.** The
desktop watches the vault with chokidar and hands changes to
`feedExternalEditToCrdt`, which replaces the note body in the Y.Doc and pushes;
it does not rewrite the file. An unchanged mtime is therefore exactly what a
**successful** ingest also looks like. What is established is only that the edit
did not reach the CLI within 90 s; where it stopped was not determined, and
determining it needs the desktop's logs.

**A third reason the run proves nothing**: every Electron PID from that desktop
had exited by the end of the session. It was demonstrably alive at 14:18:20, when
the CLI→desktop marker reached its vault file in 2.16 s, and the external-edit
attempt began at 14:18:27 — but nothing establishes it was still running through
the 90 s poll. A dev build exiting mid-experiment was not ruled out.

Re-run this with a liveness check on the Electron PID **inside** the poll loop,
so the run either produces evidence or says why it could not.

Recorded as a failed _method_, not a failed requirement. An external file edit
is not the same thing as an edit made in the desktop app — T139 asks for the
latter, and the desktop's file-watch behaviour in a dev build is a separate
question from whether the core receives a desktop edit promptly. The file was
**restored to its pre-attempt contents**, verified byte-identical against a
backup taken before the write.

Closing this half needs an edit made in the desktop UI, which is Kaan's to
make or to authorise automating.

### Still open in T139

- concurrent edits converging against a real desktop (T133 proves byte-identical
  convergence against real `yrs` and a real database, including §12.5.0's layout
  check — the _desktop_ half is what is missing);
- SC-014's injected synthetic unknown item type, which needs a direct D1 write;
- SC-010's cross-shell digest, which needs desktop's extracted text for one note.

## SC-010 — the cross-shell digest, core side

`cross_shell_digest` lives in `memry-core` (`crdt/text_extract.rs`), not in the
shell: SC-010 compares a value produced by **two** shells, and a digest each one
assembles itself is two chances to disagree about something neither is testing.

`memry notes digest <id> [--vault <id>]` prints it. Computed inside the core over
the extracted bytes — **not** reconstructed from `notes text`, whose `println!`
appends a newline that is not part of the digested input. A harness that hashed
the printed form would report a content mismatch between two shells that agree,
and the test asserts that trap rather than describing it.

Core-side values for three notes in `692184c5-…`, at the state recorded above:

| note           | title                  | digest                                                             |
| -------------- | ---------------------- | ------------------------------------------------------------------ |
| `dzxnhc9p3gk3` | memrynote Architecture | `1930ae6ab6947e6726d98728caeda0fc1764b84d48a2f0209e0c5f45d532c3c0` |
| `z01wzfmf44ka` | Conference Talk        | `751cdf473f74d5508494ad02eb422d332444248a1c0abbbebfd079704808d95e` |
| `n6t4tk1ykzi9` | memrynote Mobile       | `d3a3359d0ed60c1b474816f97fa283da4b223d2720c8972e8213210698df0ab4` |

**The comparison is not made yet.** These are one side. SC-010 closes when
desktop produces its own digest for the same note at the same state and the two
match. `text-extract.json` is the contract that makes a mismatch meaningful:
both ports are already held to the same extracted bytes by the vector class, so
a digest mismatch means the **content** differs, not the extractors — which is
§12.11's whole point.

§12.11's caveat carries: the extractors agree on dropping literal angle brackets
(§12.1.3.1), so a match proves both shells produced the same text, not that the
note's text survived intact.
