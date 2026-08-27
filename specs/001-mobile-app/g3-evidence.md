# G3 evidence bundle — US2, Edit Notes Anywhere, Offline First

**Gate**: quickstart.md §Phase 3 · **Tasks**: T057–T077 · **Status**: _pending device run_

Four artefacts gate G3, plus a live kill-switch check. Code and automation for all
four are in the tree; three of them can only be _produced_ on the reference
device, so this file is the bundle's shape and the recipe for filling it — not a
claim that it has been filled.

Do not mark T077 `[x]` until every row below has real evidence attached.
Half-green is how a gate stops meaning anything.

---

## Code gates (reproducible anywhere)

| Check                                                                  | Command                                                                               | Status |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------ |
| Push/pull crypto round-trip (record, CRDT, manifest)                   | `pnpm --filter @memry/sync-client exec vitest run src/push/roundtrip.test.ts`         | ✅ 9/9 |
| Durability rule (persist before ack, both halves, process death)       | `pnpm --filter @memry/mobile exec vitest run src/editor/__tests__/durability.test.ts` | ✅ 7/7 |
| Convergence seams (a) concurrent (b) delete-vs-edit (c) unknown fields | `pnpm --filter @memry/mobile exec vitest run src/sync/__tests__/convergence.test.ts`  | ✅ 4/4 |
| Editor asset freshness (bridge drift gate)                             | `pnpm --filter @memry/mobile editor:check`                                            | ✅     |
| Mobile typecheck + WebView bundle typecheck                            | `pnpm --filter @memry/mobile typecheck && pnpm --filter @memry/editor-web typecheck`  | ✅     |

## Device gates (reference device, RELEASE build)

Debug messaging is drastically slower than release in `react-native-webview`;
a debug measurement is not evidence, it is a different number.

### 1. Offline matrix — ≥ 20 runs, 100 %

```bash
# simulator — fully unattended:
pnpm --filter @memry/mobile test:offline-matrix -- --runs 20
# real hardware (prompts for the airplane-mode toggle):
pnpm --filter @memry/mobile test:offline-matrix -- --runs 20 --device
```

The cut comes from the APP, not from `simctl`: `status_bar --dataNetwork hide`
only repaints the status bar and leaves the simulator fully online, so a run
driven by it would do all of its "offline" work with a working network. A
dev-build-only switch, backed by a marker file the driver writes straight into
the app's document container, makes the HTTP adapter report offline and reject
every request instead — it cannot make the app behave BETTER than airplane
mode, which is the property a gate needs, and it survives the force-quit the
scenario depends on. The offline flow also asserts the app's own Offline
banner, so a pass cannot quietly have run online.

### What has been verified on this machine, and what has not

Verified on the iPhone 17e simulator (2026-08-27):

- The app **builds, installs, bundles and boots** — `expo run:ios` succeeded,
  Metro bundled 1984 modules, libsodium loaded, the router came up. That is the
  gate the 1 MB gzipped editor asset had not passed before.
- The account session is already in the keychain, so the app comes up on
  **Unlock your vault**.

**Not verified, and not verifiable without you:** everything past unlock. The
24-word recovery phrase is the only key to the vault and it is yours alone, so
the offline matrix, the latency measurement and the kill-switch drill all wait
on it. Once the vault is unlocked once, the session and key persist and the 20
runs are unattended.

Attach: the driver's `20/20 passed` line, plus one screen recording of a single
pass showing airplane mode → edit + create → force-quit → relaunch (edits present
with no network) → reconnect → the note on desktop.

- [ ] 20/20
- [ ] recording

### 2. Convergence on real devices

The suite above proves it over the shipped code paths with an in-memory relay.
G3 additionally wants it on hardware against staging:

1. Open the same note on desktop and phone.
2. Edit both within a few seconds of each other, phone offline for one of them.
3. Reconnect. Both change sets must be present **on both shells**.
4. Repeat with the delete-vs-edit case: delete on desktop while editing on the
   phone. Both shells must agree the note is gone; the phone must not resurrect it.

- [ ] both change sets present, both shells
- [ ] delete-vs-edit identical on both shells

### 3. Keystroke latency — end-to-end p95 < 50 ms

Instrumentation: `apps/mobile/src/editor/__rig__/latency.ts`, surfaced in the
note screen's Info panel ("Bridge metrics") in dev builds.

What the number means, so it is not misread: the WebView renders its own
keystroke locally, so the bridge is off the critical render path. The budget
gates the **end-to-end echo** — keystroke → RN-owned doc → durable in SQLite —
which is the part that can actually lose work.

1. Open the 50 KB staging note on the reference device, release build.
2. Tap **Reset metrics**.
3. Type continuously for ≥ 60 s (real typing, not a scripted burst — see below).
4. Tap **Bridge metrics** and capture the report.

- [ ] `end-to-end p95 < 50 ms`
- [ ] report captured

### 4. Batching proof — zero per-keystroke envelopes

Same report, same session. `msgs/envelope` must exceed 1.00.

G0-d could not prove this and said so: at 10 keystrokes/s a 24 ms flush window
never coalesces, which is arithmetic, not a defect. Real editing produces Yjs
update clusters that arrive faster than `T_flush`, which is why the proof was
deferred to here. If `msgs/envelope` is still 1.00 under real typing, the
batching claim is **unproven** and G3 does not pass on a hand-wave.

- [ ] `msgs/envelope > 1.00`
- [ ] `seq gaps: 0`

### 5. Kill switch verified live (precondition, not a formality)

The write path ships behind it, so it is checked _before_ the ring opens, not
after. On staging: flip `client_policies.ios.writes_enabled=0`, confirm the
device goes read-only on a single background→foreground with no restart, confirm
the outbox is **parked and still full**, re-enable, confirm it drains.

- [ ] read-only without restart
- [ ] outbox parked, nothing dropped
- [ ] drains on re-enable

---

## Then, and only then

Open the internal TestFlight ring — 5–10 users, real vaults.

- [ ] ring opened, date: ______
