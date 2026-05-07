# Cryptography

Memry's threat model treats the device as the trusted boundary. The server stores ciphertext only.

## Primitives (libsodium)

- **Symmetric**: XChaCha20-Poly1305 (AEAD) with random 24-byte nonces.
- **Signing**: Ed25519 for device keys.
- **Key derivation**: Argon2id from passphrase + per-vault salt.

## Key Hierarchy

1. Passphrase + Argon2id → wrapping key
2. Wrapping key → vault key (decrypted locally)
3. Vault key → per-payload data keys

## Per-Device Keys

Each device generates an Ed25519 keypair on link. The vault key is sealed for each device's public key so revoking a device cuts off its access without rotating the vault.

## Nonces

All XChaCha20 operations use `sodium.randombytes_buf(24)` via a dedicated nonce utility. Nonces are stored alongside ciphertext.

## Constant-Time Comparison

All authentication code paths use `sodium.memcmp` to avoid timing leaks.

## Tombstone Signing

`deleted_at` is included in the signed payload so a hostile server cannot forge deletions.

## Argon2id Parameters

Spec calls for parallelism = 4; libsodium pins 1. Memry documents 1 as canonical.
