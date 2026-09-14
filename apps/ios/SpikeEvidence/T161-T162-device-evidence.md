# T161 / T162 — device evidence for User Story 3

**Date**: 2026-09-14. **Hardware**: iPhone 12 Pro (`iPhone13,3`), arm64, iOS 27.0,
identifier `8025C79A-F257-500F-8BA1-A14122135B2D`. **Server**: staging
(`https://sync-staging.memrynote.com`) — prod was never reachable from this
build, and the resolver refuses `production` on a debug build by construction.

**Account**: the real staging account, **four vaults**. Note counts confirmed
independently with the `memry` CLI before any claim was made about the phone:

| Vault                                  | Notes  |
| -------------------------------------- | ------ |
| `692184c5-c51c-48b4-9fba-0771ed37e34e` | **94** |
| `201e9e92-7fec-4c6d-9feb-e4a65b0a1ede` | 0      |
| `329c33a9-166b-4ac0-80a3-1b258ac1abc3` | 0      |
| `46c45221-a14a-4393-86e3-3600190bb037` | 0      |

**That check matters and was not a formality.** When the phone showed three
vaults as empty the honest reading was ambiguous — genuinely empty, or three
silent sync failures. A second, independent client was used to settle it rather
than assuming. Three of the four vaults are empty on the server, so the phone
was right.

## T161 — the Independent Test, as replaced

The specification's Independent Test says "unlock a second phone by scanning the
desktop's code". **Only one phone exists.** Per the Scope decisions block at the
top of Phase 4, that bar was **replaced, not reinterpreted**, and this evidence
states plainly what the replacement does and does not prove.

### Round 1 — unlock by recovery phrase

All **four** vaults opened on the phone and their contents read. The vault
holding 94 notes listed and rendered them; the three empty vaults showed an
empty state, which matches the server.

### Clearing the device

The app was **deleted from the phone**, which removes the container and the
keychain items with it. After this the device held **no vault, no keys and no
device registration**.

### Round 2 — unlock by scanning the desktop's code

On the cleared phone: signed in, then linked to the desktop
(`pnpm --filter @memry/desktop dev:a:staging`, i.e. the desktop was on staging
too). The six-digit SAS code appeared on **both** screens and matched; the
desktop approved; all **four** vaults opened and the 94-note vault's content
pulled and rendered.

**The camera path worked.** The QR was read by the camera and the link
proceeded. This is worth recording because spec-defect 130 — the `CodeCapture`
seam exposes no viewfinder, so aiming is blind — predicted this would be
awkward, and it was not fatal. The paste path also worked and is what the
wiring tests drive.

### The account holding two vaults

The account used holds **four** vaults, and all four were opened in both rounds,
so the "repeat on an account holding two vaults" requirement is satisfied by a
stronger case.

## What this evidence does NOT cover — stated explicitly

- **Two phones registered against one account at once was not covered.** There
  is one phone. This is the bar that was replaced; nothing here tests
  multi-device concurrency, and "second phone" in the original wording must not
  be read as covered.
- **Writes were not exercised.** T156a is cut: the phone has no create, rename,
  move or delete. This is a read-only companion and the evidence is read-only.
- **Bodies older than the first-sync window** arrive as metadata without text
  (chapter 10 §10.6.1) and are fetched on demand. The on-demand fetch was
  exercised; a systematic sweep of older notes was not.
- **Revocation across a relaunch was not exercised** (spec-defect 132: the
  reason does not survive a relaunch).

## T162 — test plans re-run against the final build

Both re-run on the physical device against the build these rounds used. The
earlier banked numbers were **not** reused.

| Plan          | Result                                         |
| ------------- | ---------------------------------------------- |
| `Conformance` | **12 total, 12 passed, 0 failed, 0 skipped**   |
| `Unit`        | **355 total, 351 passed, 0 failed, 4 skipped** |

Extracted summaries are committed beside this file as
`device-Conformance-summary.json` and `device-Unit-summary.json`; the
`.xcresult` bundles are gitignored.

**The 4 skips are correct and differ from the simulator's 2.** On a device the
two device-gated tests run (and pass), while simulator-gated ones skip — the
counts moving in that direction is the evidence that the gating is real rather
than decorative.

**A spoiled pair of runs is recorded rather than hidden.** The first attempt at
both plans returned `1 total, 0 passed, 1 failed` — the app-launch failure
shape — because the orchestrator started them at the same time as the manual
"delete the app" step. One phone, two consumers, no lock. They were re-run
cleanly and only the clean numbers are above.

## Bugs this round found that no test could

Three, and all three were found by a person using the phone:

1. **Spec-defect 136** — the vault could be opened and read but **nothing could
   fill it**. Every test built the store it then read, so the gap was invisible;
   the screen _before_ it worked, because the vault list is a network read and
   the note list is a local one. Fixed by T236/T237 and confirmed on the device.
2. **Spec-defect 140** — `POST /auth/linking/scan` requires eight fields and the
   core sent six. `packages/contracts`' exported schema declares only six and is
   **still wrong**; chapter 03 §3.1 writes out no request body at all. Fixed in
   the core by T238 and confirmed by a successful link.
3. **Spec-defect 109, in practice** — repeated sign-ins exhausted the per-IP OTP
   limit (10 per 3600 s). The core's ladder honours the server's `Retry-After`
   with no ceiling and the call cannot be cancelled, so the screen shows
   "sending your code" and waits, silently, for up to an hour. **Capping the
   honoured delay is a core change and a decision for Kaan, not a task** — but
   it is no longer theoretical.

**Spec-defect 139 is what made 140 expensive.** Every linking refusal — an
expired session, a wrong secret, a malformed body — renders as the same
sentence. Six rounds went into finding a `400 VALIDATION_ERROR` that the screen
could have named.
