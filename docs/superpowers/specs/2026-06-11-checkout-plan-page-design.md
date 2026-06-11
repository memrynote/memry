# Checkout / Plan-Selection Page Design

**Date:** 2026-06-11
**Status:** Approved (design), pending implementation plan
**Owner:** Kaan

## Problem

The desktop "Upgrade" button (Settings → Account) is hardwired to a single plan.
`account-section.tsx` calls `window.api.account.startCheckout({ plan: 'pro', cadence: 'annual' })`
with literal values — there is no plan picker anywhere in the app. A user who wants
Plus, monthly billing, or the Believer lifetime plan has no way to reach it from the
desktop app.

Root cause: the landing `Pricing.tsx` page (lines 79–92) **auto-fires the Paddle
overlay** the moment it sees a `checkout_token` in the URL hash. Because the page
launches checkout instantly, the desktop side is forced to pre-select the plan and
cadence before opening the browser. The signed checkout token currently encodes
`{ userId, plan, cadence, exp }`, so plan choice is baked in at token-mint time.

## Goal

Clicking "Upgrade" lands the user on a dedicated web checkout page where they:

1. See the purchasable plans (Plus / Pro / Believer).
2. Pick a plan and billing cadence (Monthly / Annual; Believer is lifetime).
3. See a live order summary (billing frequency, line item, total).
4. Click **Proceed to payment** → Paddle checkout.

Reference: Obsidian Sync's two-column "Choose a Sync plan" checkout screen.

## Decisions (locked)

- **Page dimensions:** plan + cadence only. No storage selector — each plan carries its
  bundled storage limit. (No new Paddle price IDs needed.)
- **Location / identity:** new web route `/checkout` on the landing site, opened in the
  external browser. The user is identified by a short-lived **identity token** (userId
  only) minted by the desktop app; the plan/cadence are chosen on the page.
- **Route name:** `/checkout`.

## New Flow

1. Desktop "Upgrade" → IPC `account.startCheckout()` (no arguments).
2. main `startBillingCheckout()`: get access token → POST sync-server
   `/auth/checkout-token` → receives an **identity token** `{ userId, exp }` (10-min TTL)
   → opens `https://memrynote.com/checkout#token=<identityToken>` via `shell.openExternal`.
3. `/checkout` page reads `#token`:
   - Left column: Plan selector (Plus / Pro / Believer) + Renewal frequency
     (Monthly / Annual). When Believer is selected, cadence is forced to `lifetime` and
     the renewal toggle is hidden.
   - Right column: order summary (billing frequency, subscription line, total) +
     **Proceed to payment** button.
   - No token present → show "Open Memry and sign in from Account" CTA, no checkout.
4. Proceed → POST `/api/paddle-checkout { plan, cadence, token }`:
   - Verify identity token → `userId`.
   - Read `plan` + `cadence` from the request body (validated).
   - Resolve `priceId` from `PRICE_ENV_KEYS[plan][cadence]`; build `customData` with
     `userId`.
   - Create Paddle transaction → return `transactionId`.
5. Open Paddle overlay with the transaction. Success URL unchanged
   (`/pricing?checkout=success&transactionId=…` pattern is reused).
6. Pay → existing deep link `memry://billing/complete?transactionId=…` →
   `handleDeepLink` → `openAccountSettings` + `reconcileBillingAndSync({ transactionId })`.
   **Unchanged.**

## Changes by Package

### sync-server — `src/services/checkout-token.ts`, `src/routes/auth.ts`

- Token payload `{ userId, plan, cadence, exp }` → **`{ userId, exp }`**. Rename/replace
  `signCheckoutToken` with an identity-token signer.
- `POST /auth/checkout-token` (`authMiddleware`) no longer requires a `{ plan, cadence }`
  body; it returns a userId-only identity token (10-min TTL, `CHECKOUT_TOKEN_TTL_SECONDS`).

### landing api — `api/paddle-checkout-config.ts`, `api/paddle-checkout.ts`

- Split intent parsing: token → `userId` only; `plan` + `cadence` come from the request
  body, zod-validated, with `believer → lifetime` and "non-believer cannot be lifetime"
  rules preserved.
- `getPaddleCheckoutConfig` takes resolved `{ userId, plan, cadence }`; price resolution
  via `PRICE_ENV_KEYS` is unchanged (server remains the source of truth for the amount).
- `parsePaddleCheckoutIntent` (or its replacement) verifies the token for identity and
  merges in body plan/cadence.

### landing web — new `src/pages/Checkout.tsx`, `src/App.tsx`, `src/lib/paddle-checkout.ts`

- New two-column `Checkout` page rendered at route `/checkout`. Uses `SYNC_PLAN_TIERS`
  for display prices (`monthlyPrice`, `annualPrice`, `annualMonthlyEquivalent`,
  `lifetimePrice`).
- Reads identity token from the URL hash; no-token state shows the sign-in CTA.
- `paddle-checkout.ts`: `openPaddleCheckout` already posts `{ plan, cadence, checkoutToken }`
  — adjust so plan/cadence are the user's on-page selection and the token is the identity
  token.
- Remove the now-dead `checkout_token` auto-fire branch from `Pricing.tsx` (lines 79–92).
  `/pricing` stays a marketing page; its tier buttons keep the website-visitor
  `memry://billing/start` bounce.

### desktop — `src/main/billing/paddle-billing.ts`, IPC contract, `src/renderer/.../account-section.tsx`, `src/main/index.ts`

- `startBillingCheckout()` takes no plan input: mint identity token, build
  `…/checkout#token=…`, `shell.openExternal`. Drop `buildLandingCheckoutUrl`'s
  plan/cadence params (or replace with a checkout-page URL builder).
- IPC `account.startCheckout` contract drops `{ plan, cadence }`. Update the renderer
  `handleStartCheckout` to call it with no args (removes the hardcoded `pro`/`annual`).
- Deep link `memry://billing/start` (website-visitor path): open `/checkout` instead of
  immediately starting a fixed checkout. Optionally carry the clicked plan as a hash
  pre-selection. The `/complete` branch is unchanged.

## Security

- **Amount** is always server-resolved from `PRICE_ENV_KEYS[plan][cadence]`; the client
  never sends a price. Tampering with body plan/cadence only changes which legitimate
  plan the user buys.
- **userId** comes from the HMAC-signed identity token; a user cannot purchase on behalf
  of another account.
- Identity token is short-lived (10 min), single-purpose, minted only for an
  authenticated user.

## Out of Scope (v1)

- Storage tiers / add-ons (decided: plan + cadence only).
- Plan management, upgrades between paid tiers, downgrades, cancellation (handled by the
  existing Paddle billing portal via `openBillingPortal`).
- Website-native authentication (website visitors still bounce through the desktop app
  to obtain an identity token).

## Testing

- **sync-server:** identity token sign/verify round-trip; `/auth/checkout-token` returns a
  userId-only token and no longer requires a plan/cadence body; expiry honored.
- **landing api:** `/api/paddle-checkout` reads plan/cadence from the body; rejects
  missing/invalid/expired tokens; `believer → lifetime` and "non-believer ≠ lifetime"
  rules; price resolution unchanged.
- **landing web:** `Checkout.tsx` — selecting a plan/cadence updates the summary and
  total; Believer hides the renewal toggle and shows the lifetime price; no-token state
  renders the sign-in CTA, not a checkout button.
- **desktop:** `startBillingCheckout()` opens `…/checkout#token=…` with an identity token;
  IPC `account.startCheckout` no longer accepts plan/cadence; renderer button no longer
  passes `pro`/`annual`.

## Docs Impact

Desktop + sync-server + landing change. Run `pnpm docs:impact --base <base> --strict`
and update `apps/docs/src` (or `pnpm docs:ai-update`) before push/PR.
