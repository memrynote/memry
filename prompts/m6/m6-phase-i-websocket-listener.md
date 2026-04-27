# M6 Phase I - WebSocket Listener

Fresh session prompt. This phase adds the `/sync/ws` listener and reconnect policy that
keeps the engine responsive after remote changes.

---

## PROMPT START

You are implementing **Phase I of Milestone M6**. This phase executes Chunk 9 from
`docs/superpowers/plans/2026-04-27-m6-sync-engine.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6`
**Branch:** `m6/sync-engine`
**Plan:** `docs/superpowers/plans/2026-04-27-m6-sync-engine.md`
**Previous phase:** `prompts/m6/m6-phase-h-engine-runtime.md`

Phase I uses `tokio-tungstenite` to listen for sync-server notifications. The engine
decides when the socket should exist; `stop` must cancel reconnect sleeps and close the
socket.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6
git status --short --branch
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_engine_test
pnpm --filter @memry/desktop-tauri cargo:check
```

If any command fails, STOP and report.

### Your Scope

Execute Chunk 9 in order:

- **Step 1:** Write WebSocket tests.
- **Step 2:** Add Cargo test entry.
- **Step 3:** Implement `WebSocketManager`.
- **Step 4:** Integrate with engine.
- **Step 5:** Run focused gate.

### Required Reads

Read these before editing:

- `AGENTS.md`
- `CLAUDE.md`
- `apps/sync-server/src/durable-objects/user-sync-state.ts`
- `apps/desktop-tauri/src-tauri/src/sync/engine.rs`
- `apps/desktop-tauri/src-tauri/src/sync/client.rs`
- `apps/desktop-tauri/src-tauri/src/sync/session.rs`
- `apps/desktop-tauri/src-tauri/src/sync/pinning.rs`
- `docs/superpowers/plans/2026-04-27-m6-sync-engine.md` Chunk 9

### Methodology

1. Invoke `superpowers:using-superpowers`, `superpowers:test-driven-development`, and
   `superpowers:verification-before-completion`.
2. Write tests first and confirm RED:
   - connects to `/sync/ws` with bearer token and `X-App-Version`.
   - `changes_available` schedules record pull.
   - `crdt_updated` schedules CRDT pull for the note.
   - heartbeat timeout reconnects.
   - first acceptance-mode retry caps under 5 seconds.
   - cert pin failure emits `certificate-pin-failed` and stops reconnect.
3. Implement typed conservative message parsing. Unknown messages should not crash the
   listener.
4. Map close codes to `WsCloseReason`:
   - `4001` -> `Replaced`: log and do not reconnect immediately.
   - `4003` -> `TokenExpired`: emit `auth-session-expired`, clear tokens, stop until
     re-authenticated.
   - `4004` -> `DeviceRevoked`: emit `device-revoked`, stop permanently for session.
   - `4008` -> `RateLimited(Option<u64>)`: honor retry-after or standard backoff.
   - `4009` -> `VersionIncompatible(String)`: emit `security-warning` with minVersion,
     stop until app update.
   - other abnormal close -> standard backoff and `sync-error`.
5. Integrate with engine ownership. The engine starts the listener after full sync and
   stops it on `stop`.
6. Reconnect sleeps must be cancellable. Do not leave detached tasks running after stop.

### Acceptance Criteria

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6

pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_ws_test
```

Expected: PASS.

### When Done

Report:

```text
Phase I complete.
Plan chunk: 9
Commits: <count> (<first hash>..<last hash>)
Verification: sync_ws_test
Next: Phase J - prompts/m6/m6-phase-j-crdt-network-sync.md
Blockers: <none | list>
```

## PROMPT END
