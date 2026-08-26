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
# prompts at each transition:
pnpm --filter @memry/mobile test:offline-matrix -- --runs 20
# or script the cut (host firewall rule, network conditioner profile, …):
pnpm --filter @memry/mobile test:offline-matrix -- --runs 20 \
  --offline-cmd '<take the device offline>' --online-cmd '<put it back>'
```

The cut is **not** automated by default. `simctl status_bar --dataNetwork hide`
only repaints the status bar; the simulator stays online, so a run driven by it
would do all of its "offline" work with a working network. The offline flow
asserts the app's own Offline banner for the same reason — a pass cannot
quietly have run online.

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
