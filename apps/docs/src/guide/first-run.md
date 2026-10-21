---
description: What happens the first time you open memrynote — the setup steps, sync and plan, signing in on another computer, and saving the recovery phrase.
---

# First Run & Vault Setup

What happens the first time you open memrynote on a computer: a short setup that picks your look, your modules and where your notes live, then opens the app.

The whole flow takes about two minutes. If you turn on sync, the most important step is **saving the recovery phrase**. Read on for why.

<!-- screenshot: first-run welcome screen -->

## Setup on a New Install

When memrynote knows no vaults on this computer, it opens the setup. Every screen works from the keyboard: <kbd>↑</kbd> and <kbd>↓</kbd> move between options, <kbd>↵</kbd> continues and <kbd>Esc</kbd> goes back a step. The dots at the top show how many steps are left. The language picker on the welcome screen switches the whole setup at once.

Choose **Get started** to set up a new space, or **Sign in** under "Already use Memry?" to bring an existing account's notes onto this computer (see [Signing In on Another Computer](#signing-in-on-another-computer)).

| Step        | What you choose                                                                                                                                                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Theme**   | System, White, Light (the Warm theme) or Dark. The setup repaints as you move through the list.                                                                                                                                                                                         |
| **Modules** | Which parts of memrynote you use: Home, Inbox, Journal, Tasks, Calendar, Graph, Spatial canvas and AI. Notes are always on. The preview under the list drops a module from the app's rail as you turn it off.                                                                           |
| **Import**  | Where to bring notes from. Obsidian vaults found on this computer are listed first, then Apple Notes and Notion, and the rest after them. Importers for a module you turned off are hidden: no Todoist or TickTick without Tasks, no NotePlan or Apple Journal without Journal.         |
| **Agent**   | Shown only with AI on. Which agent memrynote talks to: Claude Code, Codex, Antigravity or a local model (Ollama, LM Studio). Agents found on this computer can be picked; the others offer an install link. The on-device smart connections model starts downloading when you continue. |
| **Storage** | **Only on this Mac** (or "this computer" on Windows and Linux) keeps everything local. **Sync across my devices** continues to an account and a plan.                                                                                                                                   |
| **Ready**   | A last look: the notes folder (default `~/Documents/Memry`), the imports that will run, the model download, and whether to share anonymous usage metrics. **Open Memry** creates the folder and opens the app.                                                                          |

Nothing is written until **Open Memry**. The imports and the model download keep running after the app opens, and a message says when each import finishes or fails.

**Use an existing folder** on the Ready screen opens a folder you already have. A folder that is already a memrynote vault keeps its own settings: the theme, modules and imports you picked in setup are not applied to it.

The setup replaces the sidebar tour, so the tour does not run afterwards.

### Sync, Account and Plan

With **Sync across my devices**, setup asks for your email and a six-digit code, then shows a new account's 24-word recovery phrase and asks for three of its words back (see [Recovery Phrase](#recovery-phrase)). If the email already has an account, setup switches to unlocking that account on this computer instead.

Next comes the plan: Plus, Pro or Believer, monthly or yearly. **Continue to checkout** opens the payment page in your browser with that plan already chosen. Setup waits for the payment and moves on by itself once it goes through. **Not now** continues without a plan: everything stays on this computer, and the Ready screen offers **Choose a plan** to go back. Plans and prices are on [memrynote.com/pricing](https://memrynote.com/pricing).

## Signing In on Another Computer

**Sign in** on the welcome screen is for an account you already use. After the email code, this computer needs one of your keys: approve it from a device you already use (Settings → Account → Link new device) or enter your recovery phrase. Then pick the vault to download and where to put it. An account with a single vault skips the choice and downloads it into `~/Documents/Memry`. An account with no vaults yet continues to the setup steps above, with sync already on.

A vault you download brings its own synced settings, so it opens the way it looks on your other devices.

## Computers That Already Have Vaults

A vault is a folder of Markdown files on disk. memrynote keeps its databases, attachments, and CRDT state in a hidden `.memry` folder inside it.

When this computer already knows a vault, memrynote shows the vault picker instead of the setup. It offers three ways in:

<!-- screenshot: vault picker -->

| Option                       | Shortcut                  | What it does                                                                                                                                                           |
| ---------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Create new vault**         | <kbd>⌘</kbd>+<kbd>N</kbd> | Enter a name and a location (default `~/Documents/Memry`). memrynote creates the folder `<location>/<name>` and opens it. An existing folder is never reused silently. |
| **Open folder as vault**     | <kbd>⌘</kbd>+<kbd>O</kbd> | Pick a folder of Markdown files you already keep. Your files stay as they are.                                                                                         |
| **Open from Memrynote Sync** | <kbd>⌘</kbd>+<kbd>L</kbd> | Sign in (or create an account), unlock with your recovery phrase or a linked device, then pick one vault from your account to download.                                |

On Windows and Linux the shortcuts use <kbd>Ctrl</kbd>.

If **Create new vault** finds a folder with that name already at the location, it offers to open that folder as a vault instead.

**Open from Memrynote Sync** lists your account's vaults by name. Choose one and where it should be downloaded; a vault that is already on this computer opens its local copy. The other vaults stay in your account and can be downloaded later from the vault switcher. A new account with no vaults continues to **Create new vault**.

Pick a location of your own if you want to:

- Sync the **vault** itself with iCloud / Dropbox (not recommended — sync conflicts with memrynote's own sync; use memrynote sync instead)
- Place it on a specific drive
- Keep it in a folder you back up separately

You can move the vault later from [Settings → Vault](/user-guide/settings#vault).

## Setting a Passphrase

Your passphrase encrypts the vault's wrapping key locally and is required at every sign-in.

Pick something:

- Long (passphrases > passwords; consider four random words)
- Memorable to you
- Not used anywhere else

memrynote hashes the passphrase with **Argon2id** + a per-vault salt to derive the wrapping key. The passphrase itself never leaves your device.

You'll be asked to confirm by re-entering it.

## Recovery Phrase

This is the most important step.

<!-- screenshot: recovery phrase confirmation step -->

memrynote generates a list of words derived from the same vault entropy. The phrase is the **only way** to decrypt your data if you:

- Forget your passphrase
- Lose every device that has the vault key sealed for it

Save it somewhere durable:

- A password manager (recommended)
- Written down in a safe place
- Printed and stored physically

**Do not** screenshot it on a synced phone, email it, or paste it in a notes app.

After showing the phrase, memrynote asks you to **re-enter** a few specific words to confirm you've saved it. This step exists to prevent accidental loss.

If you close Settings during this confirmation step, signup stays incomplete. Reopen [Settings → Account](/user-guide/settings#account) to resume recovery confirmation before sync starts.

## Email & OTP (Optional, for Sync)

If you want sync, memrynote asks for an email and verifies it with a six-digit one-time code.

The code arrives from **MemryNote** (`noreply@memrynote.com`) with the subject "Your MemryNote verification code". If it doesn't show up within a minute or two, check your spam folder.

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

A vault opened from the vault picker gets a brief in-app tour pointing out the sidebar, tabs, and search. Click through or skip — you can revisit it via the keyboard shortcuts dialog.

The tour counts as seen once you finish it, skip it, or close it. If it never got that far — you quit the app while the tour was still on screen — it is not counted, and memrynote offers it again on the next launch. Either way it opens the right-hand Day Panel so the calendar and Agent steps have something to point at, and leaves it open afterwards.

The record that you have seen the tour is saved in the vault's own settings, so it survives app updates and reinstalls. The tour is also skipped for any vault that already holds notes, because that vault is not new, and for a vault set up through the first-run setup, which covers the same ground.

## Next Steps

- Take [a Tour of memrynote](/guide/tour)
- Open the [User Guide](/user-guide/notes/editing) and start with Notes
- If you set up sync, [link another device](/user-guide/sync/linking-devices)
