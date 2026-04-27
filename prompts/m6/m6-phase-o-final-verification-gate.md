# M6 Phase O - Final Verification Gate

Fresh session prompt. This phase closes M6 with the full automated gate, runtime/staging
acceptance, and PR ledger. It adds no planned feature work.

---

## PROMPT START

You are implementing **Phase O of Milestone M6**. This phase executes Chunk 15 from
`docs/superpowers/plans/2026-04-27-m6-sync-engine.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6`
**Branch:** `m6/sync-engine`
**Plan:** `docs/superpowers/plans/2026-04-27-m6-sync-engine.md`
**Previous phase:** `prompts/m6/m6-phase-n-capability-binding-parity.md`

All implementation phases should be complete. Phase O verifies, fixes only real
verification issues, and records the M6 PR ledger.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6
git status --short --branch
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri capability:check
pnpm --filter @memry/desktop-tauri command:parity
```

If implementation is incomplete, STOP and return to the missing phase.

### Your Scope

Execute Chunk 15 in order:

- **Step 1:** Rust full gate.
- **Step 2:** Renderer and contract gate.
- **Step 3:** Generated artifact gate.
- **Step 4:** Runtime/staging gate.
- **Step 5:** PR body ledger.

### Required Reads

Read these before editing:

- `AGENTS.md`
- `CLAUDE.md`
- `prompts/m6/README.md`
- `docs/superpowers/plans/2026-04-27-m6-sync-engine.md`
- `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md`

### Methodology

1. Invoke `superpowers:using-superpowers`, `superpowers:systematic-debugging` for
   non-obvious failures, and `superpowers:verification-before-completion`.
2. Do not add new feature scope in this phase.
3. If a check fails, make the smallest fix, rerun the failing check, then rerun the
   relevant full gate.
4. Do not hide macOS runtime e2e skips. Record skip text and CI/staging substitute
   evidence.
5. Commit fixes with narrow messages. Commit PR ledger/docs only if source docs
   actually changed.

### Automated Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6

pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy -- -D warnings
pnpm --filter @memry/desktop-tauri cargo:test

pnpm --filter @memry/desktop-tauri typecheck
pnpm --filter @memry/desktop-tauri test
pnpm --filter @memry/desktop-tauri test:e2e -- --project=webkit
pnpm --filter @memry/contracts typecheck

pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri capability:check
pnpm --filter @memry/desktop-tauri command:parity

pnpm --filter @memry/desktop-tauri test:e2e:runtime
```

Expected: all pass before M6 is considered complete. `test:e2e:runtime` may be a
documented macOS skip only if CI or manual staging evidence covers the runtime cases.

### Manual/Staging Acceptance

Record evidence for:

- 2-device note edit propagates in under 3 seconds through WS notification.
- concurrent task edits on different fields preserve both fields.
- WS drop reconnects and drains queue within 5 seconds.
- offline edit -> app restart -> reconnect drains queue exactly once.
- sign-out/sign-in preserves CRDT docs and resumes sync.
- modified cert/pin fails closed and emits `certificate-pin-failed`.
- attachment upload/download works against R2 blob API.

### PR Body Ledger

Include:

```markdown
## M6 Sync Engine Ledger

- Commands graduated: <sync_ops_*, sync_*, notes attachment, sync attachment list>
- Events emitted/tested: <sync-status-changed, sync-progress, ...>
- Handler coverage: 13 RECORD_SYNC_ITEM_TYPES, no extras
- Mock retirement: <sync_status kept real, sync_trigger retired, etc.>
- Remaining deferrals: <M7/M8/M9 item + reason>
- Local verification: <exact commands + PASS/skip>
- Runtime/staging evidence: <two-device, offline restart, attachment, WS stress>
- Cert pinning implementation: <dependency/features/result>
- macOS runtime e2e skip: <none | exact skip + CI/manual substitute>
- Known warnings carried forward: <none | exact warning, owner milestone, reason>
```

### When Done

Report:

```text
Phase O complete.
Plan chunk: 15
Commits: <count> (<first hash>..<last hash>)
Automated verification: <all commands and result>
Runtime/staging verification: <result or documented skip + substitute evidence>
PR ledger: <recorded | not changed, reason>
Blockers: <none | list>
```

## PROMPT END
