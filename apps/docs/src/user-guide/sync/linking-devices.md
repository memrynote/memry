# Linking Another Device

Add a second device that decrypts and syncs the same vault.

<!-- screenshot: device linking screen with QR code -->

## Starting from the Existing Device

Open [Settings → Account](/user-guide/settings#account) and choose "Link a device." Memry shows a QR code and a short linking code.

## Approving the New Device

Open the new device, sign in to the same email, and scan the QR code (or enter the linking code). The existing device shows an approval prompt with the new device's name and fingerprint.

## What Happens After Approval

The vault key is sealed for the new device's public key. The new device pulls all encrypted state from the server and decrypts it locally.

## Removing a Device

[Settings → Account → Devices](/user-guide/settings#account) lists all linked devices. Revoke the ones you no longer use.

## Lost Device

If you lose access to a device, revoke it and rotate the vault key. See [Recovery Key & Rotation](/user-guide/sync/recovery-rotation).
