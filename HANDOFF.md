# Phase 3 handoff — specs/002-native-foundation-ios

Overwritten each session. Everything below was observed, not reported by a subagent.

## Where the work is

Branch `native-core-phase-3` in `.worktrees/native-core-phase-3`, fast-forwarded
with `origin/main`. Straight to main, no PR, per Kaan's standing instruction.

## State: **Phase 3 complete — 64 of 64 ticked, 0 open**

All three gates hold.

| Gate   | Status                                                                                                                                                                                                                                                                                                                                                                                         |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G3** | **CLOSED.** Eleven vector classes green; `spec-defects.md` at 0 open, 88 closed; fmt/clippy/test/line-ceilings green; T094's binding diff clean; all four spike notes carry an explicit verdict.                                                                                                                                                                                               |
| **G4** | **CLOSED.** T115's transcript in `g4-evidence.md`: login, unlock, four vaults, a pull with **0 corrupt**, 94 notes, real extracted text and a non-empty state vector from a desktop-authored note.                                                                                                                                                                                             |
| **G5** | **CLOSED.** T137's kill-switch drill; T138 at zero; T139's round trip — CLI→desktop **2.16 s**, desktop→CLI **1.86 s**, concurrent note edits converging across three implementations, concurrent **task** field edits converging with all four fields surviving, SC-010's digest identical between `memry-core` and the TypeScript reference port on three real notes, SC-014 run on staging. |

T082 and T094 ran on a **physical iPhone 12 Pro**, arm64, iOS 27.0 — not the
iPhone 15 the tasks name, and the S4 note says so in the sentence that presents
the result.

## Current gate baseline — re-run and observed at the end of this session

| Gate                                           | Result                                           |
| ---------------------------------------------- | ------------------------------------------------ |
| `cargo fmt --all --check`                      | clean                                            |
| `cargo clippy --all-targets -- -D warnings`    | clean                                            |
| `cargo test`                                   | **526 passed, 0 failed, 1 ignored, 35 binaries** |
| `node scripts/check-line-ceilings.mjs`         | passed (104 files)                               |
| `pnpm --filter @memry/contracts vectors:check` | **11 classes**                                   |
| `pnpm typecheck`                               | 19/19                                            |
| `pnpm lint`                                    | 1 pre-existing warning, `vault-switcher.tsx:96`  |
| `pnpm docs:build`                              | complete                                         |
| `git diff --exit-code` on generated Swift      | clean                                            |
| xcodebuild Unit / UI (iPhone 17)               | 6 / 4 tests, TEST SUCCEEDED                      |

The single ignored test is deliberate: `outbox_durability.rs`'s child process,
re-invoked by its parent to simulate SIGKILL.

Anything worse than this is the next session's to fix, not to inherit.

## The pattern this session found, five times

**A tier can be fully implemented, well tested behind fakes, and never wired.**
Every one of these passed the whole unit suite and every vector class:

1. **The field merge was unreachable.** `pull.rs` routed every type through
   `sync_items::apply_remote`, which applies wholesale. A concurrent `title` /
   `dueDate` edit silently lost one. FR-002 and FR-059 were not met end to end.
2. **§6.3.1's document gate was never implemented** for the other eleven types.
   A stale remote record overwrote a newer local one — rename a note here,
   receive an older record, lose the rename.
3. **§6.9's settings merge stored wholesale inbound.** A remote push reverted a
   local preference change whose path clock dominated.
4. **§7.15's purge and projection delete had no call site.** A deleted note
   stayed visible in every projection-driven read, and the next first sync
   re-pulled its body.
5. **`PushSealer` had no production implementation.** Every impl was a test
   fake, `PushCoordinator` could not be constructed outside a test, and
   `memry-cli` had never pushed anything to a server.

**Treat "it is implemented" as unproven until you find the call site.** A
`grep` for the production caller is a five-second check that would have caught
all five.

## The second pattern: break-tests caught five weak assertions

Each of these **passed under the very bug it was written for**, and was only
found by deliberately breaking the code and watching which tests stayed green:

- T133's convergence test passed with the desktop appending a `blockContainer`
  beside the `blockGroup` — both devices converged byte-identically and
  `extract_text` returned the same string. Only the §12.5.0 **layout**
  assertion caught it. **Byte identity is necessary and not sufficient.**
- T134's delete/edit equality held at `(None, None)` with `projectors::delete`
  removed — it agreed the note was undeleted.
- The settings removal test covered only the clearing seat, where local wins
  and the value is already gone.
- Two more in the seam-test wave.

**Break every new assertion, watch it fail, restore.** It is the only thing
that found these.

## What is left

**T082 — BLOCKED by decision.** Kaan chose simulator-only; no physical iPhone.
A simulator run is **not** evidence: `aarch64-apple-ios-sim` runs on the host
CPU with host memory, so Argon2id always succeeds and that says nothing, and it
links a different libsodium from the device slice. Never record this as
"PASS (simulator)". Recorded BLOCKED in `research.md` §Addenda.

**T094 — two of three evidence items pass.** `cargo test -p memry-core` green
with 100% of committed vectors; `build-xcframework.sh` then
`git diff --exit-code` on the generated Swift **clean**. The third item, the
physical-device `.xcresult`, is blocked with T082.

**T138 — verified at zero.** 87 defects logged, 87 closed, 0 open. Re-checked
by counting the rows, not by trusting the footer: the numbering runs 1–87 with
no gaps and no duplicates. (Entry 1 uses padded `| 1   |` formatting, so a
naive `^\| [0-9]+ \|` grep undercounts by one — that is why the count is done
against `seq`.)

**T139 — the only real blocker, and it needs a desktop.**

Done and recorded in `g4-evidence.md`:

- the kill-switch drill (T137) in full, staging restored to `writes_enabled=1`;
- the first real headless write: append → `push` → `pull` → `notes text`
  showing the paragraph survive the round trip through the server.

Not done, and not doable headlessly:

- **`memry-cli` edit to desktop: DONE, 2.16 s.** Measured against what the
  desktop wrote back to its vault markdown file on disk, so it covers the yrs
  append, the seal, the push, the server, the desktop's receive, apply, render
  and write-back. Under the 5 s bar. Recorded in `g4-evidence.md`.
- **Desktop edit to `memry-cli`: PASS, 1.86 s.** Measured with `notes fetch`,
  the single-document probe added for this. Both timing halves of T139 now
  pass: CLI → desktop **2.16 s**, desktop → CLI **1.86 s**, against a 5 s bar.
  Superseded detail below, kept for its correction.
- ~~**Desktop edit to `memry-cli`: DIRECTION WORKS, 5 s bar unmeasurable.**~~
  Re-run with the desktop alive and a PID liveness check inside the loop:
  **reached the CLI in 41.10 s**. The desktop ingested the external vault-file
  edit, replaced the body in its Y.Doc, pushed, and the CLI read it back — so
  the first attempt's failure was the dead desktop, as the correction predicted.
  **The 41.10 s is the instrument**: a bare `pull` with nothing to fetch costs
  **31.9 s and 36.4 s** on this vault, because the probe walks the record feed
  and all 136 bodies every iteration. Real propagation was under ~9 s and is not
  resolvable further. **T139's 5 s bar cannot be evaluated until `memry-cli` has
  a single-document fetch** (`pull --document <id>` or equivalent). That is a
  measurability gap in the task, not a protocol property. A no-op pull costing
  32–36 s on a 94-note vault is also worth attention on its own.
- ~~**Desktop edit to `memry-cli`: NOT DEMONSTRATED.**~~ Appending to the vault's
  markdown file directly did not reach the CLI within 90 s. The file was
  restored byte-identically.

  **An earlier version of this file said the unchanged mtime proved the desktop
  never ingested it. Withdrawn — the inference is wrong.**
  `apps/desktop/src/main/vault/watcher.ts` hands changes to
  `feedExternalEditToCrdt`, which replaces the note body in the Y.Doc and
  pushes; it does **not** rewrite the file. An unchanged mtime is exactly what a
  successful ingest also looks like. Only this is established: the edit did not
  reach the CLI in 90 s. Where it stopped needs the desktop's logs.

  Worth knowing before re-running: `feedExternalEditToCrdt` has a
  `wasRecentNetworkUpdate` branch broadcasting `sync:concurrent-edit`, and a CLI
  write had landed seconds earlier, so that branch was live.

  **And the desktop process was later found dead.** Every Electron PID from the
  `dev:a:staging` run had exited by the end of the session. It was demonstrably
  alive at 14:18:20 — the CLI→desktop marker reached its vault file in 2.16 s —
  and the external-edit attempt began at 14:18:27, but **nothing establishes it
  was still running through the 90 s poll.** A dev build exiting mid-experiment
  is the simplest explanation of all and was not ruled out.

  So the attempt is inconclusive for three independent reasons: the mtime proves
  nothing, the concurrent-edit branch was live, and the desktop's liveness
  across the window is unknown. **Do not carry "the desktop ignored it" forward
  as a finding.** Re-run it with a liveness check on the Electron PID inside the
  poll loop, so the run either produces evidence or says why it could not.

  Either way it is a failed _method_, not a failed requirement: an external file
  edit is not an edit made in the desktop app, which is what T139 asks for.

- **concurrent edits converging: PASS**, via two `memry-cli` devices (a second
  profile, `HOME`-scoped), so both sides take the incremental append path — the
  same one a UI edit takes. Both held an edit, both pushed, **both edits
  survived**, and all three implementations agree: device A, device B and the
  desktop read from its vault file. §12.11's digest matches byte for byte
  between the two cores. Superseded failure below, kept for defect 88.
- ~~**concurrent edits converging: FAILED via the external-edit path, and the
  method is the cause.**~~ A held `memry-cli` edit plus a concurrent desktop
  vault-file edit lost the CLI's paragraph from both sides.
  `replaceNoteBodyInCrdt` does `fragment.delete(0, fragment.length)` then
  re-seeds, so the peer's update merges into tombstoned content — applied,
  converged, invisible. **A real data-loss path** (spec-defect 88, chapter 12
  §12.5.0.1), and **not** a demonstration that normal editing loses edits: a
  UI edit takes the incremental path. Closing T139's convergence half needs an
  edit made in the desktop **editor**, not in the file.
- ~~**concurrent edits converging with both field changes surviving** against a
  real desktop.~~ Note that T133 already proves byte-identical convergence with
  real `yrs` and a real database, including the layout check; what is missing
  is the _desktop_ half.
- **SC-014: run on staging (Kaan authorised staging only; prod untouched).**
  A type in **no** server enum is rejected with a batch-level `400`, so it
  cannot be placed on the server at all — **and the rejected row wedges every
  record push**, see follow-up 8. A type the server knows but this core does not
  declare (`bookmark`) pushes fine and is then **filtered by the server**:
  device B, declaring only the subscribed thirteen, never received it and held
  its cursor below the item. A client cannot mishandle an undeclared item
  because it never sees one; T135's defensive handling stays correct for a page
  that does carry one. The synthetic item was tombstoned off staging.
- **SC-010: PASS.** `memry-core` and the TypeScript reference extractor produce
  **identical digests on three real notes** from the staging account
  (`packages/contracts/scripts/sc010-probe.ts`). Two harness traps recorded
  there: the vault markdown file is not the input, and the update log alone
  yields an empty document because `load_plan` starts from the snapshot.
- ~~superseded, kept for its detail:~~
- **SC-010: two-device digest match achieved; cross-SHELL still open.** Two
  independent `memry-core` devices produced the identical digest
  `c0716414…b60c042` for the same note. Both are the same implementation, so
  this is necessary and not sufficient — **desktop computing its own digest is
  what remains.**
- **SC-010's cross-shell digest — the core half is DONE.**
  `cross_shell_digest` is in `memry-core` (not the shell, because SC-010
  compares two shells' values and a digest each assembles itself is two chances
  to disagree). `memry notes digest <id> --vault <id>` prints it; three values
  for the staging vault are in `g4-evidence.md`. **The comparison is not made**:
  it needs desktop's digest for the same note at the same state.

**A second CLI profile is not a substitute.** `HOME` scopes the profile, so a
second device is possible in principle — but it costs another device
registration and T139 asks for a _desktop_, not a second headless client. An
attempt this session hung with zero output, almost certainly OTP rate limiting
after three requests in quick succession; it was abandoned and cleaned up.

### Routes already tried for the desktop half — do not re-investigate

1. **Appending to the vault markdown file directly.** Did not reach the CLI in
   90 s; the file was restored byte-identically. **Not** evidence that the
   desktop ignored it — see the correction above.
2. **The localhost Vault MCP server**, which would have made a genuine
   desktop-side write through a designed API. **Not listening.** Checked every
   Electron PID with `lsof -nP -iTCP -sTCP:LISTEN`; the only local node
   listeners belong to other tooling. Consistent with `CLAUDE.md` describing
   MCP-first as the current _direction_ rather than something this build ships.
3. **A second `memry-cli` profile** (`HOME` scopes it). Possible in principle
   and **not a substitute** — T139 asks for a desktop, not a second headless
   client. The attempt also hit what looks like OTP rate limiting.

What is left is driving the desktop UI, which is intrusive on a live app
holding real data and is Kaan's call, or Kaan making one edit by hand.

## Cleanup — the account is back to its pre-session content

Every marker written this session was removed and the removal verified to
propagate to both CLI devices: `G5 blocked-write probe`, `cli-to-desktop …`,
`conv-A-…`, `conv-B-…` from "Conference Talk", and `T137 kill-switch drill`
from "memrynote Architecture". `diff` against the pre-cleanup backups shows only
those lines removed.

**A second `memry-cli` device was registered** for the convergence test
(profile at `/tmp/g5b`, which is temporary). It is a real device row on the
account and is worth revoking with the other stale ones.

## Superseded — two writes that landed in Kaan's real notes (now removed)

`notes edit --append` can only append; there is no CLI path to remove a block.

- `dzxnhc9p3gk3` ("memrynote Architecture") gained `T137 kill-switch drill`
- `z01wzfmf44ka` ("Conference Talk") gained `G5 blocked-write probe`

Both were needed to exercise the write path and the kill switch. Remove them
from a desktop when convenient.

## Staging facts

- Base URLs: staging `https://sync-staging.memrynote.com`, prod
  `https://sync.memrynote.com`, local `http://localhost:8787`. Not hardcoded —
  `SYNC_SERVER_URL` comes from a gitignored `.env.<environment>`, so a worktree
  missing it falls back to localhost **silently**. `pnpm env:check` → 10 items.
- The staging D1 is **`memry-sync-staging`** (the quickstart said `memry-staging`
  and every invocation would have failed — spec-defect 54).
- `client_policies` has one row, `ios`, **`writes_enabled = 1`**, restored after
  the T137 drill and read back to confirm.
- **28 devices active of the 50 cap** (20 ios, 8 macos). Worth revoking the
  stale ones, but note the cause is **not** repeated CLI logins: `login` on a
  profile that already holds a registered device re-authenticates it rather
  than registering a new one. Verified — the newest `ios` row is 2026-09-09,
  unchanged by this session's login. A _fresh profile_ does cost a slot.
- **OTP requests are rate limited.** Three in quick succession and the fourth
  hangs with no output rather than erroring. Budget one login per session.
- Credentials live outside the repo, mode 600:
  `~/.memry/staging/account-email.txt`, `~/.memry/staging/recovery-phrase.txt`.
  **The phrase was pasted into a chat transcript this session — Kaan should
  rotate it.**

## Implementation follow-ups still open

1. ~~**`ApiError` has no `Storage` variant.**~~ **Fixed this session.**
   `ApiError::Storage` exists and `PushWave` reports a disk failure as itself
   rather than as a transport failure. `ApiError::PaymentRequired` is still
   worth considering: a 402 is recognised by matching
   `Status { status: 402, code: Some("SYNC_PAYMENT_REQUIRED") }`.
2. **No CLI command enqueues a _record_ outbox row.** `notes edit` queues only
   CRDT rows, so the staging drills exercise `/sync/crdt/updates` end to end and
   the `/sync/push` record half is proven by vectors and a fake transport, not
   by a live command.
3. ~~**§7.13.3's snapshot cadence is unimplemented.**~~ **The core half landed
   this session**: `snapshot_is_due` with the chapter's 30 s quiet / 120 s cap,
   constants pinned by test. The remaining triggers — document close, shutdown,
   no-editor-open — are shell facts the core cannot see, so **wiring a caller
   that polls it is a shell task**. `SnapshotGate`, the MUST, is untouched.
4. **The socket has no self-driving `run()` loop**; the reconnect policy is
   implemented and tested.
5. **A pulled update does not advance an already-resident `Document`**; it lands
   on the next `load_plan` replay. **Now reported rather than silent**:
   `BodyPullReport::advanced_documents` names the ids, the same shape as
   `purged_documents`. Acting on them is still the registry holder's job, so
   this stays open as a _shell_ task rather than a core one.
6. ~~**`Reachability::observe` is never called** and the seam doc overclaims.~~
   **Doc fixed this session.** `observe` still has no caller — that is correct
   and deliberate, the shell owns _when_ to run a pass — and the module doc now
   separates the shell's obligation from the core's guarantee instead of
   asserting both. Wiring `observe` remains a shell task.
7. **The §7.15 runtime obligation is reported, not performed.** `PullReport`
   gained `purged_documents`; a caller holding a registry must release those.

## Gate exit status — G3 and G4 HOLD; G5 does not

Checked item by item against `phase3close.txt`'s exit criteria, not asserted.

## Gate exit status

- **G3** — vector tier green across all eleven ✅; `spec-defects.md` at zero ✅;
  fmt/clippy/test/line-ceilings green ✅; T094's binding diff clean ✅; T083's
  four spike notes written with explicit verdicts ✅; the device tier recorded
  explicitly BLOCKED rather than passed ✅. **G3 closes with T082 named open.**
- **G4** — closed. T115's transcript recorded in `g4-evidence.md`: login, unlock,
  four vaults, a pull with 0 corrupt, 94 notes listed, real extracted text and a
  non-empty state vector from a desktop-authored note.
- **G5** — **not closed.** T137 ✅ and T138 ✅. T139 needs the desktop halves
  above, plus SC-014's injection and SC-010's digest.

## The exact next wave

1. **Ask Kaan to run, or authorise, the T139 desktop round trip.** A staging
   desktop is already running. The CLI side is ready:
   `memry --server staging notes edit <id> --append "from cli" --vault <v>`
   then `memry --server staging push --vault <v>`; for the other direction,
   edit on desktop and `memry ... pull --vault <v>` then `notes text`.
2. **SC-010's digest** once desktop's extracted text for one note is in hand.
3. **SC-014** needs a decision on injecting an unknown item type into staging.
