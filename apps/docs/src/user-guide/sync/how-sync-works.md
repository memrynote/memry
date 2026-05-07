# How Sync Works

Memry sync is **end-to-end encrypted**. The server stores ciphertext and never sees note content.

<!-- screenshot: sync status indicator in the app chrome -->

## What Sync Is For

- Mirror your vault across multiple devices
- Recover after a device loss (with your recovery phrase)
- Persist a backup off-device that you control via passphrase

Sync is **opt-in**. If you never sign in, nothing leaves your device.

## Status Indicator

A small indicator in the app chrome shows the current state:

| Color | Meaning |
| --- | --- |
| Green | Idle, in sync |
| Blue | Syncing right now |
| Yellow | Paused, retrying with backoff, or temporary error |
| Red | Authentication or quota issue requiring action |

Click the indicator for details, recent activity, and a pause toggle.

## Pause / Resume

Pause sync from the indicator menu when:

- Working offline intentionally
- Investigating a sync issue
- Conserving bandwidth on a slow connection

Resume sync to push and pull queued changes. Outgoing changes queue locally until paused → resumed.

## What Gets Synced

| Item | Sync? |
| --- | --- |
| Notes (Yjs CRDT) | ✓ |
| Journal entries | ✓ |
| Tasks (field-level vector clocks) | ✓ |
| Projects | ✓ |
| Inbox items | ✓ |
| Templates (custom) | ✓ |
| Tags and properties | ✓ |
| Settings (selected, opt-in) | ✓ |
| Bookmarks and reminders | ✓ |
| Attachments (encrypted blobs) | ✓ |

## What Does **Not** Get Synced

- Open tabs, sidebar collapse, panel widths (UI state)
- Cached AI models and embedding vectors
- Voice transcription model files
- AI provider API keys
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
