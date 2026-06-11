# Landing Account Area — Design

**Date:** 2026-06-11
**Status:** Approved (design), pending implementation plan
**Scope:** `apps/landing`, `apps/sync-server`

## Problem

The landing site has no login. Account management lives entirely in the desktop
app: it signs the user in, mints a checkout token, and opens
`/checkout#token=…`. The landing `Checkout` page only trusts a token handed to
it via URL hash (`Checkout.tsx:38`); `paddle-checkout.ts:91` literally tells
users "Open Memry and sign in from Account."

We want users to sign in **on the landing site** and manage their account from a
dashboard: profile, billing, and sync.

## Key architectural finding

Memry is passwordless and E2E-encrypted. Two facts make this feasible without
porting the desktop's heavy ("23-phase") vault setup to the web:

1. **No account password exists.** Sign-in is email OTP + Google OAuth. There is
   no server-side password and no `password` column. The only password-like
   secret is the *vault passphrase* (client-side Argon2id, desktop-only, never
   sent to the server).
2. **Account/billing endpoints do not require vault keys.** `POST /auth/devices`
   needs only a per-device Ed25519 keypair + a signed challenge (not the vault
   master key) and returns real `accessToken`/`refreshToken`. `/auth/setup`
   (the `kdf_salt`/vault key material) is separate and optional. So a browser
   can authenticate as a lightweight **device** — generate its own keypair with
   libsodium, sign the challenge — and reach every account/billing endpoint
   **without ever creating a vault**.

This is the design's foundation: the web is a billing/identity client, never a
data/vault client. Full vault signup stays in the desktop app.

## Non-goals (dropped / deferred)

- **Account password / change password** — dropped. Passwordless (OTP); no
  password to change.
- **Two-factor auth** — deferred. (Every OTP login is already a possession
  check.)
- **Apply discount in-app** — deferred. Discounts are applied at Paddle
  checkout.
- **Web vault / notes / sync data** — out of scope. The web never holds vault
  keys or note data.

## Architecture

A new authenticated area lives **inside `apps/landing`** (no separate app). The
account routes are client-only (no SSR) and route-guarded. The web registers as
a lightweight device with its own auth keypair; it never performs E2E vault
setup.

### Routes

- `/auth` — sign in (Email OTP + Continue with Google). Redirects to
  `/account` when already signed in.
- `/account/profile` — default account tab.
- `/account/billing`
- `/account/sync`
- Navbar **Account** → `/account` when signed in, else `/auth`.

### Sidebar information architecture

Left sidebar, right detail pane.

- **Profile**
  - Current email (read-only) + **change email** (OTP to new address → verify).
  - **Contact support** (mailto link).
  - **Log out everywhere** (revoke all devices + tokens).
  - **Delete account** (irreversible; typed-confirm + fresh OTP).
- **Billing**
  - Subscription status from `GET /auth/billing`.
  - **Custom invoice list** from Paddle transactions API (date, amount,
    status, invoice PDF URL).
  - "Manage payment method" → Paddle portal (`/auth/billing/portal-session`).
- **Sync**
  - Reuse the existing `Checkout` UI extracted as a shared `CheckoutPanel`.
    Because the user is already authenticated, mint the checkout token
    in-browser via `/auth/checkout-token` instead of reading it from the URL
    hash.
- **Sidebar bottom**
  - **Logout** (`/auth/logout`, current device).
  - **Back to homepage** (`Link` to `/`).

## Session model (landing)

Add `libsodium-wrappers` to `apps/landing`.

Sign-in flow:

1. Email OTP (`/auth/otp/request` → `/auth/otp/verify`) **or** Google OAuth
   (`/auth/oauth/google` → callback `/auth/oauth/google/callback`). Both return
   `{ setupToken, needsSetup, isNewUser }`.
2. Generate a device Ed25519 keypair (libsodium). Persist keypair + `deviceId`
   in `localStorage` so repeat sign-ins reuse one device.
3. `POST /auth/devices` with the signed challenge → `{ deviceId, accessToken,
   refreshToken }`.
4. Store tokens in `localStorage`.

Runtime:

- A small auth context exposes session state to the account UI.
- A `fetch` wrapper attaches `Authorization: Bearer <accessToken>` and, on a
  401, calls `/auth/refresh` once and retries.
- A route guard redirects unauthenticated visits to `/account/*` to `/auth`.

Device hygiene: the persisted keypair keeps repeat sign-ins on a single device
named "Web — &lt;browser&gt;". Clearing browser storage strands the old device
until revoked; "Log out everywhere" clears these.

## Backend changes (`apps/sync-server`)

### New endpoints

- `POST /auth/email/change` — request: new email → send OTP to the new address.
  `POST /auth/email/change/verify` — confirm with OTP → update `users.email`,
  re-set `email_verified`. Anti-enumeration + rate limiting consistent with the
  existing OTP routes.
- `POST /auth/logout-all` — revoke all of the user's devices and refresh tokens
  (extends the existing per-device `revokeDevice` / `revokeDeviceTokens`).
- `DELETE /auth/account` — wipe the user across D1 (users, devices, sync items,
  vault directory, consumed tokens) and R2 (encrypted payloads). Gated behind a
  fresh OTP confirmation. Irreversible.
- `GET /auth/billing/invoices` — call the Paddle transactions API for the user's
  customer and return invoice rows (date, amount, currency, status, invoice PDF
  URL).

### Modified

- `GET /auth/oauth/:provider` — the `redirect_uri` allowlist currently only
  permits `127.0.0.1` loopback (`auth.ts:261`, for desktop). Extend it to permit
  the landing https origin for web OAuth.

### Reused as-is

`/auth/otp/*`, `/auth/billing`, `/auth/billing/portal-session`,
`/auth/checkout-token`, `/auth/devices`, `/auth/logout`, `/auth/refresh`.

## Config & deploy

- `VITE_SYNC_SERVER_URL` in `apps/landing` (dev `http://localhost:8787` /
  staging / prod `https://sync.memrynote.com`). The landing currently makes no
  authenticated sync-server calls, so this base URL is net-new.
- `ALLOWED_ORIGIN` set to the landing origin on sync-server **staging** and
  **production** (CORS — `index.ts:110-117`). Dev already allows
  `http://localhost:5173`.
- Register the landing web redirect URI in the Google OAuth client.

## Testing

- **sync-server (Vitest):** new endpoints — email change (request + verify,
  enumeration/rate limits), logout-all (revokes all devices), delete account
  (removes D1 + R2, OTP-gated), billing invoices (Paddle response → rows).
- **landing (Vitest):** auth helpers — device keypair generation/persistence,
  challenge signing, token storage, refresh-on-401 wrapper, route guard.
- **Manual:** sign in via OTP and via Google; change email; view invoices; open
  Paddle portal; start sync checkout from the Sync tab; log out (device); log
  out everywhere; delete account.

## Risks

- **Delete account is irreversible** and spans D1 + R2; must be transactional
  enough that a partial failure is detectable and retried, and gated behind
  explicit confirmation.
- **Device accumulation** if browser storage is cleared repeatedly. Mitigated by
  persisting the keypair and offering "log out everywhere."
- **CORS / OAuth redirect** misconfiguration blocks the whole area in
  staging/prod; verify both before declaring done.
