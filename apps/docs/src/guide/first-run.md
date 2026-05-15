# First Run & Vault Setup

What happens the first time you open Memry: choosing a vault location, setting a passphrase, and saving the recovery phrase.

The whole flow takes about two minutes. The most important step is **saving the recovery phrase** — read on for why.

<!-- screenshot: first-run welcome overlay -->

## Welcome Overlay

A short overlay appears the very first time. It explains the local-first model: your data lives on your device first, and sync (if you turn it on) is end-to-end encrypted.

Click **Get started**.

## Choosing a Vault Location

The vault is a folder Memry owns on disk. It holds your encrypted SQLite databases, attachments, and CRDT state.

<!-- screenshot: vault picker dialog -->

You're asked where to put the vault. Defaults:

| Platform | Default path                                 |
| -------- | -------------------------------------------- |
| macOS    | `~/Library/Application Support/Memry/Vault/` |
| Windows  | `%APPDATA%/Memry/Vault/`                     |
| Linux    | `~/.config/Memry/vault/`                     |

Pick a different path if you want to:

- Sync the **vault** itself with iCloud / Dropbox (not recommended — sync conflicts with Memry's own sync; use Memry sync instead)
- Place it on a specific drive
- Keep it in a folder you back up separately

You can move the vault later from [Settings → Vault](/user-guide/settings#vault).

## Setting a Passphrase

Your passphrase encrypts the vault's wrapping key locally and is required at every sign-in.

Pick something:

- Long (passphrases > passwords; consider four random words)
- Memorable to you
- Not used anywhere else

Memry hashes the passphrase with **Argon2id** + a per-vault salt to derive the wrapping key. The passphrase itself never leaves your device.

You'll be asked to confirm by re-entering it.

## Recovery Phrase

This is the most important step.

<!-- screenshot: recovery phrase confirmation step -->

Memry generates a list of words derived from the same vault entropy. The phrase is the **only way** to decrypt your data if you:

- Forget your passphrase
- Lose every device that has the vault key sealed for it

Save it somewhere durable:

- A password manager (recommended)
- Written down in a safe place
- Printed and stored physically

**Do not** screenshot it on a synced phone, email it, or paste it in a notes app.

After showing the phrase, Memry asks you to **re-enter** a few specific words to confirm you've saved it. This step exists to prevent accidental loss.

If you close Settings during this confirmation step, signup stays incomplete. Reopen [Settings → Account](/user-guide/settings#account) to resume recovery confirmation before sync starts.

## Email & OTP (Optional, for Sync)

If you want sync, Memry asks for an email and verifies it with a six-digit one-time code.

You can skip sync entirely — choose **Continue without sync** to stay fully local. You can enable sync later from [Settings → Account](/user-guide/settings#account).

## What Gets Created

After setup completes, your vault directory looks like this:

```
<vault>/
├─ data.db              # primary SQLite database
├─ data.db-wal
├─ index.db             # search / graph / embedding index
├─ index.db-wal
├─ attachments/         # file payloads
├─ leveldb/             # y-leveldb store for Yjs CRDT state
└─ vault.json           # public metadata (version, salt — not the key)
```

All the heavy data is **encrypted at rest** with the vault key. The salt and version metadata are not sensitive.

## Onboarding Tour

After setup, Memry shows a brief in-app tour pointing out the sidebar, tabs, and search. Click through or skip — you can revisit it via the keyboard shortcuts dialog.

## Next Steps

- Take [a Tour of Memry](/guide/tour)
- Open the [User Guide](/user-guide/notes/editing) and start with Notes
- If you set up sync, [link another device](/user-guide/sync/linking-devices)
