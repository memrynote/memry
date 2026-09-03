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
master key that produced it. If that verifier exists and the keychain key is missing, encrypted
surfaces fail closed instead of silently creating a replacement key. First-device setup and recovery
relinking rebind this local verifier immediately after the new master key is saved, before sync
activation. If the verifier cannot be checked at startup, the sync
runtime stays offline instead of starting queues, CRDT seeding, or snapshot uploads with missing
vault-key credentials.

### A verifier that arrived from another machine

A vault folder is portable: people move it between machines with git, iCloud Drive or Dropbox. The
verifier travels inside `<vault>/.memry/data.db`, but the keychain master key that produced it does
not — so a moved vault routinely opens against a key that never wrote it. Failing closed there would
disable every key-bound surface on a vault whose notes, journals, tasks and canvases all open fine.

A verifier mismatch is therefore resolved rather than always refused:

| Device state                               | Outcome                                                                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| No account on this device                  | Rebind. There is no recovery phrase to re-derive the key that sealed the existing rows, so they are unrecoverable by definition.               |
| Account confirms the local key (`match`)   | Rebind. The vault's verifier is the stale one — it arrived from another machine, or a re-link rebound only the vault that happened to be open. |
| Account says the key is wrong (`mismatch`) | Fail, and raise the vault recovery prompt so the recovery phrase can restore the correct key — which also restores the encrypted rows.         |
| `transition` or `unknown`                  | Fail. Never rebind on an uncertain read.                                                                                                       |

The account check lives behind a port that the sync layer injects at startup, keeping `crypto/` free
of `sync/` imports; its default verdict is `unknown`, so an unwired caller can only be conservative.
A rebind does not count as passing the verifier check, so it never completes the master key's
safeStorage migration — the OS keychain copy survives.

The keychain account is suffixed per device: production installs use the bare account, while
explicit dev profiles (`A`/`B`/`C`) and e2e runs keep their own suffix. Plain `pnpm dev` scopes its
profile by checkout-path hash, but all such worktrees share a single stable `dev` keychain suffix so
that a dev vault opened from a second worktree still finds the master key that bound its verifier.
When a local-only vault later signs up as the first sync device, device registration stores the
account master key and rebinds this verifier before the sync runtime activates. That keeps notes
created before sign-in on the same encrypted sync path instead of leaving the push queue without a
usable vault key.

**That rebind replaces the vault key**, so anything encrypted at rest under the old one stops
opening. This is why canvases are plain `.excalidraw` files in the vault rather than an encrypted
column — see [Canvas Files](/architecture/local-storage#canvas-files). Agent chat is the remaining
at-rest surface: it is deliberately cleared on rebind rather than left undecryptable. Before adding
any new at-rest-encrypted store, assume the vault key will change under it and say what happens to
the data when it does.

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

An unreadable secret is never reported as absent. `getSecret()` throws when a ciphertext exists in
the store but cannot be decrypted this run, because the callers that act on a `null` are destructive:
they regenerate the vault master key or tear down local sync state.

The one exception is explicit and per-call. `getSecret(service, account, { treatUnreadableAsAbsent:
true })` returns `null` instead, and is used only where a false absence cannot lose anything because
the entry is immediately overwritten, immediately deleted, or only used to answer "is this account
still connected": the Google Calendar keychain, the capture pairing token, and the OneNote auth
store. Without it those flows could not recover at all — a re-connect reads the existing tokens
before it writes the fresh ones, so a throw killed the flow before the write and the undecryptable
entry could never be replaced. Every other caller, the master key included, keeps the guard armed.
Each opt-in read that hits an unreadable entry is logged at `warn` so the affected population stays
visible. Relatedly, an `integrity`
teardown — which `checkSyncIntegrity()` triggers from a single failed device-signing-key read — clears
the session tokens and the signing key but **never the vault master key**. That key cannot be
re-issued by signing in again, so it is not collateral for another entry's absence; only an explicit
sign-out clears it.

## Runtime Identity and the safeStorage Key

On macOS the `safeStorage` encryption key is not stored with the app — it lives in a login-keychain
generic password that Chromium derives entirely from `app.getName()`: service `<name> Safe Storage`,
account `<name> Key`. The ` Key` suffix comes from Electron's own Chromium patch
(`kAccountNameSuffix`; MAS builds use ` App Store Key`), not from Electron's C++, which sets only the
service suffix. **Changing the app name therefore changes which key decrypts `secure-secrets.json`.**

Because of that, the app name and the user-data path are independent levers and are resolved
separately in `app-identity.ts`, synchronously at module load — before `ready`, and before a headless
`--cli` launch can touch safeStorage:

- **Path.** `userData` always ends up at `<appData>/memrynote`, with a compatibility symlink left at
  the legacy `@memry/desktop` path. A directory is only treated as an existing profile when it holds
  something other than `logs/`, because on Windows and Linux the log directory is nested inside
  `userData` and is created unconditionally after the identity decision.
- **Name.** Derived per install from the filesystem alone and then pinned in `app-identity.json`
  inside the profile. A profile whose secret store predates the rename keeps `@memry/desktop`
  permanently; a profile born under the new name keeps `memrynote`. Windows is always `memrynote`
  (DPAPI is not keyed by app name), and Linux keeps the legacy name whenever a store exists.

The derivation touches **zero keychain items** — only Chromium ever reads or writes its own Safe
Storage entry. A store's location never proved which key encrypted it, so after `ready` a probe
(`probeSecretStoreIdentity()`) answers that by decrypting: the master-key entry dominates the verdict,
and a decrypt that yields non-printable bytes does not count as readable, since Chromium's macOS
OSCrypt is unauthenticated AES-CBC and the wrong key still "succeeds" on padding luck. On a mismatch
the other identity is pinned for the next launch — at most one flip, so it always converges — rather
than relaunching mid-startup. The probe reads the store file directly and never moves an unparseable
store aside, which would turn "unreadable" into "absent".

## Vault-Key Mismatch Detection

The per-vault verifier only proves self-consistency — a freshly provisioned vault binds whatever
master key the keychain currently holds, even a wrong one. The account-level check closes that gap:
the account's key verifier (a non-secret KDF-derived check value, the same one `/auth/setup`
registers) is cached locally at sign-in/recovery/linking and fetched from `GET /auth/key-verifier`
(access-token auth) when no local copy exists.

`checkLocalKeyAgainstAccount()` compares the verifier derived from the keychain master key against
the account verifier and returns one of four verdicts: `match` (safe to sync), `mismatch` (this key
can never decrypt the account's data), `transition` (a sign-in/recovery/linking flow is
re-establishing key material right now — armed when `persistKeysAndRegisterDevice` starts and
lifted the moment the flow finalizes, so sync can start immediately after sign-in; a ~2-minute
timer backstops flows that abort mid-way), or `unknown` (offline with no cached verifier, no
session, or an unreadable keychain — never classified destructively).

The check runs at three points: the startup integrity check, sync-runtime start, and any pull page
where every item fails to decrypt or verify. Only a **confirmed mismatch** acts: sync is blocked, a
`vault-recovery-needed` event prompts the recovery flow, and at startup the session is torn down so
ordinary sign-in + recovery phrase restores the correct key. A confirmed mismatch during pull stops
the cycle without quarantining items or marking them corrupt — those side effects would outlive the
key problem. When recovery rebinds the vault to a new key, the pull cursor and persisted quarantine
state are purged so the corrected key starts from a clean slate.

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

Both pinned surfaces — the Electron session verifier and the `https.Agent` the sync WebSocket
connects through — resolve pins from the hostname the connection is actually dialing, at handshake
time. Neither consults the configured `SYNC_SERVER_URL` host to decide whether to pin, so the host
being verified is always the host whose pins were looked up.

### Pin activation state

A host entry in `certificate-pins.ts` may hold placeholder hashes, which means pinning has not been
activated for that host yet. This is a supported state, not a broken one: the runtime falls back to
standard TLS verification for placeholder pins rather than failing the connection. A host with no
entry at all is treated the same way at runtime — pinning was never activated for it, so standard
TLS applies. Standard TLS here still means full CA-chain validation plus hostname verification; only
the extra SPKI pin comparison is absent. A missing entry is caught at build time instead, where
`pnpm cert:check` fails.

`pnpm cert:check` (also run by `prebuild` and `build:release`) audits the configured host and
reflects the same rule:

| Host pin state                                     | Result                               |
| -------------------------------------------------- | ------------------------------------ |
| Real SPKI hashes                                   | passes                               |
| Placeholder hashes                                 | warns — build proceeds with TLS only |
| Placeholder hashes with `MEMRY_CERT_PINS_STRICT=1` | fails                                |
| No entry for the host, or a malformed pin          | fails                                |

### Which host the check audits

The host is resolved from the same file a packaged build ships: `apps/desktop/.env.<MEMRY_ENV>`
(`.env.production` when `MEMRY_ENV` is unset, which is how `prebuild` and `build:release` run it).
That file is staged into the app as `app-config` and is what the shipped app dials, so the audit and
the build agree on one host. An explicit `SYNC_SERVER_URL` in the environment overrides the file, for
auditing a host ad hoc. With neither present — a fresh checkout or CI, where no `.env` file exists —
the check audits the default production host and prints that it is doing so, rather than appearing to
have checked the build's host.

The first line of output always names the audited host and where it came from:

```
Auditing sync host sync.memrynote.com from apps/desktop/.env.production.
```

To activate pinning for a host, run `pnpm cert:extract -- <hostname>`, replace that host's
placeholders with the emitted hashes (keep a backup pin for rotation), and set
`MEMRY_CERT_PINS_STRICT=1` so the host can never silently regress to unpinned. Strict mode is
opt-in and can be set either in the environment or in the same `.env.<MEMRY_ENV>` file that names the
host. It is deliberately off by default: the production host still carries placeholder pins, so
enabling it globally would fail every `prebuild` and every fresh checkout.

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
