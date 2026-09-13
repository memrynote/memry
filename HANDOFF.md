# Phase 3 handoff — specs/002-native-foundation-ios

Overwritten each session. Everything below was observed, not reported by a subagent.

## Where the work is

Branch `native-core-phase-3` in `.worktrees/native-core-phase-3`, fast-forwarded with
`origin/main`. Straight to main, no PR, per Kaan's standing instruction for this phase.

## Waves completed

| Wave | Tasks                                                         | State         |
| ---- | ------------------------------------------------------------- | ------------- |
| W1   | T099–T103 storage, migration runner, three baseline SQL files | done, on main |
| W2a  | T105, T106 record envelope + item-type negotiation            | done, on main |
| W2b  | T109–T111 yrs registry, two-namespace update log, lifecycle   | done, on main |
| W3b  | T104 repositories + thirteen per-type projectors              | done, on main |

Ticked this session: T099, T100, T101, T102, T103, T104, T105, T106, T109, T110, T111.

## Waves in flight

None. Nothing is half-applied; the tree is clean.

## The exact next wave to dispatch

**W3a `{T096, T097, T098}`** — runtime host, HTTP client over the `Transport` seam, auth.
It was dispatched once and died before writing a file (see "What went wrong"), and is the
only W3 unit still open. It owns `src/api/{runtime,auth,mod}.rs` and
`src/protocol/{http,auth,mod}.rs`. Do **not** add `reqwest` to `memry-core`: the core owns
no networking, the real transport is T112's in `memry-cli`, and W3a tests against a fake.

After it: **W4 `{T107, T108}`** pull loop + engine state machine, which needs W1+W2+W3.
Then W5 `{T112, T113}`, which is where staging first becomes reachable.

## What went wrong, so it is not repeated

Three subagents dispatched into one worktree at once all died without writing a file.
They each started a cold `cargo` build against the shared `crates/target`, and cargo
serialises on that lock. Two concurrent agents worked fine afterwards. **Cap at two in this
worktree**, and verify a new agent is alive (files appearing, or a `cargo`/`rustc` process)
before assuming it is working.

## Open spec-defect entries

**Zero.** 17 logged, 17 closed. G3's defect-log condition is met as of this session; G5
re-checks it.

## Blocked

- **T089** — blocked on **T232**, added this session. The `crdt-update` vector class pins
  the packed CRDT envelope of chapter 04 §4.11 (160-byte header, signature at offset 96),
  which is encryption rather than CRDT semantics. No Phase 3 task had assigned it. Seven of
  eleven classes pass today; T089 cannot be ticked until T232 lands.
- **T082, T093, T094 (device tier)** — blocked by decision. Kaan chose simulator-only; no
  physical iPhone 15 attached. G3 closes with this named as open, never silently.
- **T114, T115, T137, T139** — staging. Mostly unblocked now, see below.

## Staging, for W5

Kaan supplied credentials this session. They live **outside the repo**, mode 600, and must
never be committed or pasted into a chapter, a commit message or this file:

- `~/.memry/staging/account-email.txt`
- `~/.memry/staging/recovery-phrase.txt` — this is `unlock --recovery-phrase-file`'s argument

Kaan confirmed a staging app exists with a populated vault, which satisfies T115's
desktop-created-note precondition.

Still to check at W5, in this order:

1. `BOOTSTRAP_SESSION_HMAC_KEY` present. Kaan does not know the value and it cannot be read
   from Cloudflare — it is encrypted. **Do not try.** Presence is observable without the
   value: chapter 10 §10.12 says its absence makes `/sync/bootstrap` return **501**. Probe
   the endpoint and read the status. Kaan has authorised **rotating** it on staging if it is
   genuinely absent; tell him before doing it, because rotation invalidates in-flight
   bootstrap sessions.
2. A `client_policies` row for platform `ios` with writes enabled. Readable through the
   Cloudflare MCP.
3. OTP at login: read it from Gmail via the Gmail MCP.

A 501 is a deployment gap, not a client bug. Size timing against the steady-state
arithmetic in §10.6.1 before blaming the client.

## Toolchain — changed this session

`crates/rust-toolchain.toml`, the workspace `rust-version`, both CI jobs and plan.md's
Technical Context moved from **1.89 to 1.98.1**. plan.md had pinned 1.89 and `yrs 0.27.4`
together, which is impossible: yrs uses an `if let` match guard, unstable before 1.95.
Measured — 1.89, 1.91, 1.93, 1.94 fail with E0658; 1.95 and 1.98.1 compile. Kaan chose the
current stable over the 1.95 floor. All three iOS targets are installed on 1.98.1.

If a fresh machine builds red, `rustup toolchain install 1.98.1` with
`aarch64-apple-ios`, `aarch64-apple-ios-sim`, `x86_64-apple-ios`.

## Current gate baseline — re-run and observed at the end of this session

| Gate                                           | Result                                                    |
| ---------------------------------------------- | --------------------------------------------------------- |
| `cargo fmt --all --check`                      | clean                                                     |
| `cargo clippy --all-targets -- -D warnings`    | clean                                                     |
| `cargo test`                                   | 80 passed, 0 failed (66 lib + 7 dryoc_parity + 7 vectors) |
| `node scripts/check-line-ceilings.mjs`         | passed                                                    |
| `pnpm lint`                                    | 1 pre-existing warning, `vault-switcher.tsx:96`           |
| `pnpm typecheck`                               | 19/19                                                     |
| `pnpm test`                                    | 20935 passed, 3 expected fail, 13 skipped                 |
| `pnpm --filter @memry/contracts vectors:check` | 11 classes                                                |
| `pnpm docs:build`                              | complete                                                  |

Anything worse than this is the next session's to fix, not to inherit.

## Vector tier — SC-001

**Seven of eleven classes pass byte for byte**: `crypto-vectors`, `bip39-unlock`,
`cbor-canonical`, `compression`, `record-envelope` (all 14 cases), `payload-schemas`
(the subscribed-type header and all 52 payload cases).

Remaining four: `crdt-update` (needs T232), `field-merge` (needs chapter 06's `mergeFields`,
due in W4), `pack-container`, `device-linking`, `text-extract` (T123).

## Gate exit status

- **G3** — defect log at zero ✅; cargo fmt/clippy/test and line ceilings green ✅; vector
  tier **not** green across all eleven ❌ (seven of eleven). Device-tier item recorded as
  BLOCKED, not passed ✅. G3 is not closed.
- **G4** — not started. Needs W5.
- **G5** — not started.
