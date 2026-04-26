# M4 - Crypto + Keychain + Auth / Phase Prompts

Fresh-session prompts for M4. Run one phase per clean session. Do not start the next
phase until the previous phase is committed and verified.

## Worktree

M4 should run after M3 is merged to `main`.

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3
git fetch origin
git worktree add ../spike-tauri-m4 -b m4/crypto-keychain-auth main
cd ../spike-tauri-m4
```

If the branch name is random, rename it before pushing:

```bash
git branch -m m4/crypto-keychain-auth
```

All prompts assume this root:

```text
/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m4
```

## Execution Order

| Phase | Prompt | Task | Plan Tasks | Status |
|-------|--------|------|------------|--------|
| A | `m4-phase-a-crypto-foundation.md` | Crypto/keychain subspike, deps, primitive crypto, KDF, signing | 1-5 | TODO |
| B | `m4-phase-b-keychain-auth-runtime.md` | Keychain abstraction, auth runtime, vault key unlock | 6-8 | TODO |
| C | `m4-phase-c-secrets-redaction-http.md` | Provider secrets, PII redaction, narrow sync auth HTTP client | 9-11 | TODO |
| D | `m4-phase-d-device-account-linking.md` | Device identity, account flows, OTP/setup/refresh, linking | 12-14 | TODO |
| E | `m4-phase-e-command-bindings.md` | Tauri command modules and generated Specta bindings | 15-16 | TODO |
| F | `m4-phase-f-renderer-parity.md` | Renderer real-IPC swap and command parity ledger | 17-18 | TODO |
| G | `m4-phase-g-acceptance-handoff.md` | Final automated/manual verification, build, M5 handoff | 19-22 | TODO |

## Global Rules

1. Worktree root: `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m4`
2. Branch: `m4/crypto-keychain-auth`
3. Source of truth: `docs/superpowers/plans/2026-04-26-m4-crypto-keychain-auth.md`
4. Parent spec: `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md`
5. Read-only unless a phase says otherwise: `apps/desktop/**`, `apps/sync-server/**`, `packages/**`, `docs/superpowers/specs/**`, `docs/superpowers/plans/**`
6. No full M6 sync engine in M4. Only auth, devices, linking, token refresh, and local crypto/auth plumbing.
7. No raw master keys, vault keys, provider keys, access tokens, refresh tokens, setup tokens, recovery phrase, or device secret keys in logs, DB rows, generated bindings, returned structs, or debug strings.
8. Keychain services are fixed: `com.memry.vault` and `com.memry.device`.
9. Tauri command names are snake_case. Preserve Electron channel parity through aliases where needed.
10. Commit format: `m4(<scope>): <description>`.
11. No branding in branch names, commit bodies, or PR descriptions.

## Required Method

Each phase starts by invoking:

- `superpowers:using-superpowers`
- `superpowers:test-driven-development` when the phase writes tests first
- `superpowers:systematic-debugging` if a test or verification failure is not immediately obvious

Use RED-GREEN for every task with an explicit test file in the plan. Confirm the RED failure before implementation, then confirm GREEN before committing.

## Phase Handoff

At the end of every phase, run the smallest full-phase gate:

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m4
git log --oneline -10
git status --short
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy
pnpm --filter @memry/desktop-tauri cargo:test
```

Add TS/bindings checks when the phase touched renderer or generated bindings:

```bash
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri typecheck
pnpm --filter @memry/desktop-tauri test
pnpm --filter @memry/desktop-tauri command:parity
```

Report:

```text
Phase <X> complete.
Tasks covered: <task numbers>
Commits: <count> (<first hash>..<last hash>)
Verification: <commands and result>
Next: Phase <Y> - <prompt filename>
Blockers: <none | list>
```

## Emergency Stop

Stop and report if:

- dryoc or Keychain APIs force a crate deviation not already allowed by the plan.
- a command would return or log raw secret material.
- the renderer expects a shape that conflicts with generated bindings.
- staging/local sync-server auth routes do not match the route contracts.
- a pre-flight phase prerequisite is missing.

Do not guess. Identify root cause, state the smallest fix, then wait if the fix changes scope.
