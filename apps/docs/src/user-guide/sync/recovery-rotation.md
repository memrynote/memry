# Recovery Key & Rotation

What the recovery phrase is for, where to find it, and when to rotate the vault key.

<!-- screenshot: recovery phrase display screen -->

## Recovery Phrase

A list of words generated at vault creation. It's the **only way** to decrypt your data if you:

- Forget your passphrase
- Lose every device that has the vault key sealed for it

Memry **never stores** the recovery phrase in the cloud. It exists only where you save it.

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

1. Install Memry on a fresh device
2. Choose **Restore from recovery phrase** during setup
3. Enter the words in order
4. Set a new passphrase (the recovery phrase + new passphrase regenerates the wrapping key)
5. The device pulls and decrypts your vault

The recovered device is treated as a new linked device.

## Key Rotation

The **rotation wizard** generates a new vault key, re-encrypts all payloads under it, and reseals the new key for every linked device.

### When to Rotate

| Situation | Rotate? |
| --- | --- |
| Lost or stolen device that wasn't revoked yet | Yes — immediately |
| Recovery phrase exposed | Yes |
| Major OS or backup compromise | Yes |
| Suspect API key leak | No (rotate the API key, not the vault key) |
| Routine maintenance | Optional; rotation is safe but takes time |

### Running Rotation

1. [Settings → Account → Security](/user-guide/settings#account) → **Rotate Keys**
2. Confirm your passphrase
3. The wizard:
   - Generates a new vault key
   - Re-encrypts payloads (streamed; resumable)
   - Reseals the new key for each linked device
   - Bumps `crypto_version` on sync items

For large vaults, rotation can take a while. It's safe to interrupt — the wizard resumes from the last checkpoint.

### Effects

- Old sealed keys on revoked devices are now useless even if they were exfiltrated
- The new key is unknown to the server (it sees only ciphertext)
- The recovery phrase remains valid (rotation doesn't reset it)

## Recovery Phrase vs Passphrase

| | Recovery phrase | Passphrase |
| --- | --- | --- |
| What it does | Re-derives the wrapping key | Daily sign-in |
| When you use it | After losing access | Every sign-in |
| How often it changes | Almost never | Whenever you want |
| Where it lives | Off-device, manual | In your head |

Changing your passphrase doesn't invalidate the recovery phrase or the vault key — it only re-encrypts the wrapping key against the new passphrase.

## See Also

- [How Sync Works](/user-guide/sync/how-sync-works)
- [Linking Another Device](/user-guide/sync/linking-devices)
- [Cryptography](/architecture/cryptography)
