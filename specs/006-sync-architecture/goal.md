# Goal: implement the sync architecture epic #2279, end to end, as one verified PR stack

## Objective

Implement every child issue of epic #2279 ("Sync architecture: fast, loss-free device → server → device propagation"). Work in one session, issue by issue, in dependency order. Before each implementation, prove the issue is still valid on the current code. Every change ships with tests that fail before the fix and pass after it. The deliverable is a linear stack of verified PRs that Kaan reviews and lands himself. You never merge and never deploy to production.

## Sources of truth (read once at start, re-read the relevant parts per unit)

1. Root `AGENTS.md`, `apps/desktop/AGENTS.md`, `apps/sync-server/AGENTS.md`. For iOS/Rust work also read `apps/ios/AGENTS.md`.
2. Epic #2279: `gh issue view 2279`. Read the body in full, especially **Invariants**, **Order and dependencies** and **Review 2026-09-24**.
3. `docs/improvement/2026-09-20-sync-architecture-audit.md`: the traced model, latency budget and target architecture.
4. Each child issue in full, **including its comments and its `## Review 2026-09-24` section**: `gh issue view <n> --comments`. **Where the Review section contradicts the original text, the Review section wins.** It corrects five places where the original plan would have caused damage (P2.7 equal-skip, P4.4 `rate_limits`, missing P1.8 repair, P3.4 queue coalescing, P3.3 NULL-cursor backlog).
5. `docs/protocol/*.md`. It is normative. `05-record-sync.md`, `06-vector-clocks-and-field-merge.md` (§6.5.2 P1–P4 are load-bearing), `07-crdt-updates.md` and `09-realtime.md` are the chapters this epic touches. Code that contradicts a normative sentence is a bug in one of the two. Resolve it explicitly: fix the code, or change the doc in the same PR with the reason.

## pstack

- Enable `/skill:poteto-mode` for the whole session and follow it. Read the leaf SKILL.md of every principle you cite.
- Drive with `playbooks/autonomous-run.md`. The exit condition is **Done when** below.
- Stack topology follows `playbooks/autopilot-stack.md`, adapted to this session. Owners are `pi-subagents` subagents (or you), not Cursor cloud agents. You are the only topology writer. Nobody merges, arms auto-merge, or deploys to production.
- Per unit, use `playbooks/bug-fix.md` for `bug` issues and `playbooks/feature.md` for `enhancement` issues. Use the **tdd** skill for every bug fix: write the regression test first, run it, and see it fail for the intended reason.
- Use the **how** skill before touching any subsystem you have not traced this session.
- Run the **architect** skill before implementing the cross-boundary designs: P2.5 (#2292), P3.1 (#2295), P3.3 (#2297), P3.4 (#2298), P4.1 (#2300), P4.2 (#2301), P4.3 (#2302).
- Run the **interrogate** skill on the contested decisions before shipping them: P2.7 content-equal skip (#2294), P1.8 repair trigger (#2382), P3.3 legacy-sweep transition (#2297), P3.5 `coversThrough` bound (#2299), P4.3 purge/resurrection rule (#2302), P4.6 settings arbitration (#2383).
- Verify each PR head with the **swarm** skill: independent verifiers re-run the gates at the exact SHA, plus a receipts-and-diff audit that distrusts the PR body.
- Keep a decision trail with **show-me-your-work** (`decisions.tsv` in the worktree, uncommitted).
- Before each commit run **deslop**. Before each PR run **no-comments**, with one repo override. Keep every comment the repo requires: the issue number on each regression test (sync-server `AGENTS.md`), and "why" comments on invariants a future editor could break (cursor semantics, protocol MUSTs, crash windows).
- Write PR bodies and commit messages under **technical-writing** and **unslop**.
- **Subagents are authorized** for validation explorers, architect/interrogate runners, swarm verifiers and per-PR owners. Use only the pstack role table models for this profile. Give each subagent a bounded handoff: its unit, the files it owns, and its gates. Two concurrent writers never touch the same file.

## Setup

1. Create a worktree from fresh `origin/main` (use the **worktree** skill): path `.worktrees/sync-arch`. Run `pnpm install`, and wait for the native warm-up (`pnpm warm:log`); a long quiet period there is not a hang. For Node-side tests run `pnpm --filter @memry/desktop rebuild:node` once.
2. Create the state file `specs/006-sync-architecture/tasks.md` in the worktree. It holds:
   - operating rules (a short copy of this file's rules);
   - one section per PR unit from the table below, with checkboxes for **validate, design, failing test, implement, gates, docs, live, commit, PR, verdict**;
   - a **Validity log**: one line per issue with the verdict, the evidence (`path:line` at SHA) and the action (implement / narrowed / closed);
   - a **Decisions** log, a **Blockers** section, and a **Rollout** section (deploy order and soak gates for Kaan).

   This file is the only state. After any restart or compaction, re-read it and continue at the first unticked box. Commit it with the first PR and update it in every later PR.

3. Resolve the forge once (`gh` by default) and record it in `tasks.md`.

## Per-issue loop (every issue, no exceptions)

1. **Validate.** Re-read the issue (body, comments, Review section). Check every factual claim against the current worktree HEAD: file, line, behavior. Line numbers drift, so locate by symbol. Write the verdict to the Validity log.
   - **Invalid** (already fixed or the premise is false): comment the evidence on the issue with `gh issue comment` (commit SHA and `path:line`), close it with `gh issue close --reason "not planned"` or `completed`, tick the unit, and move on.
   - **Partially valid:** comment which part is still open, narrow the scope in `tasks.md`, and implement only that part.
   - **Valid:** continue.
2. **Design.** Name the data shape first. For cross-boundary items, run architect. For contested items, run interrogate. State the migration and compat plan in `tasks.md` **before** any schema, contract, wire or format change (root `AGENTS.md` Backward Compatibility).
3. **Failing test first.** Write the narrowest test that encodes the intended behavior. Run it and confirm it fails for the intended reason. Where the issue lists acceptance tests, each one becomes a test. Multi-device bugs need multi-device tests: a regression test that pushes one item into an idle vault never sees #2283 ("accepted 1, cursor delta 7").
4. **Implement.** Make the smallest change that meets the acceptance criteria. Keep diffs surgical, with no drive-by refactors.
5. **Gates** (all green, with the full output read):
   - the narrowest test command for each touched package: `pnpm --filter @memry/sync-server test -- <file>`, `pnpm --filter @memry/desktop test:main -- <file>`, `pnpm --filter @memry/sync-client test -- <file>`, `pnpm --filter @memry/contracts test`, `cargo test -p memry-core <filter>`;
   - then the whole suite of each touched package once;
   - `pnpm lint`, `pnpm typecheck`, `pnpm check:architecture`, `pnpm check:contracts`, `git diff --check`;
   - when contracts, preload or IPC change: `pnpm ipc:generate`, then `pnpm ipc:check`;
   - for Rust: `cargo test -p memry-core` and `cargo clippy -p memry-core -- -D warnings`. If the UniFFI surface changed, regenerate the Swift bindings the way `apps/ios/AGENTS.md` says and build the iOS Unit plan.
6. **Docs.** For protocol changes, update `docs/protocol/*` in the same PR (the issues name the sections). Then run `pnpm docs:impact --base <parent-branch-sha> --strict`. If it reports `missing-docs`, update `apps/docs/src/**` by hand, then run `pnpm docs:build`.
7. **Live lane**, for the PRs marked **live** in the table. Reproduce the bug or show the behavior on a real two-device setup before and after the change: a local sync server (`pnpm dev:sync-server`) and two desktop instances with separate profiles (`MEMRY_DEVICE=a` / `b`), if the desktop can point at the local server. Otherwise use staging with a fresh account (`pnpm staging:user`) and `pnpm deploy:sync:staging` for server changes. Use **staging only, never production**, and log every staging deploy in `tasks.md`. Save log excerpts and DB row counts as evidence (the #2283 comment shows the expected shape). Run the same scenario on `main` and on the PR head.
8. **Commit** in the worktree. Stage explicit paths only. Message format: `{fix,feat,docs,chore}(desktop,sync-server,...): <message>`. No `fixes #`, no Co-authored-by.
9. **PR.** Push the unit branch. Open a ready (not draft) PR with `--base <parent-branch>`; only PR01 targets `main`. The body has:
   - `Closes #<n>` for each issue;
   - a short problem → trace → fix explanation;
   - test evidence and live evidence;
   - a **Rollout** section (deploy order, soak, `minWriteVersion` gates);
   - the AI disclosure required by `CONTRIBUTING.md`.
     Babysit CI to green per `playbooks/babysit.md`. Triage bot comments skeptically.
10. **Verdict.** Swarm-verify the head SHA and record the verdict in the PR as a comment and in `tasks.md`. Only then start the next unit on top of it.

## PR units, in stack order

Each row is one PR on its own branch, stacked on the row above. Validate every listed issue inside its unit. **live** means step 7 is mandatory.

| PR  | Branch                                 | Issues                             | Surfaces                           | Notes                                                                                                                                                                                                                          |
| --- | -------------------------------------- | ---------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 01  | `fix/sync-cursor-skip`                 | #2282 P1.1, #2283 P1.2, #2382 P1.8 | server, desktop                    | **live**. Reproduce #2283 first. Add the §5.5 `maxCursor` MUST NOT sentence. P1.8 flag set only after a clean pull.                                                                                                            |
| 02  | `fix/sync-journal-apply-tx`            | #2284 P1.3                         | desktop                            | Include `property-definition-handler` and the journal delete, per the Review section.                                                                                                                                          |
| 03  | `fix/sync-schema-invalid`              | #2285 P1.4                         | desktop                            | One global cursor; the tracker guarantees the retry.                                                                                                                                                                           |
| 04  | `fix/sync-dirty-recovery-all-types`    | #2286 P1.5                         | desktop, db-schema                 | Descriptor per sync type. Guard test over `RECORD_SYNC_ITEM_TYPES`. Any new column is an additive hand-written migration.                                                                                                      |
| 05  | `fix/sync-settings-device-clock`       | #2287 P1.6                         | sync-client, desktop               | Acceptance is convergence after a round trip. Do **not** change tick-max here.                                                                                                                                                 |
| 06  | `fix/sync-manifest-throttle-log`       | #2310 P1.7                         | desktop                            | Small.                                                                                                                                                                                                                         |
| 07  | `feat/sync-e2e-trace`                  | #2280 P0.1, #2281 P0.2             | server, contracts, desktop, docs   | Origin-side `sync_push_lag_ms` + skew handling per Review. §9.1 rewrite.                                                                                                                                                       |
| 08  | `feat/sync-push-rate-limit-per-device` | #2288 P2.1                         | server                             | Rollout: deploy, then 48 h soak before PR 09's client release.                                                                                                                                                                 |
| 09  | `feat/sync-leading-edge-push`          | #2289 P2.2                         | desktop                            | Same shape for the CRDT flush. Rollout gated on PR 08's soak.                                                                                                                                                                  |
| 10  | `feat/sync-honor-wake-cursor`          | #2290 P2.3                         | desktop, docs                      | **live**. Needs PR 01. §9.11/§5.11 MAY-skip sentence.                                                                                                                                                                          |
| 11  | `fix/sync-ws-contract-parser`          | #2291 P2.4                         | desktop                            |                                                                                                                                                                                                                                |
| 12  | `feat/sync-inline-changes`             | #2292 P2.5                         | server, contracts, desktop, docs   | **live**. architect. Server must answer identical bytes to `/sync/pull`.                                                                                                                                                       |
| 13  | `fix/sync-push-self-heal`              | #2293 P2.6                         | desktop                            | Item 4 as corrected in the Review section.                                                                                                                                                                                     |
| 14  | `feat/sync-slice-cursor-tx`            | #2294 P2.7                         | sync-client, desktop               | **live**. interrogate. Skip only on equal clock **and** identical canonical payload. Keep the §6.5.2 P4 regression test.                                                                                                       |
| 15  | `feat/sync-crdt-server-cursor`         | #2295 P3.1                         | server, contracts, docs            | **live**. Next free D1 migration number, additive, no backfill. Measure median `update_data` size first and record it.                                                                                                         |
| 16  | `fix/sync-crdt-idempotent-store`       | #2296 P3.2                         | server                             | Additive partial unique index.                                                                                                                                                                                                 |
| 17  | `feat/sync-note-body-feed`             | #2297 P3.3 (part a)                | desktop                            | **live**. Negotiate `note_body`, add the body handler with the journal-covered LevelDB write, and run the one-time legacy CRDT sweep for NULL-cursor rows. Covers journals too. Old machinery stays.                           |
| 18  | `refactor/sync-delete-crdt-sweep`      | #2297 P3.3 (part b)                | desktop                            | Delete the sweep, drain, watermarks and unmerged-debt, but keep the one-time legacy sweep from 17. Net deletion. Rollout: same release as 17 or later. The server keeps sending `crdt_updated` until `minWriteVersion` passes. |
| 19  | `feat/sync-crdt-outbox`                | #2298 P3.4                         | desktop, db-schema                 | Append or merge-at-enqueue; never let `enqueue` coalescing overwrite an update. Additive desktop migration.                                                                                                                    |
| 20  | `feat/sync-snapshot-covers-through`    | #2299 P3.5                         | server, contracts, desktop, docs   | interrogate. `coversThrough` excludes tracked-unapplied bodies.                                                                                                                                                                |
| 21  | `feat/sync-tombstone-purge-marker`     | #2302 P4.3                         | server, contracts, desktop, docs   | architect + interrogate. The resurrection rule deletes local data, so it needs the heaviest tests in the stack.                                                                                                                |
| 22  | `chore/sync-server-dead-code`          | #2303 P4.4                         | server                             | `rate_limits` stays. Duplicates are rejected per item, never with a request-level 400.                                                                                                                                         |
| 23  | `fix/sync-settings-merge-spec`         | #2383 P4.6                         | sync-client, crates                | Shared conformance vectors with `settings_merge.rs`.                                                                                                                                                                           |
| 24  | `feat/sync-core-parity`                | #2304 P4.5                         | crates, swift                      | Port P2.3, P2.5, P2.7 (content-equal), P3.3, and P1.8 if applicable. Split into several PRs if one exceeds a reviewable size.                                                                                                  |
| 25  | `feat/sync-transactional-outbox`       | #2301 P4.2                         | domain-tasks, sync-client, desktop | architect. Tasks and projects first.                                                                                                                                                                                           |
| 26  | `feat/sync-ws-fast-path`               | #2300 P4.1                         | server, desktop                    | architect. Never writes `LAST_CURSOR`.                                                                                                                                                                                         |

Gated items. The epic gates P4.1 and P4.2 on production telemetry from P0.1, which this session cannot produce. Implement them last. Mark each PR body with **"Merge gate: `sync_e2e_ms` p50 after phase 2 above ~0.7–1 s"** (P4.1) or **"Merge gate: P1.5 sweep reports residual rows"** (P4.2), and record the gate in Rollout. Kaan decides whether to land them.

If an issue is closed as invalid, drop its row, and restack any child whose parent disappeared onto the nearest remaining ancestor.

## Invariants (from the epic; breaking one is a stop)

- PRODUCTION, backward compatible. No DB resets. D1 and desktop migrations are additive and hand-written; desktop Drizzle snapshots are broken past 0021.
- The protocol changes only additively. Remove no endpoint or field. Never add to `LEGACY_RECORD_SYNC_ITEM_TYPES`. Serve `note_body` only when negotiated. `crdt_updated` keeps flowing. `sequence_num` is assigned forever.
- `LAST_CURSOR` advances only after durable apply, and only from the cursor feed. A device's own push never moves it. A fast path never owns the watermark.
- An equal remote clock with a different payload is applied (§6.5.2 P4).
- A problem with one item gets a per-item rejection, never a request-level 4xx (§5.4).
- The server never sees plaintext. The E2E envelope is untouched.
- Old clients keep syncing during rollout. Every wire change is implemented for desktop TS and for the Rust core (PR 24).

## Git and safety rules

- Work only in `.worktrees/sync-arch`. The main checkout may have other sessions' changes; never touch it.
- Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`, or a force push without `--force-with-lease` after an `ls-remote` check.
- Never merge a PR, never arm auto-merge, never run `deploy:sync:production`, never touch production D1/R2 or `client_policies`. Staging only, logged.
- When `origin/main` moves, rebase the stack bottom-up per autopilot-stack step 7. Re-verify any PR whose patch-id changed.

## Autonomy

- Do not ask Kaan questions. When something is ambiguous, pick the option that preserves data and backward compatibility, log it under Decisions with the reason, and continue.
- If a unit is blocked by something outside this session (missing credentials, staging down, a flaky external service), log it under Blockers with evidence and continue with the next unit that does not depend on it. Return to it later.
- Surface to Kaan only an irreversible action, a real product call no experiment can settle, or a dead end after three distinct attempts.
- Mid-run discoveries: file a new issue under the epic (label `sync-arch-2026-09`, attach it as a sub-issue), add it to `tasks.md`, and include it only if it blocks a unit. Fix unrelated broken tooling in its own small PR.

## Done when

- Every issue in epic #2279 has a Validity-log line and ends in exactly one state:
  - closed as invalid, with an evidence comment; or
  - covered by a PR in the stack that is green in CI, with a swarm verdict comment at its head SHA.
- Every **live** PR has before/after live evidence in its body.
- Every acceptance criterion from every issue maps to a named test or a live-lane result in `tasks.md`.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm check:architecture`, `pnpm check:contracts`, `cargo test -p memry-core` and `pnpm docs:impact --strict` are green at the stack tip.
- `specs/006-sync-architecture/tasks.md` ends with a final report:
  - the stack links, root to tip, with a one-line verdict each;
  - closed-as-invalid issues;
  - every decision;
  - the **Rollout** runbook for Kaan: server deploys first, the 48 h soak between PR 08 and 09, the `minWriteVersion` raise that ends `crdt_updated`, and the merge gates of PRs 25–26;
  - anything left open.
- The epic checklist in #2279 is updated to show each child's PR.
