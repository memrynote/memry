# How Sync Works

memrynote sync is **end-to-end encrypted**. The server stores ciphertext and never sees note content.

<!-- screenshot: sync status indicator in the app chrome -->

## What Sync Is For

- Mirror your vault across multiple devices
- Recover after a device loss (with your recovery phrase)
- Persist a backup off-device that you control via passphrase

Sync is **opt-in** and requires a paid sync plan. If you never sign in, nothing leaves your
device. If you sign in without an active paid plan, the app stays fully local — signing in on a
free or lapsed plan never triggers a sync error. memrynote checks your plan once at sign-in, then
will not contact the sync server again to start sync while you stay unpaid, so a signed-in unpaid
account behaves exactly like a signed-out one. Activating a plan starts sync immediately, with no
restart.

## Paid Sync Plans

| Plan         | Encrypted storage | Synced vaults | File limit | Version history |
| ------------ | ----------------- | ------------- | ---------- | --------------- |
| **Plus**     | 1 GB              | 1             | 5 MB       | 30 days         |
| **Pro**      | 10 GB             | 10            | 200 MB     | 365 days        |
| **Believer** | 50 GB             | Unlimited     | 200 MB     | 365 days        |

All record sync, CRDT sync, WebSocket sync notifications, and encrypted blob uploads are gated by
the active plan on the sync server. The server still stores only ciphertext.

Start a paid plan from **Settings -> Account -> Billing** or **Upgrade to Pro** in the sidebar
account menu. memrynote opens checkout on `memrynote.com/pricing`; after Paddle completes payment,
return to the app from the success page so the desktop can reconcile the transaction and refresh
sync. If the webhook is still processing, Billing shows **Activation pending** with a refresh button
and the billing support email.

Billing management uses Paddle's hosted customer portal from the same Billing section. Refunds and
chargebacks are handled by emailing support for now; memrynote does not automate those flows inside
the app.

## Status Indicator

A small indicator in the app chrome shows the current state:

| Color  | Meaning                                                  |
| ------ | -------------------------------------------------------- |
| Green  | Idle, in sync                                            |
| Blue   | Syncing right now                                        |
| Yellow | Paused, retrying with backoff, or temporary error        |
| Red    | Authentication, billing, or quota issue requiring action |

Click the indicator for details, recent activity, and a pause toggle.

## Pause / Resume

Pause sync from the indicator menu when:

- Working offline intentionally
- Investigating a sync issue
- Conserving bandwidth on a slow connection

Resume sync to push and pull queued changes. Outgoing changes queue locally until paused → resumed.

## What Gets Synced

| Item                                                           | Sync? |
| -------------------------------------------------------------- | ----- |
| Notes (Yjs CRDT)                                               | ✓     |
| Journal entries                                                | ✓     |
| Tasks (field-level vector clocks)                              | ✓     |
| Projects                                                       | ✓     |
| Inbox items                                                    | ✓     |
| Templates (custom)                                             | ✓     |
| Tags and properties                                            | ✓     |
| Settings (selected, opt-in)                                    | ✓     |
| Bookmarks and reminders                                        | ✓     |
| Attachments (encrypted blobs)                                  | ✓     |
| Agent chat conversations and terminal messages (paid accounts) | ✓     |

## What Does **Not** Get Synced

- Open tabs, sidebar collapse, panel widths (UI state)
- Cached AI models and embedding vectors
- Voice transcription model files
- AI provider API keys
- In-progress agent streaming tokens
- Built-in templates (baked into the app version)
- Local logs

## Frequency

Sync runs **continuously** while the app is open and online:

- Push fires within seconds of a local change
- Pull runs on a polling interval and after every push
- Backoff with jitter on repeated errors

There's no "sync now" button because there doesn't need to be — but you can pause and resume to force a fresh attempt.

## End-to-End Encryption

Before any data leaves your device, it's encrypted with:

- **XChaCha20-Poly1305** for content
- **Ed25519** signatures over metadata + content hash
- **Argon2id** key derivation from your passphrase

The server stores the ciphertext, signatures, and metadata — but cannot decrypt anything. See [Cryptography](/architecture/cryptography) for the details.

Agent chat follows the same rule: conversation titles, message bodies, and message attachments stay
encrypted on disk and in sync payloads. Sync only uploads completed agent messages, so a partially
streaming response remains local until it reaches a terminal status. Attachments include structured
references created by inline Agent mentions, including notes, tasks, journals, inbox items, and
calendar events.

## Where the Server Lives

- **Edge API** — Cloudflare Workers (Hono framework)
- **Metadata** — Cloudflare D1 (sync items, vector clocks, blob keys)
- **Blobs** — Cloudflare R2 (encrypted payloads)

You don't manage any of this directly — it's the sync backend behind your account.

## Multi-Device

Linking another device requires a one-time approval from a currently-signed-in device. After linking, the new device decrypts the same vault using the per-device sealed key.

See [Linking Another Device](/user-guide/sync/linking-devices).

## See Also

- [Linking Another Device](/user-guide/sync/linking-devices)
- [Recovery Key & Rotation](/user-guide/sync/recovery-rotation)
- [Conflict & Health](/user-guide/sync/conflict-health)
- [Sync Protocol](/architecture/sync-protocol) (architecture deep-dive)
