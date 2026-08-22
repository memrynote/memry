# Quickstart: Validating Memry Mobile Phase Gates

**Feature**: 001-mobile-app | **Plan**: [plan.md](./plan.md)

Runbook for proving each release-train gate with evidence. Commands are the
contract: a gate is green when its commands/measurements pass, not before
(Constitution III: no check-off without exact green evidence).

## Prerequisites

- macOS with Xcode (iOS 17+ SDK), a **physical mid-tier iPhone** as the pinned
  reference device, Apple Developer account for dev-client signing.
  - **Reference device: `______` — fill in the exact model here before G0**
    (target class: iPhone SE 3 / iPhone 13 tier). Every performance gate
    (G0-d, G2, G3, T127) is measured on this exact model, release build;
    simulator numbers never count. Changing the device invalidates prior
    measurements — re-run them.
- `pnpm install` at repo root; desktop dev environment already working.
- A **staging** sync account + a desktop-created staging vault seeded with:
  ≥ 1 note per block type, a 50 KB note, all 12 item types, ≥ 1 attachment.
  Never point spike builds at production.
- Phase 5 only: App Store Connect sandbox tester account.

## Phase 0 — G0

```bash
# scaffold boots (T0.1)
pnpm --filter @memry/mobile ios          # dev client on the physical device

# boundary rule (T0.2) — red/green proof
pnpm check:architecture                  # green
# plant `import fs from 'node:fs'` in apps/mobile, expect red, revert

# CI (T0.3)
# mobile-ci.yml green on the scaffold PR; root pipelines untouched

# crypto vectors (T0.4) — desktop side
pnpm --filter @memry/contracts test -- test-vectors   # or the suite location chosen in T0.4
git status packages/contracts/test-vectors/crypto-vectors.json   # committed

# R1 on-device parity (T0.5): run the device harness; expected output
#   PARITY OK <n>/<n> vectors   (any mismatch = R1 FAIL — stop, fallback ladder research.md §R1)

# R2 benchmark (T0.6): run bench app on device; fill the table in research.md §R2;
#   thresholds there decide the driver

# R3 (T0.7)
pnpm --filter @memry/mobile ios          # bundles workspace TS imports cleanly
pnpm dev                                 # desktop still starts (no hoisting regression)

# R4 (T0.8): bridge rig; expected output: p95 round-trip + frames/envelope counters
#   within research.md §R4 thresholds

# Gate demo (T0.9)
# device: sign in (staging) → pull the target note → decrypt → print SHA-256
# desktop: shasum -a 256 over the same note's raw markdown bytes
# hashes MUST be equal
```

**Evidence bundle**: CI run links, device video/screenshot of parity output,
benchmark table, both hashes side by side. Attach to the Phase 0 issue.

## Phase 1 — G1

```bash
# on the extraction branch, all green:
pnpm lint && pnpm typecheck && pnpm test && pnpm test:desktop
pnpm check:architecture && pnpm check:contracts
pnpm ipc:check
# targeted desktop E2E smoke (sync push/pull, offline reconnect, CRDT merge) — not the full suite
pnpm docs:impact --base origin/main --strict   # docs gate for desktop/sync changes

# exclusion removal (T1.9), after extraction lands:
pnpm typecheck && pnpm test              # root filters now INCLUDE apps/mobile, still green
```

Behaviour-unchanged check: extraction PRs show import-path/mechanical diffs;
any assertion change is called out and justified in the PR body.

## Phase 2 — G2

- **< 5 s visibility**: scripted 20-trial run — desktop writes (10 body edits,
  10 metadata changes), phone timestamps first visibility; report median + p95.
  Repeat in the reverse direction once mobile writes exist (Phase 3).
- **Kill-switch drill** (staging): set `client_policies.ios.writes_enabled=0` →
  device shows explicit read-only without restart, reads work, outbox parked;
  re-enable → outbox drains. Screen-record the drill.
- **Version-gate drill**: set `min_write_version` above the installed build →
  writes rejected with `CLIENT_UPGRADE_REQUIRED`, same read-only UX.
- **Attribution**: query staging D1 — every mobile write row carries
  `client_platform='ios'` + version; desktop rows NULL.
- **SC-004 first-sync measurement**: on a 10,000-item staging vault over Wi-Fi,
  from vault unlock: recent content browsable within 2 minutes (timestamped
  screen recording); app open never blocks on network afterwards (relaunch in
  airplane mode as the check).

## Phase 3 — G3

- **Offline matrix** (≥ 20 scripted runs, 100% pass): airplane mode → edit
  existing + create new note → force-quit → relaunch → verify local persistence →
  reconnect → verify complete sync on desktop.
- **Convergence**: same note edited concurrently on both shells → both change
  sets present after sync, on both shells.
- **< 50 ms keystroke p95** on the 50 KB staging note on the reference device
  (instrumented build; method fixed in R4).
- **Batching proof**: bridge counters from the same session — zero
  per-keystroke envelopes.
- Only after all four + kill switch verified live: open internal TestFlight
  ring (5–10 users, real vaults).

## Phase 4 — G4

Per-type audit on a real production-format vault (checklist of 12); FTS
phrase search in airplane mode across notes/tasks/journal/inbox; reminder fires
with app closed (device screen recording + timestamp ≤ 1 min of schedule);
canvas hash identical before/after viewing.

## Phase 5 — G5

Sandbox purchase → entitlement active ≤ 1 min (no manual steps); ASSN V2
sandbox notification mutates `apple_transactions` + recomputed entitlement;
Paddle+Apple double-active simulation → notice on next open; compliance
artifacts (`ITSAppUsesNonExemptEncryption`, `PrivacyInfo.xcprivacy`, privacy
labels) present in the build; in-app account deletion completes against staging.

## Phase 6 — G6

Archive validates in App Store Connect (0 errors); external TestFlight
approved; accessibility audit (WCAG AA contrast, VoiceOver labels on all
interactive elements, Reduce Motion honored, RTL locale walk-through);
G2/G3 numbers re-measured on the release build.

## References

- Entities & migrations: [data-model.md](./data-model.md)
- Adapter seams: [contracts/platform-adapters.md](./contracts/platform-adapters.md)
- Bridge protocol: [contracts/webview-bridge.md](./contracts/webview-bridge.md)
- Server behaviour: [contracts/sync-protocol-additions.md](./contracts/sync-protocol-additions.md)
- Spike specs & thresholds: [research.md](./research.md)
