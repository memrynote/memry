# Security white paper

This paper describes how memrynote protects a user's notes, tasks and journal: what it encrypts,
which keys exist and where they live, what the sync server can see, and what memrynote does not
protect against. It is written for people who decide whether to trust the app, such as security
reviewers and privacy communities.

It describes the code on `main` as of 2026-11-17. The latest desktop release at that date is
`v2026-11-11`. Every statement about cryptography or the sync protocol cites the
[protocol specification][spec] or the code. Where the two disagree, `packages/contracts` is right
until the chapter is amended ([00][p00]). Line numbers drift as the code changes, so each citation
also names the function or constant it points at.

memrynote has had **no independent security audit**.

## Summary

- The vault is a folder of Markdown files on the user's own disk. The app reads and writes it
  offline and needs no account. Most of this paper applies only once the user turns on sync.
- Sync encrypts each record, note body update and attachment on the device with
  XChaCha20-Poly1305, under a random key per item. That key is wrapped under a vault key that only
  the user's devices hold. Each device signs what it uploads with its own Ed25519 key.
- The encryption keys come from a 24-word recovery phrase that the user keeps. The phrase becomes
  a master key through BIP39 and Argon2id on the device. The server never receives the phrase, and receives
  the master key only encrypted, while it relays it to a new device.
- The server stores ciphertext and the metadata it needs to route it. Some of that metadata is
  readable, such as tag names and folder paths.
  [What the server can see](#what-the-server-can-see) lists all of it.
- The design protects data on the server and in transit. It does not protect a device that is
  already compromised, and it does not hide metadata. [Known limitations](#known-limitations)
  lists the gaps.

## Threat model

### What memrynote protects

The content of the vault: note and journal bodies and titles, properties, tasks, projects,
attachments, canvases, settings that sync, and the names and icons of synced vaults.

### Who it protects against

- **The sync server and its operator.** That includes memrynote itself, the cloud provider that
  hosts the server (Cloudflare D1 for metadata, R2 for encrypted payloads), anyone who breaks into
  them, and anyone who can compel their operators to hand over data. They hold ciphertext and no
  keys.
- **The network.** Sync runs over TLS. Content is encrypted end to end inside TLS, so a party that
  can read the TLS traffic still sees ciphertext.

### What it trusts

- **The user's devices and their operating systems.** The keys and the plaintext vault live there.
- **The app build.** Releases are built by the project's CI (`.github/workflows/publish-release.yml`).
  Builds are not reproducible, so a user who installs a release trusts that it matches the public
  source.
- **The server, for availability and for the list of device keys.** The server can withhold data,
  and it is the directory that tells a device which signing keys belong to the account. See
  [Known limitations](#known-limitations).
- **The user's email account.** Signing in to the sync service takes an emailed code or Google
  sign-in. It gives access to ciphertext and metadata, not to content.

### Out of scope

- Malware or another person with access to an unlocked device.
- A stolen device without full-disk encryption. The vault is plain files.
- Traffic analysis, and inferences from the metadata the server keeps.
- The AI agent's model provider, when the user picks a cloud model. The agent then sends the notes
  it reads to that provider.

## Cryptographic primitives

Desktop uses libsodium (`libsodium-wrappers-sumo`). The Rust core in `crates/memry-core`, which the
iPhone app runs, implements the same formats and checks itself against the shared vectors in
`packages/contracts/test-vectors/`.

| Purpose                             | Primitive                                                    | Source                                                                            |
| ----------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Recovery phrase to seed             | BIP39, PBKDF2-HMAC-SHA512, 2048 iterations                   | [01 §1.1][p01], `mnemonicToSeed` in `apps/desktop/src/main/crypto/recovery.ts:15` |
| Seed to master key                  | Argon2id (`crypto_pwhash`), opslimit 3, memlimit 64 MiB      | [01 §1.1][p01], `ARGON2_PARAMS` in `packages/contracts/src/crypto.ts:28`          |
| Master key to subkeys               | BLAKE2b KDF (`crypto_kdf_derive_from_key`)                   | [01 §1.2][p01], `apps/desktop/src/main/crypto/keys.ts:43`                         |
| Content encryption and key wrapping | XChaCha20-Poly1305 (IETF), 24-byte random nonce, 16-byte tag | [04 §4.3][p04], `apps/desktop/src/main/crypto/encryption.ts:36`                   |
| Signatures                          | Ed25519, detached, over canonical CBOR                       | [04 §4.7, §4.8][p04]                                                              |
| Device linking key agreement        | X25519 (`crypto_scalarmult`)                                 | [03 §3.5][p03], `apps/desktop/src/main/crypto/keys.ts:165`                        |
| Device linking confirmation         | HMAC-SHA512-256 (`crypto_auth`) and a 6-digit code           | [03 §3.6, §3.7][p03]                                                              |

Nonces are random for every operation and never a counter ([04 §4.3][p04]).

## Keys

### From recovery phrase to master key

1. When a user creates a sync account, the device generates a 24-word BIP39 English phrase from
   256 random bits (`generateMnemonic(256)`, `apps/desktop/src/main/crypto/recovery.ts:14`). It
   shows the phrase once, holds it in memory until the user confirms it, and never stores or sends
   it (`apps/desktop/src/main/ipc/auth-device-handlers.ts:143`).
2. The phrase becomes a 64-byte seed through BIP39's PBKDF2-HMAC-SHA512 with 2048 iterations and
   no BIP39 passphrase ([01 §1.1, §1.3][p01]).
3. The seed becomes the 32-byte master key through Argon2id with opslimit 3, memlimit 64 MiB and a
   random 16-byte salt, `kdfSalt` ([01 §1.1][p01], `crypto_pwhash` in
   `apps/desktop/src/main/crypto/keys.ts:52`). The server stores the salt.

The phrase carries 256 bits of entropy, so Argon2id does not stand in for a weak password here.
memrynote has no account password.

### Subkeys

The master key is the root of every other key derived from the phrase. Subkeys come from
libsodium's BLAKE2b KDF with a fixed context per purpose ([01 §1.2][p01], `KDF_CONTEXT_MAP` in
`apps/desktop/src/main/crypto/keys.ts:22`):

| Subkey                 | Purpose                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------- |
| Vault key (id 1)       | Wraps the per-item keys of records, note body updates, attachments and vault names  |
| Key verifier (id 4)    | A value the server stores so a device can check that it holds the right key         |
| Linking keys (ids 5-7) | Derived from an X25519 shared secret during device linking, not from the master key |

One vault key serves every vault on an account ([01 §1.7][p01]). A ciphertext from one vault
therefore decrypts under another, and the client checks the vault from the request's routing
instead of relying on decryption to fail.

The account key verifier is the id 4 subkey, base64 encoded ([01 §1.4.1][p01]). A device compares
it with the server's copy to detect a wrong master key before it syncs. Learning the master key
from it would mean reversing the KDF, or guessing a 256-bit seed.

### Device keys

Each device creates a random Ed25519 key pair when it registers (`crypto_sign_keypair`,
`apps/desktop/src/main/crypto/keys.ts:83`). The pair is not derived from the master key, so a
device that loses it registers again ([01 §1.5][p01]). The server keeps every device's public key,
including revoked ones, so that older signatures still verify (`listDeviceSigningKeys` in
`apps/sync-server/src/services/device.ts:63`).

### Where keys live on a device

Desktop stores the master key, the device signing key and the session tokens as Electron
`safeStorage` ciphertext in the app's user-data directory. `safeStorage` encrypts with a key that
the operating system holds (the macOS Keychain, Windows DPAPI, the Linux Secret Service). On Linux,
desktop refuses to move secrets into `safeStorage` when its only backend is plain text
([Cryptography](/architecture/cryptography#secret-storage)). The iPhone app keeps its keys in the
iOS Keychain as `AfterFirstUnlockThisDeviceOnly` items ([02 §2.14][p02]).

The vault key is never stored. A device derives it from the master key when it needs it and holds
it in memory only ([01 §1.6][p01], `getOrDeriveVaultKey` in
`apps/desktop/src/main/crypto/keys.ts:126`).

## Accounts and sign-in

A user signs in with a 6-digit code sent by email or with Google ([02 §2.1, §2.11][p02]). The
server stores the code as an HMAC and accepts it for 10 minutes and 5 attempts. Sign-in yields a
single-use setup token, and the device registers by proving that it holds its new Ed25519 key
([02 §2.3][p02]). The device then gets a 15-minute access token (an EdDSA JWT) and a 7-day refresh
token that rotates on each use. Reusing an old refresh token revokes all of the device's tokens
([02 §2.2, §2.9][p02]).

Signing in gives a device access to the account's ciphertext and metadata. To read content, the
device also needs the master key, from another device or from the recovery phrase. The server
cannot reset or reissue the master key. It stores `kdfSalt` and the key verifier once, at account
setup, and has no route that changes them ([02 §2.8][p02]).

## Encrypting a record

Tasks, projects, note and journal metadata, tags, folders, settings and the other structured items
sync as records ([05][p05], [13][p13]). For each upload the device:

1. Serializes and compresses the record ([04 §4.1, §4.2][p04]).
2. Encrypts it with XChaCha20-Poly1305 under a fresh random 32-byte item key and a random nonce
   ([04 §4.3, §4.4][p04]).
3. Wraps the item key with XChaCha20-Poly1305 under the vault key, with its own nonce
   ([04 §4.4][p04]).
4. Signs a canonical CBOR map of the record's id, type, operation, crypto version, wrapped key,
   both nonces, ciphertext, deletion time and vector clock with the device's Ed25519 key
   ([04 §4.8][p04], `signaturePayload` in `apps/desktop/src/main/sync/encrypt.ts:61`).

Record content has no associated data. The signature is what binds a ciphertext to its id, type
and clock ([04 §4.3, §4.8][p04]).

The server checks the nonce and key lengths, a 5 MiB size limit, that the signing device exists and
is not revoked, and the signature, before it stores the record ([04 §4.10][p04]). A receiving device
verifies the signature before it unwraps the key ([04 §4.12][p04]).

## Encrypting note bodies

Note and journal bodies are Yjs documents (CRDTs) and sync as a stream of updates ([07][p07]). Each
update travels in a packed envelope with two nonces, the wrapped item key, an Ed25519 signature and
the compressed, encrypted update ([04 §4.11][p04]). The associated data is the note id, and the
signature covers the note id, the header and the ciphertext, so an update made for one note fails
verification on another ([04 §4.12][p04]). The server stores updates without checking their
signatures, and receiving devices check them ([07 §7.14][p07]).

Vault names and icons have their own small envelopes under the vault key, with associated data
that names the vault and the field ([04 §4.15, §4.16][p04]).

## Attachments

A file is split into 8 MiB chunks. Each chunk is encrypted under one random file key for that file
and stored under the SHA-256 of its ciphertext ([14 §14.2, §14.3][p14]). An encrypted, signed
manifest holds the file name, MIME type, size, checksum and chunk list, and wraps the file key
under the vault key ([14 §14.4][p14]). After decrypting, a device checks each chunk against a
plaintext hash from the manifest.

Two attachment details reach the server in plaintext. While an upload runs, the server records the
file's name and plaintext size in its upload session, and it drops that row when the upload
completes or after 24 hours (`upload_sessions` in `apps/sync-server/src/routes/blob.ts:320`).

## Linking a device

A new device needs the master key. It gets it from a device that already has it ([03][p03]):

1. The existing device starts a linking session. The server mints a 256-bit linking secret and
   stores only its SHA-256 hash. The existing device makes an ephemeral X25519 key pair and shows a
   QR code with the session id, its public key and the linking secret
   ([03 §3.3, §3.8][p03]). The session expires after 300 seconds ([03 §3.4][p03]).
2. The new device scans the code, makes its own ephemeral key pair and sends its public key through
   the server. Both devices compute a shared secret with X25519 and derive an encryption key, a MAC
   key and a 6-digit code from it ([03 §3.5, §3.6][p03]).
3. Both screens show the 6-digit code. The user compares them and approves on the existing device,
   which encrypts the master key under the linking encryption key and authenticates it with the MAC
   key. The new device checks the MAC before it decrypts ([03 §3.7, §3.9][p03]).

The QR code carries the existing device's public key out of band, so the server cannot replace it.
The new device's public key does pass through the server, and the server knows the linking secret
because it minted it. A server that swapped that key would make the two screens show different
codes, so the code comparison is the check against a server in the middle. The app does not ask
the user to type the code, so the check holds only if the user compares the two screens.

## Revoking a device

Revoking a device marks it revoked on the server and revokes its tokens
(`revokeDevice` in `apps/sync-server/src/services/device.ts:119`). The server then refuses its
requests and its uploads. Revoking changes no key. A revoked device that kept the master key can
still decrypt any ciphertext it holds or obtains, and signing in again with the account's email
registers it anew (the device upsert in `apps/sync-server/src/routes/auth.ts:633` clears
`revoked_at`).

## Recovery

A user who loses every device signs in with the emailed code and types the recovery phrase. The
device derives the master key and checks it against the server's key verifier before it syncs
([02 §2.7][p02], [01 §1.4.1][p01]). The server answers a recovery lookup for an unknown email with
plausible dummy values, so the lookup does not reveal which emails have accounts ([02 §2.7.1][p02]).

Without the phrase and without a linked device, the data on the server cannot be decrypted, by the
user or by memrynote. The phrase is the only input of the key chain ([01 §1.1][p01]).

## What the server can see

The server holds no key that decrypts content. It does store the following in plaintext.

**About the account and its devices** ([02][p02], `apps/sync-server/migrations/0001_baseline.sql`):

- The email address, the sign-in method and the Google account id when Google is used.
- `kdfSalt` and the account key verifier.
- The plan, billing ids from Paddle, storage used and the storage limit.
- For each device: its name (on desktop, the computer's hostname), platform, OS version, app
  version, public signing key, last sync time and whether it is revoked.

**About each synced item** ([04 §4.6][p04], [05][p05]):

- The item type, such as note, task, project, journal, tag definition, folder configuration or
  agent conversation (`SYNC_ITEM_TYPES` in `packages/contracts/src/sync-api.ts:7`).
- The item id. Notes and tasks have random ids. Some ids come from what the user typed: a journal
  entry's id is its date, a tag definition's id is the tag name, a folder configuration's id is the
  folder path, and a property definition's id is the property name ([05 §5.12.3][p05],
  `generateBlobKey` comment in `apps/sync-server/src/services/blob.ts:5`).
- The vault id, ciphertext size, creation and update times, operation, deletion time, vector clock
  (a counter per device), signing device and signature.
- For note bodies, the note id, a sequence number per update and the update times ([07][p07]).
- For attachments, the encrypted size and chunk count, and the file name and plaintext size during
  an upload ([Attachments](#attachments)).

**About activity:** when each device syncs, how much it writes, and the app version and platform
that wrote each item ([11][p11]). The server also sees the IP address of each request, and uses it
to apply rate limits.

A deleted item's payload is removed after the plan's history window, and the row that records the
deletion stays ([05 §5.12.3][p05]). Deleting the account removes the account's rows and stored payloads
(`apps/sync-server/src/services/account-deletion.ts`).

## Transport

The client talks to the server over HTTPS and a WebSocket over TLS ([00][p00], [09][p09]). Desktop
can pin certificates per host (`packages/sync-client/src/certificate-pins.ts`). The production
host, `sync.memrynote.com`, still has placeholder pins, so production connections get standard TLS
verification without pinning ([Cryptography](/architecture/cryptography#pin-activation-state)).

## Data on the device

The vault is a folder of plain Markdown files with YAML frontmatter, plus attachments and SQLite
databases in its `.memry` folder. memrynote does not encrypt them
([Local storage](/architecture/local-storage)). Their protection is the operating system's account
and disk encryption, such as FileVault or BitLocker. Agent Chat history is the one exception, and
desktop encrypts those rows under the vault key ([Cryptography](/architecture/cryptography)).

## Telemetry

The apps send anonymous usage events, on by default. Settings > General > Privacy turns them off
([Observability](/architecture/observability)). Desktop sends them to the sync server, which
replaces the install and account ids with HMAC-SHA256 values before it forwards them to PostHog
(`apps/sync-server/src/services/posthog-transform.ts`). Events carry the platform, app version,
locale and plan. They never carry note content, titles, item ids, search queries, tag names,
paths or file names, and the email address never reaches PostHog. PostHog sees the sync server's
address, not the user's.

When the app hits an error, it sends a diagnostic report with redacted log lines. Settings >
General > Privacy > "Automatically Send Error Reports" is on by default, and turning it off makes
the app ask first ([Observability](/architecture/observability)).

## The web account page

The account and billing pages on memrynote.com register a "web" device with its own Ed25519 key,
kept in the browser's local storage (`apps/landing/src/lib/account`). They call account and billing
routes. A web device never receives the master key and has no code that decrypts vault data, so it
cannot read notes.

## Known limitations

- **No independent audit.**
- **Metadata is visible.** [What the server can see](#what-the-server-can-see) lists it. Tag names,
  folder paths, property names and journal dates appear in item ids, and the item types show which
  features a user uses.
- **The server is the directory of device keys.** A device learns which signing keys belong to the
  account from the server (`GET /auth/devices`, [01 §1.4.0][p01]). There is no key transparency
  or cross-signing between devices. Signing in, which the server controls, is enough to register a
  device key. Without the vault key such a device cannot read or produce valid content.
- **The server can withhold or delay data.** A device notices a gap in note body updates as a sync
  that stops advancing, but "a server that withholds updates indefinitely is indistinguishable from
  a server that has none" ([07 §7.14][p07]).
- **No key rotation.** The vault key derives from the recovery phrase, and no code re-encrypts
  existing data under a new key. A leaked phrase stays valid for that account. Revoking a device does not
  change any key ([Revoking a device](#revoking-a-device)).
- **No forward secrecy for stored data.** Whoever gets the master key can decrypt every item the
  account has stored, past and present.
- **Compression before encryption.** Ciphertext length follows the compressed length of the
  content. The specification records this as an accepted trade ([04 §4.2][p04]).
- **The device check during linking depends on the user** comparing two 6-digit codes
  ([Linking a device](#linking-a-device)).
- **No certificate pinning in production** ([Transport](#transport)).
- **The vault on disk is not encrypted** ([Data on the device](#data-on-the-device)).
- **Telemetry and diagnostics are on by default** ([Telemetry](#telemetry)).

## Audit status

No independent firm has audited memrynote. What a reviewer can check today:

- The source of every client and of the sync server is public under AGPL-3.0 at
  [github.com/memrynote/memry](https://github.com/memrynote/memry).
- The sync protocol is specified in [`docs/protocol/`][spec], with a `path:line` citation for
  every normative sentence.
- Conformance vectors in `packages/contracts/test-vectors/` pin the key derivation, the envelopes,
  canonical CBOR and the signatures. The TypeScript and Rust implementations both run them.

Report a vulnerability to security@memrynote.com or through GitHub private vulnerability reporting,
as [SECURITY.md](https://github.com/memrynote/memry/blob/main/SECURITY.md) describes.

[spec]: https://github.com/memrynote/memry/tree/main/docs/protocol
[p00]: https://github.com/memrynote/memry/blob/main/docs/protocol/00-overview-and-versioning.md
[p01]: https://github.com/memrynote/memry/blob/main/docs/protocol/01-identity-and-keys.md
[p02]: https://github.com/memrynote/memry/blob/main/docs/protocol/02-auth-and-sessions.md
[p03]: https://github.com/memrynote/memry/blob/main/docs/protocol/03-device-linking.md
[p04]: https://github.com/memrynote/memry/blob/main/docs/protocol/04-record-envelope.md
[p05]: https://github.com/memrynote/memry/blob/main/docs/protocol/05-record-sync.md
[p07]: https://github.com/memrynote/memry/blob/main/docs/protocol/07-crdt-updates.md
[p09]: https://github.com/memrynote/memry/blob/main/docs/protocol/09-realtime.md
[p11]: https://github.com/memrynote/memry/blob/main/docs/protocol/11-client-policy.md
[p13]: https://github.com/memrynote/memry/blob/main/docs/protocol/13-payload-schemas.md
[p14]: https://github.com/memrynote/memry/blob/main/docs/protocol/14-attachments.md
