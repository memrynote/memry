# M6 Phase M - Runtime E2E + Staging Smoke

Fresh session prompt. This phase proves the real runtime path with two devices,
offline restart drain, attachments, and WebSocket reliability.

---

## PROMPT START

You are implementing **Phase M of Milestone M6**. This phase executes Chunk 13 from
`docs/superpowers/plans/2026-04-27-m6-sync-engine.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6`
**Branch:** `m6/sync-engine`
**Plan:** `docs/superpowers/plans/2026-04-27-m6-sync-engine.md`
**Previous phase:** `prompts/m6/m6-phase-l-sync-ops-renderer-wiring.md`

Phase M adds runtime/staging scenarios. It should not change command behavior except
for narrow testability fixes discovered by runtime evidence.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6
git status --short --branch
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri capability:check
pnpm --filter @memry/desktop-tauri command:parity
pnpm --filter @memry/desktop-tauri test:e2e:runtime -- --list
```

If command/binding/capability checks fail, STOP and return to Phase L. If local macOS
runtime e2e lists but cannot execute because of WebDriver backend limits, record the
skip and use CI/staging evidence.

### Your Scope

Execute Chunk 13 in order:

- **Step 1:** Add list-only check for new scenarios.
- **Step 2:** Implement two-device note round-trip.
- **Step 3:** Implement offline restart drain.
- **Step 4:** Implement attachment smoke.
- **Step 5:** Run WebSocket reliability stress where available.
- **Step 6:** Run runtime e2e where supported.
- **Step 7:** Run staging smoke manually if CI cannot provision sync-server.

### Required Reads

Read these before editing:

- `AGENTS.md`
- `CLAUDE.md`
- `apps/desktop-tauri/e2e/runtime/run-runtime-e2e.ts`
- `apps/desktop-tauri/e2e/runtime/helpers/driver.ts`
- `apps/desktop-tauri/e2e/runtime/helpers/vault.ts`
- `apps/desktop-tauri/e2e/runtime/specs/*`
- `docs/superpowers/plans/2026-04-27-m6-sync-engine.md` Chunk 13

### Methodology

1. Invoke `superpowers:using-superpowers`, `superpowers:test-driven-development`,
   `superpowers:systematic-debugging`, and `superpowers:verification-before-completion`.
2. Keep runtime lane additive. Do not weaken or skip existing runtime scenarios.
3. Two-device scenario:
   - launch device A and B with separate `MEMRY_DEVICE`.
   - authenticate both against staging/test sync-server.
   - create/edit note on A.
   - B receives WS notification and note appears in under 3 seconds.
4. Offline restart scenario:
   - make local task or supported record edit offline.
   - quit app.
   - relaunch with network restored.
   - queue drains exactly once and remote has one mutation.
5. Attachment scenario:
   - upload small file from note editor.
   - observe progress.
   - restart second device.
   - download into vault attachments folder.
6. WS stress loop where available:
   - toggle network or block/unblock sync-server route.
   - verify bounded reconnect.
   - verify queue drains after reconnect.
   - verify no duplicate record pushes.
   - verify no duplicate CRDT application.
7. If CI cannot provision sync-server, run manual staging smoke and record server URL,
   account, timing, attachment size, and observed failures.

### Acceptance Criteria

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6

pnpm --filter @memry/desktop-tauri test:e2e:runtime -- --list
pnpm --filter @memry/desktop-tauri test:e2e:runtime
```

Expected: PASS on supported CI platform, or a documented local macOS skip plus CI or
manual staging evidence.

### When Done

Report:

```text
Phase M complete.
Plan chunk: 13
Commits: <count> (<first hash>..<last hash>)
Runtime evidence: <list + run result or macOS skip with CI/manual proof>
Staging smoke: <server/account/timing/attachment size/failures>
Next: Phase N - prompts/m6/m6-phase-n-capability-binding-parity.md
Blockers: <none | list>
```

## PROMPT END
