# Body CRDT Sync E2E Checklist

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify body-only CRDT sync convergence for two desktop devices.

**Architecture:** The test suite should exercise two isolated desktop clients connected to the same sync backend and drive them through offline/online transitions. Coverage is limited to note body CRDT behavior, so every case should assert final body convergence and explicitly avoid title, tags, properties, move/rename, attachments, and delete behavior.

**Tech Stack:** Electron, Playwright, desktop sync runtime, Yjs/CRDT note sync

---

## Scope

- Note body only
- Exclude title changes
- Exclude tags
- Exclude note properties/frontmatter
- Exclude move/rename
- Exclude attachments
- Exclude delete

## Conventions

- `A` = Device A
- `B` = Device B
- `online` = sync available
- `offline` = sync unavailable
- `shared note` = both devices already have the same note

## Phase 0: Harness Readiness

- [x] H1: Launch `A` and `B` as truly separate devices with isolated user data and keychain state.
- [x] H2: Sign `A` and `B` into the same account and point both to the same sync backend.
- [ ] H3: Add deterministic control for `offline -> online -> offline` transitions.
- [ ] H4: Add helpers to create/open a note and assert exact body content on both devices.
- [ ] H5: Add helpers to force sync and wait until both devices return to idle.

### Phase 0A: Minimal Harness Implementation Order

#### H1: Dual-App Isolation

**Likely files:**

- Modify: `apps/desktop/tests/e2e/fixtures.ts`
- Create: `apps/desktop/tests/e2e/fixtures/sync-fixtures.ts`
- Reuse: `apps/desktop/tests/e2e/utils/electron-helpers.ts`

- [x] H1.1: Add a dedicated dual-device Playwright fixture instead of reusing the current single-app fixture.
- [x] H1.2: Launch one Electron app with `MEMRY_DEVICE=A` and a second with `MEMRY_DEVICE=B`.
- [x] H1.3: Give `A` and `B` separate `--user-data-dir` values.
- [x] H1.4: Give `A` and `B` separate test vault paths.
- [x] H1.5: Expose `electronAppA`, `electronAppB`, `pageA`, `pageB`, `vaultPathA`, and `vaultPathB` from the fixture.
- [x] H1.6: Ensure teardown closes both apps and deletes all temp dirs.
- [x] H1.7: Add a smoke test that launches both apps and confirms they do not share local state.

#### H2: Shared Sync Bootstrap

**Likely files:**

- Create: `apps/desktop/tests/e2e/utils/sync-backend.ts`
- Create: `apps/desktop/tests/e2e/fixtures/sync-auth-fixtures.ts`
- Reuse: `tests/sync-harness/src/simulated-server.ts`
- Reuse: `tests/sync-harness/src/test-auth.ts`

- [x] H2.1: Decide the bootstrap strategy: do not drive OTP/OAuth in E2E.
- [x] H2.2: Stand up a local sync backend that the real Electron app can reach over HTTP and WebSocket.
- [x] H2.3: Seed one shared user with two registered devices.
- [x] H2.4: Generate device-specific auth/session material for `A` and `B`.
- [x] H2.5: Preload each app's local session state so sync runtime starts automatically.
- [x] H2.6: Point both apps at the same `SYNC_SERVER_URL`.
- [x] H2.7: Add a smoke test that both devices report sync enabled against the same backend.

#### H3: Deterministic Offline/Online Control

**Likely files:**

- Create: `apps/desktop/tests/e2e/utils/network-control.ts`
- Modify if needed: `apps/desktop/tests/e2e/utils/electron-helpers.ts`

- [ ] H3.1: Choose one control mechanism and keep it simple.
- [ ] H3.2: Preferred path: make the test sync backend start/stop or reject traffic on demand.
- [ ] H3.3: Add `goOffline(A|B|both)` and `goOnline(A|B|both)` helpers.
- [ ] H3.4: Add an assertion helper that waits until the app shows `offline` sync status.
- [ ] H3.5: Add an assertion helper that waits until the app leaves `offline` after reconnect.
- [ ] H3.6: Add a smoke test for `online -> offline -> online` on both devices.

#### H4: Note Body Helpers

**Likely files:**

- Modify: `apps/desktop/tests/e2e/utils/electron-helpers.ts`
- Create if needed: `apps/desktop/tests/e2e/utils/note-sync-helpers.ts`

- [ ] H4.1: Add a helper to create a note with a known title and body.
- [ ] H4.2: Add a helper to open a note by title on either device.
- [ ] H4.3: Add a helper to replace the full body content deterministically.
- [ ] H4.4: Add a helper to append text at a deterministic location.
- [ ] H4.5: Add a helper to read the rendered editor body text from each device.
- [ ] H4.6: Add a helper to assert exact body equality across both devices.
- [ ] H4.7: Add a smoke test proving body text can be written and read reliably on both devices.

#### H5: Force Sync And Idle Waits

**Likely files:**

- Modify: `apps/desktop/tests/e2e/utils/electron-helpers.ts`
- Reuse: existing sync IPC surface

- [ ] H5.1: Add a helper to call sync trigger on a specific device.
- [ ] H5.2: Add a helper to poll sync status on a specific device.
- [ ] H5.3: Add a helper to wait for `syncing -> idle`.
- [ ] H5.4: Add a helper to wait until pending count reaches the expected value.
- [ ] H5.5: Add a helper `syncBothAndWait()` for the common case.
- [ ] H5.6: Add a smoke test where `A` creates online, `B` syncs, and both return to idle.

### Phase 0B: Exit Criteria Before Writing Real CRDT Cases

- [x] X1: Two isolated Electron clients can run in the same Playwright test.
- [ ] X2: Both clients can authenticate into the same sync account without UI auth flows.
- [ ] X3: Offline/online transitions are deterministic in tests.
- [ ] X4: Note body creation, open, edit, read, and equality assertions are stable.
- [ ] X5: Manual sync and idle waits are stable enough to remove arbitrary sleep-based timing.
- [ ] X6: At least one end-to-end smoke case passes before starting `C1`.

## Phase 1: Create Propagation

- [ ] C1: `A offline` creates a note with body, then `A online`, then `B syncs`. Assert `B` gets the note and exact body.
- [ ] C2: `B offline` creates a note with body, then `B online`, then `A syncs`. Assert `A` gets the note and exact body.
- [ ] C3: `A online` creates a note while `B offline`, then `B online`. Assert `B` gets the note and exact body.
- [ ] C4: `B online` creates a note while `A offline`, then `A online`. Assert `A` gets the note and exact body.

## Phase 2: Single-Writer Edit Propagation

- [ ] E1: `A offline` edits an `A-created` shared note, then reconnects. Assert `B` sees the body change.
- [ ] E2: `B offline` edits a `B-created` shared note, then reconnects. Assert `A` sees the body change.
- [ ] E3: `A offline` edits a `B-created` shared note, then reconnects. Assert `B` sees the body change.
- [ ] E4: `B offline` edits an `A-created` shared note, then reconnects. Assert `A` sees the body change.
- [ ] E5: `A online` edits a shared note while `B offline`, then `B online`. Assert `B` sees the body change.
- [ ] E6: `B online` edits a shared note while `A offline`, then `A online`. Assert `A` sees the body change.

## Phase 3: Independent Edits On Different Notes

- [ ] D1: `A offline` edits `noteA` while `B offline` edits `noteB`, then both go online. Assert both notes converge on both devices.
- [ ] D2: `A online` edits `noteA` while `B offline` edits `noteB`, then `B online`. Assert both notes converge.
- [ ] D3: `A offline` edits `noteA` while `B online` edits `noteB`, then `A online`. Assert both notes converge.
- [ ] D4: `A online` and `B online` edit different notes concurrently. Assert both notes converge.

## Phase 4: Concurrent Edits On The Same Note

- [ ] M1: `A offline` and `B offline` edit the same note in different blocks, then reconnect. Assert both edits are preserved.
- [ ] M2: `A offline` and `B offline` edit the same note in the same block at different insertion points, then reconnect. Assert merge is preserved.
- [ ] M3: `A offline` and `B offline` edit the same exact text range, then reconnect. Assert deterministic merged output and no corruption.
- [ ] M4: `A online` and `B offline` edit the same note concurrently. Assert merge is preserved.
- [ ] M5: `A offline` and `B online` edit the same note concurrently. Assert merge is preserved.
- [ ] M6: `A online` and `B online` edit the same note concurrently. Assert merge is preserved.
- [ ] M7: `A` edits `noteB` while `B` also edits `noteB`. Assert merge is preserved.
- [ ] M8: `B` edits `noteA` while `A` also edits `noteA`. Assert merge is preserved.

## Phase 5: Coverage Variants

- [ ] V1: Run all offline/offline merge cases with `A reconnects first`.
- [ ] V2: Run all offline/offline merge cases with `B reconnects first`.
- [ ] V3: Run all offline/offline merge cases with `A and B reconnect together`.
- [ ] V4: Run representative `E*` and `M*` cases with the receiver note already open in the editor.
- [ ] V5: Run representative `E*` and `M*` cases with the receiver note closed, then reopened after sync.
- [ ] V6: Run the cross-edit user scenario: `A` and `B` each create one note offline, both sync, then both cross-edit both notes. Assert `2 notes` and `4 edits` are preserved on both devices.

## Done Criteria

- [ ] No body edit is lost.
- [ ] Both devices converge to identical final body content.
- [ ] No duplicate note creation appears.
- [ ] No corrupted editor state appears.
- [ ] Sync recovers cleanly from offline states without manual repair.
