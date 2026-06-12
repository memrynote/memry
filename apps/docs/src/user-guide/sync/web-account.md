# Account on the Web

You can sign in at [memrynote.com](https://memrynote.com) to manage your account and
billing from a browser — no desktop app required. Click **Account** in the site header to
reach the sign-in page.

The web session is **passwordless** and never touches your vault. Your notes, journals, and
tasks stay encrypted on your devices; the web only manages your identity and subscription.

## Signing In

Two ways, both passwordless:

- **Email code** — enter your email, then the 6-digit code we send you.
- **Continue with Google** — sign in with the Google account tied to your memrynote account.

The browser registers itself as a lightweight **device** (its own signing key, generated
locally) so it can talk to the account API. It does **not** create or download a vault — there
is no encryption passphrase and no note data on the web. To set up a vault, use the desktop app.

## Account Dashboard

After signing in you land on the account dashboard, organized into three sections.

### Profile

- **Email** — view your current address and change it. Changing email sends a 6-digit code to
  the new address; the change applies once you confirm the code.
- **Contact support** — opens an email to the support team.
- **Log out everywhere** — revokes every device and session on your account. Use this if a
  device is lost or you want to reset access. Each device must sign in again afterward.
- **Delete account** — permanently erases your account and all synced (encrypted) data on the
  server. This is **irreversible** and is gated behind a typed confirmation plus a fresh email
  code.

### Billing

- **Subscription** — your current plan and status.
- **Invoices** — your past invoices, each downloadable as a PDF.
- **Manage payment method** — opens the secure billing portal to update cards, view receipts,
  or cancel.

### Sync

Start or upgrade a sync plan directly from the browser. Because you are already signed in, the
checkout opens without needing to launch the desktop app first. See
[How Sync Works](/user-guide/sync/how-sync-works) for plan details.

## What the Web Cannot Do

- It cannot read, decrypt, or edit your notes — the web never holds your vault keys.
- It cannot change your **vault passphrase**; that is a desktop-only operation, since only your
  devices hold the encryption keys.
- There is no account password to change — sign-in is always a one-time email code or Google.
