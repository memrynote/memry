# Linking Another Device

Add a second device that decrypts and syncs the same vault.

<!-- screenshot: device linking screen with QR code and short code -->

## How Linking Works

When you link a new device:

1. The new device generates a fresh Ed25519 keypair
2. The existing device approves the link (you confirm a fingerprint match)
3. The vault key is **sealed** for the new device's public key
4. The new device pulls every encrypted item and decrypts locally

The new device never sees your passphrase. The existing device never exposes the unsealed vault key.

## On the Existing Device

1. Open [Settings → Account](/user-guide/settings#account) → **Devices**
2. Choose **Link a device**
3. memrynote shows a **QR code** and a short **linking code** (6 digits or letters)
4. Keep this screen open

## On the New Device

1. Sign in to the same email
2. memrynote asks how to set up: **Link to an existing vault** vs **Create a new vault**
3. Choose **Link**
4. Either:
   - **Scan the QR code** with your camera (if available)
   - **Enter the linking code** manually

## Approval

The existing device shows an approval prompt:

- New device's name (auto-generated, editable)
- Public key fingerprint (visual hash)
- Platform (macOS / Windows / Linux)

Compare the fingerprint with what the new device shows. If they match, approve. The vault key is sealed for the new device and the new device starts pulling.

If something looks wrong, **deny** and start over.

## Choosing What to Pull

If the account holds **two or more vaults**, the new device asks which ones to pull before it
finishes linking:

1. Pick a **parent folder** — each vault is created as its own folder inside it
2. Check the vaults you want on this device
3. Choose **Pull selected**

The first checked vault is the **primary**: memrynote creates its folder, opens it, and starts
syncing right away. The rest stay cloud-only and show up under **In your account** in the vault
switcher, where you can download them on demand.

If the pull fails — an unwritable folder, for example — the reason appears under the list and the
choice stays available, so you can pick a different folder and try again without redoing the link.

Accounts with a single vault skip this step entirely.

## Initial Sync Progress

After approval, the new device shows a sync progress screen:

- Notes downloading
- Tasks downloading
- Inbox items downloading
- Attachments downloading

For large vaults this can take minutes. The new device is usable as soon as the metadata pull finishes — attachments stream in the background.

## Listing Devices

Settings → Account → Devices shows every linked device:

- Name (rename inline)
- Last seen
- Platform
- Public key fingerprint

When signed in, memrynote refreshes this list from the sync server so newly linked or revoked
devices appear without waiting for another sync item to pull their keys. If the server is
unreachable, the local cached device list remains available.

## Revoking a Device

From the device list, click **Revoke**. Effects:

- The device's sealed vault key is removed from the server
- Future pulls from that device fail with auth errors
- The local data on that device is untouched (it's still readable until you wipe it)

Revoke when you no longer use a device. **Revoke immediately** if you suspect compromise — and follow up with a [key rotation](/user-guide/sync/recovery-rotation).

## Lost Device

You **cannot** revoke from a device you don't have. Use any other linked device:

1. Devices list → **Revoke** the lost device
2. Recommended: **Rotate keys** to invalidate any sealed key copies that may have been exfiltrated

If you have **only** the lost device, restore on a new machine using your **recovery phrase** (see [Recovery Key & Rotation](/user-guide/sync/recovery-rotation)).

## Renaming Devices

Click a device's name in the list to rename. The name is local convenience — it doesn't affect security or sync.

## Limits

There's no fixed device limit, but very large numbers of linked devices increase the time to seal the vault key during rotation. Practically: keep your active devices and revoke the rest.

## See Also

- [How Sync Works](/user-guide/sync/how-sync-works)
- [Recovery Key & Rotation](/user-guide/sync/recovery-rotation)
