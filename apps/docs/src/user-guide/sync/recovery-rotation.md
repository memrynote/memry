# Recovery Key

What the recovery phrase is for, where to find it, and what to do if it or a device leaks.

<!-- screenshot: recovery phrase display screen -->

## Recovery Phrase

A list of words generated at vault creation. It's the **only way** to decrypt your data if you:

- Forget your passphrase
- Lose every device that has the vault key sealed for it

memrynote **never stores** the recovery phrase in the cloud. It exists only where you save it.

## Where to Save It

Pick at least one of:

- **Password manager** (1Password, Bitwarden, etc.) — recommended
- **Written down** in a safe place
- **Printed** and stored physically

**Don't** screenshot it on a synced phone, email it to yourself, or paste it in a sticky note app — those defeat the purpose.

## Re-Displaying the Recovery Phrase

You can re-show the recovery phrase from [Settings → Account → Security](/user-guide/settings#account):

1. Click **Recovery Key**
2. Confirm your passphrase
3. The phrase displays. You can copy it (briefly to clipboard) or write it down.

The display screen has a 60-second auto-clear so you don't accidentally leave it visible.

## Restoring with Recovery

If you lose every device:

1. Install memrynote on a fresh device
2. Choose **Restore from recovery phrase** during setup
3. Enter the words in order
4. Set a new passphrase (the recovery phrase + new passphrase regenerates the wrapping key)
5. The device pulls and decrypts your vault

The recovered device is treated as a new linked device.

### Automatic Recovery Prompt

memrynote also detects when the key stored on a device can no longer decrypt the account's data
(for example after a corrupted key migration). Instead of endless "failed to decrypt" errors, the
app signs that device out and routes you into this same recovery flow — sign in, enter your
recovery phrase, and the device re-derives the correct key and pulls everything cleanly. Data on
the server is never affected.

### If the Sign-In Times Out

The sign-in that precedes recovery is only valid for a few minutes, but going away to find your
recovery phrase no longer costs you that sign-in. When you submit the phrase after the few minutes
have passed, memrynote renews the sign-in in place — using a key it tied to this device when you
signed in — and carries straight on. You do not have to do anything, and you can take as long as
you need within a day of signing in.

If it cannot renew — the app was reinstalled again in between, the sign-in is more than a day old,
or it came from an older version that did not tie a key to the device — you are told the sign-in
timed out and asked to sign in again before entering the phrase. The phrase itself is still fine
and nothing was lost. A **Sign in again** button appears alongside the message so you can act on it
straight away, in every language memrynote supports.

### If You Can't Get Your Recovery Phrase Back

The recovery screen offers **"I can't get my recovery phrase back"**. It is deliberately quiet,
and it explains everything before it does anything:

- This device signs out and stops syncing.
- The encryption key held on this device is deleted. Anything already stored in your account
  stays encrypted under the old key, and without the recovery phrase **nothing can ever read it
  again**. This cannot be undone.
- Notes already saved on this computer stay in your vault folder and keep working.

Only use it when the phrase is gone for good. If there is any chance of finding it — a password
manager, a printout, another device still signed in — recover instead.

## If You Think Your Key Leaked

If a device is lost or stolen, or someone may have seen your recovery phrase, cut off access to
your account:

- **Revoke the device.** On any other signed-in device, open the
  [Devices list](/user-guide/sync/linking-devices#revoking-a-device) and click **Revoke** on the
  lost one. A device cannot revoke itself.
- **Log out everywhere.** On [memrynote.com](/user-guide/sync/web-account#profile), **Log out
  everywhere** revokes every device and session on your account. Each device must sign in again
  afterward.
- **Protect your email account.** Signing in uses a code sent to your email (or your Google
  account), so whoever controls that account can sign in again.

**Sign Out** in [Settings → Account](/user-guide/settings#account) acts on this device only. It
stops sync here and removes this device's keys; other devices stay signed in.

### Known Limitation: The Vault Key Cannot Be Replaced

memrynote cannot rotate the vault key. The key derives from your recovery phrase, and nothing
re-encrypts your synced data under a new key. A leaked recovery phrase stays valid for your
account, and revoking a device or logging out everywhere does not change any key. Anyone who has
the phrase and can sign in to your account can decrypt your synced data, so keep both the phrase
and your email account secure.

## Recovery Phrase vs Passphrase

|                      | Recovery phrase             | Passphrase        |
| -------------------- | --------------------------- | ----------------- |
| What it does         | Re-derives the wrapping key | Daily sign-in     |
| When you use it      | After losing access         | Every sign-in     |
| How often it changes | Almost never                | Whenever you want |
| Where it lives       | Off-device, manual          | In your head      |

Changing your passphrase doesn't invalidate the recovery phrase or the vault key — it only re-encrypts the wrapping key against the new passphrase.

## See Also

- [How Sync Works](/user-guide/sync/how-sync-works)
- [Linking Another Device](/user-guide/sync/linking-devices)
- [Cryptography](/architecture/cryptography)
