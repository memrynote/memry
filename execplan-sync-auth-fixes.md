# Repair sync auth recovery, tokens, and session refresh

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This plan must be maintained in accordance with `.agent/PLANS.md` in the repository root.

## Purpose / Big Picture

Users should be able to sign up, verify, and log in with a recovery phrase that always matches the phrase used to derive their master key, and they should be able to keep syncing as access tokens expire. After these changes, a user who signs up sees the exact phrase stored in the main process, a new-device login can fetch recovery data by user ID or email, returning-device login persists fresh tokens, and any expired session attempts refresh before notifying the UI that re-authentication is required. A developer can observe the fixes by running the auth flow in the Setup Wizard and by seeing token refresh attempts succeed or emit a session-expired event.

## Progress

- [x] (2026-01-17 00:00Z) Capture current auth/recovery flows and decide the exact changes for recovery phrase handoff.
- [x] (2026-01-17 00:00Z) Update IPC and renderer to use the main-generated recovery phrase for signup verification.
- [x] (2026-01-17 00:00Z) Fix recovery lookup on the sync server to accept user IDs or emails.
- [x] (2026-01-17 00:00Z) Persist tokens on all login paths and include token presence in setup status.
- [x] (2026-01-17 00:00Z) Add access-token refresh handling plus session-expired emission in the sync API client.
- [ ] (2026-01-17 00:00Z) Validate the flows manually and update acceptance evidence.

## Surprises & Discoveries

- Observation: The sync server recovery endpoint claims to accept IDs or emails, but it only queried by email; this was corrected to try ID first.

## Decision Log

- Decision: Use the recovery phrase generated in `src/main/ipc/sync-handlers.ts` and return it through the signup/verification IPC responses instead of generating a new phrase in the renderer.
  Rationale: The main process already stores the phrase in keychain-backed pending signup state, so the UI must display that exact value to keep key derivation consistent.
  Date/Author: 2026-01-17 (assistant)

- Decision: Implement token refresh inside `src/main/sync/api-client.ts` and emit `sync:session-expired` from there.
  Rationale: All main-process sync calls flow through the API client, so it is the narrowest place to retry 401s and broadcast expiry once refresh fails.
  Date/Author: 2026-01-17 (assistant)

## Outcomes & Retrospective

Not complete yet.

Change note: Marked progress updates after implementing recovery phrase handoff, recovery lookup fix, token persistence, setup status `hasTokens`, and refresh handling.

## Context and Orientation

The sync and authentication IPC handlers live in `src/main/ipc/sync-handlers.ts` and return responses to the renderer through preload APIs defined in `src/preload/index.ts` and `src/preload/index.d.ts`. The Setup Wizard UI for signup and login is in `src/renderer/src/pages/settings/setup-wizard.tsx` and consumes auth state from `src/renderer/src/contexts/auth-context.tsx` and `src/renderer/src/hooks/use-auth.ts`. The sync server endpoint for recovery data is in `sync-server/src/routes/auth.ts` and currently queries users by email only. The sync API client that all main-process network calls use is `src/main/sync/api-client.ts`. The setup status returned to the renderer is defined in `src/shared/contracts/ipc-sync.ts` and mirrored in `src/preload/index.d.ts`.

In this codebase, the “recovery phrase” is a 24-word BIP39 mnemonic used to derive the master key. The “setup status” is the main-process view of whether a user, device, master key, and (after this change) tokens are present in keychain storage. A “session expired” event is the sync IPC event `sync:session-expired` emitted from the main process and consumed in the renderer to prompt re-authentication.

## Plan of Work

First, align the recovery phrase so the renderer always displays the phrase generated and stored in the main process. Update the email signup and email verification IPC responses to include the stored phrase, then update renderer auth types and the Setup Wizard to use that phrase instead of generating a new one.

Next, fix recovery data lookup on the sync server by fetching users by ID first and falling back to email. This will make the same `/auth/recovery` endpoint work for both user IDs and emails.

Then, ensure login always persists tokens by storing access and refresh tokens on both branches of the email login handler, and update setup status to require tokens. Extend the SetupStatus interface to include a `hasTokens` flag and incorporate it into the `isSetup` calculation.

Finally, add refresh-on-401 handling in the sync API client. When a request fails with 401/403 and an access token was supplied, attempt to refresh using the stored refresh token, retry the request with the new access token, and emit a `sync:session-expired` event if refresh is impossible or fails.

## Concrete Steps

1. In `src/main/ipc/sync-handlers.ts`, update the `EMAIL_SIGNUP` and `EMAIL_VERIFY` handlers to include the `recoveryPhrase` from pending signup state in their returned payloads.
2. Update `src/preload/index.d.ts`, `src/renderer/src/services/auth-service.ts`, `src/renderer/src/hooks/use-auth.ts`, and `src/renderer/src/contexts/auth-context.tsx` to carry `recoveryPhrase` in signup/verification results and store it in context state.
3. Adjust `src/renderer/src/pages/settings/setup-wizard.tsx` to stop generating a new phrase during signup and instead rely on the stored phrase.
4. In `sync-server/src/routes/auth.ts`, import `getUserById` and use it before `getUserByEmail` in the `/auth/recovery` handler.
5. In `src/main/ipc/sync-handlers.ts`, save tokens on the non-recovery email login path and update `getSetupStatus` to include token presence; update `src/shared/contracts/ipc-sync.ts` and `src/preload/index.d.ts` to add `hasTokens`.
6. In `src/main/sync/api-client.ts`, add a refresh-on-401 retry, update keychain tokens on refresh, and emit `sync:session-expired` on refresh failure.

Run each edit with focused checks: TypeScript compilation for updated types, and manual verification in the Setup Wizard flow.

## Validation and Acceptance

Run the app with `pnpm dev` from the repository root. Create a new account, verify email, and ensure the recovery phrase shown matches the phrase derived when completing setup (no mismatch errors during confirmation). Log in on an existing device after clearing tokens and confirm that sync attempts continue without 401 errors. Force an expired access token (by clearing or expiring it) and verify that the API client refreshes or emits a session-expired event that is handled by the renderer.

If available, run `pnpm typecheck` and expect it to pass.

## Idempotence and Recovery

All changes are additive and can be re-run safely. If a step fails, re-run after fixing TypeScript errors. If an auth flow breaks, clear keychain entries using the existing dev “Clear keychain” action in Settings and retry signup/login.

## Artifacts and Notes

Capture short evidence snippets after validation, such as:

- Setup Wizard shows the stored recovery phrase and confirmation passes without mismatch errors.
- Network logs show a refresh call followed by a successful retry on 401.

## Interfaces and Dependencies

Update the following interfaces and functions to keep type contracts aligned:

- `src/shared/contracts/ipc-sync.ts`: add `hasTokens` to `SetupStatus`.
- `src/preload/index.d.ts`: mirror the updated `SetupStatus` and signup/verification response shapes.
- `src/main/ipc/sync-handlers.ts`: include recovery phrase in signup/verification responses, persist tokens for login, and include token presence in setup status.
- `sync-server/src/routes/auth.ts`: use `getUserById` for recovery lookup fallback.
- `src/main/sync/api-client.ts`: implement token refresh and session-expired emission.

The sync server uses Cloudflare D1 user queries in `sync-server/src/services/user.ts`, and the main process uses keychain helpers in `src/main/crypto/keychain.ts` for token storage.
