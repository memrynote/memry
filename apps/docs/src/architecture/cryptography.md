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

## Renderer Permission Policy

The desktop app registers deny-by-default permission handlers on the Electron session at startup,
covering both permission requests and permission checks. Grants are limited to the app's own pages
(packaged `file://` pages, the `memry-file://` asset scheme, and the localhost dev server in
development builds) and to the permissions the app actually uses: microphone capture for the voice
recorder (audio only — video capture is always denied), clipboard read for quick capture, sanitized
clipboard writes for copy actions, and HTML5 notifications for inbox reviews. Every other
permission (geolocation, camera, MIDI, fullscreen, and so on) and every request from embedded
external content such as YouTube iframes is denied.

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
