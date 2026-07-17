# Cryptography

memrynote's threat model treats the device as the trusted boundary. The server stores ciphertext only, with no access to keys.

## Primitives (libsodium)

| Use                                | Algorithm                 |
| ---------------------------------- | ------------------------- |
| Authenticated symmetric encryption | XChaCha20-Poly1305 (AEAD) |
| Asymmetric signing                 | Ed25519                   |
| Asymmetric key sealing             | X25519 (sealed boxes)     |
| Password key derivation            | Argon2id                  |
| Random                             | `sodium.randombytes_buf`  |

## Key Hierarchy

```
passphrase ──Argon2id(salt)──▶ wrapping key
                                    │
                                    ▼
                         vault key (decrypted on device)
                                    │
                       ┌────────────┼────────────┐
                       ▼            ▼            ▼
                  data keys    blob keys    crdt keys
                  (per item)   (per blob)   (per doc)
```

**Per-vault salt** is stored alongside the vault and is unique to that user. **Per-device sealing**: when a device links, the vault key is sealed for its X25519 public key — revoking that device cuts access without rotating the vault.

Local-only development vaults can create a device master key without sign-in. memrynote stores a
non-secret verifier in the local settings table so the SQLite vault stays bound to the keychain
master key that produced it. If that verifier exists and the keychain key is missing or produces a
different vault key, encrypted surfaces fail closed instead of silently creating a replacement key.
First-device setup and recovery relinking rebind this local verifier immediately after the new
master key is saved, before sync activation. If the verifier cannot be checked at startup, the sync
runtime stays offline instead of starting queues, CRDT seeding, or snapshot uploads with missing
vault-key credentials.

The keychain account is suffixed per device: production installs use the bare account, while
explicit dev profiles (`A`/`B`/`C`) and e2e runs keep their own suffix. Plain `pnpm dev` scopes its
profile by checkout-path hash, but all such worktrees share a single stable `dev` keychain suffix so
that a dev vault opened from a second worktree still finds the master key that bound its verifier.
When a local-only vault later signs up as the first sync device, device registration stores the
account master key and rebinds this verifier before the sync runtime activates. That keeps notes
created before sign-in on the same encrypted sync path instead of leaving the push queue without a
usable vault key.

## Secret Storage

Secrets (vault master key, sync keys, Google Calendar tokens, voice transcription and local agent
provider API keys, and the capture pairing token) are stored as Electron `safeStorage` ciphertext in
an atomically written `secure-secrets.json` under the app's user-data directory, keyed by the same
service and account strings the OS keychain used. The retired `keytar` module stays installed as a
read-only fallback: every read tries the safeStorage store first and falls back to the OS keychain
under the identical account.

A legacy secret migrates lazily on first read: encrypt, persist, decrypt round-trip verify
byte-identical against the source, and only then delete the OS keychain copy. Any verification
failure keeps the OS keychain authoritative. The vault master key goes one step further — its OS
keychain copy is only deleted after the retrieved key has passed the vault verifier check. Migration
is idempotent and crash-resumable: a crash between persist and delete is cleaned up on a later run,
and only while both copies still match.

Writes gate on `safeStorage.isEncryptionAvailable()` evaluated after app `ready`. On Linux, the
plaintext `basic_text` backend refuses migration entirely so secrets are never silently downgraded
out of the OS keyring. Plain `pnpm dev` worktrees also stay on the OS keychain: they share one `dev`
master key machine-globally while user data is per-worktree, so migrating would strand the shared
key for other worktrees.

Encryption and decryption prefer Electron's asynchronous safeStorage API
(`encryptStringAsync`/`decryptStringAsync`), gated on a single cached `isAsyncEncryptionAvailable()`
probe so concurrent startup reads share one lazy encryptor initialization. Ciphertext is
byte-identical between the sync and async APIs, so no store-format change or second migration is
involved; when the async surface is unavailable the store falls back to the synchronous calls, and
reads never rewrite stored ciphertext (`shouldReEncrypt` is ignored — every write re-encrypts
anyway).

## Nonces

All XChaCha20 operations use 24-byte random nonces from `sodium.randombytes_buf(24)` via a dedicated nonce utility (T029b). Nonces are stored alongside ciphertext.

## Constant-Time Comparisons

All authentication-sensitive comparisons use `sodium.memcmp` (T029c) to avoid timing leaks.

## Certificate Pinning

Packaged desktop builds pin sync TLS certificates by hostname. The default production sync host and
staging sync host each resolve to their own SPKI hash set, and hosts without configured pins are
allowed through the Electron verifier instead of being compared against an unrelated environment's
pins. Development builds keep pinning disabled so local sync servers and test certificates remain
usable.

## Tombstone Signing

The `deleted_at` field is included in the Ed25519-signed payload metadata. A hostile server cannot forge a deletion because it would lack the signing key.

## Argon2id Parameters

The spec called for `parallelism = 4`. libsodium pins parallelism to `1` and memrynote documents `1` as canonical. `memory_cost` and `time_cost` are tuned for interactive sign-in latency on the slowest supported hardware.

## Recovery Phrase

A list of words generated at vault creation. Words are derived from the same vault key entropy and can re-create the wrapping key without the passphrase. Stored only by the user (never in the cloud).

## Key Rotation

The rotation wizard:

1. Generates a new vault key.
2. Re-encrypts payloads under the new key (streamed, batched, resumable).
3. Reseals the new key for every linked device's public key.
4. Bumps the `crypto_version` so old ciphertexts are auditable.

When to rotate:

- Lost or stolen device that wasn't yet revoked
- Recovery phrase exposure
- Major OS or backup compromise

## What the Server Never Sees

- Note titles, content, properties, attachments
- Task fields, project names, statuses
- Tags, links, search queries
- Recovery phrase, passphrase, vault key

## Audit Surfaces

- `crypto_version` on every sync item enables post-hoc upgrades
- Ed25519 signatures over metadata catch tampering
- Content hashes catch silent corruption in R2

## Files Worth Knowing

```
apps/desktop/src/main/crypto/
├─ keys.ts               # master key derivation and vault key derivation
├─ vault-key-state.ts    # local vault key binding and verifier checks
├─ encrypt.ts            # AEAD wrapper
├─ sign.ts               # Ed25519 signing
├─ nonce.ts              # 24-byte random nonces (T029b)
└─ memcmp.ts             # constant-time compare (T029c)
```
