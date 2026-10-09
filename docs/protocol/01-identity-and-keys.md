# 01 — Identity and keys

**Status**: normative. Every normative sentence carries a `path:line` citation
(chapter 00 §0.1).

This chapter specifies how a user's recovery phrase becomes every key in the
system, what a device's identity is, and what a conforming client stores.

## 1.1 The key chain

**Normative.** Three steps, in order. Nothing else derives a master key.

| Step                | Input                          | Function                                                                 | Parameters                                                                                                 | Output   |
| ------------------- | ------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | -------- |
| phrase → seed       | 24-word BIP39 English mnemonic | `bip39.mnemonicToSeed` (`apps/desktop/src/main/crypto/recovery.ts:23`)   | PBKDF2-HMAC-SHA512, **2048** iterations, salt the literal ASCII string `mnemonic`, **no** BIP39 passphrase | 64 bytes |
| seed → master key   | the 64-byte seed               | `crypto_pwhash` (`apps/desktop/src/main/crypto/keys.ts:49-56`)           | `crypto_pwhash_ALG_ARGON2ID13`, opslimit **3**, memlimit **67108864**, 16-byte salt                        | 32 bytes |
| master key → subkey | the 32-byte master key         | `crypto_kdf_derive_from_key` (`apps/desktop/src/main/crypto/keys.ts:40`) | see §1.2                                                                                                   | 32 bytes |

Parameter constants: `ARGON2_PARAMS.OPS_LIMIT = 3`,
`ARGON2_PARAMS.MEMORY_LIMIT = 67108864`, `ARGON2_PARAMS.SALT_LENGTH = 16`
(`packages/contracts/src/crypto.ts:28-32`).

**Argon2id parallelism is never passed.** libsodium's `crypto_pwhash` uses
parallelism 1 internally and that is the canonical value for this protocol
(`packages/contracts/src/crypto.ts:25-27`). A Rust implementation MUST use
parallelism 1, not the 4 some prose elsewhere mentions.

`kdfSalt` is 16 random bytes (`apps/desktop/src/main/crypto/keys.ts:119-121`)
transported as base64 with the **standard** alphabet and padding
(`sodium.base64_variants.ORIGINAL`, `apps/desktop/src/main/crypto/keys.ts:65`).

## 1.2 The KDF context table

**Normative**, verbatim from `apps/desktop/src/main/crypto/keys.ts:19-27`. The
logical context string is a lookup key; the eight-byte value handed to libsodium
is the `ctx` column. All seven subkeys are 32 bytes.

| Logical context         | libsodium `ctx` | subkey id | Used for                             |
| ----------------------- | --------------- | --------: | ------------------------------------ |
| `memry-vault-key-v1`    | `memryvlt`      |         1 | the vault key                        |
| `memry-signing-key-v1`  | `memrysgn`      |         2 | **reserved**, see §1.2.1             |
| `memry-verify-key-v1`   | `memryvrf`      |         3 | **reserved**, see §1.2.1             |
| `memry-key-verifier-v1` | `memrykve`      |         4 | the account key verifier             |
| `memry-linking-enc-v1`  | `memrylnk`      |         5 | linking transport key (chapter 03)   |
| `memry-linking-mac-v1`  | `memrymac`      |         6 | linking MAC key (chapter 03)         |
| `memry-linking-sas-v1`  | `memrysas`      |         7 | short verification code (chapter 03) |

Three of the logical names are also declared in contracts:
`KEY_DERIVATION_CONTEXTS.VAULT_KEY` and `.KEY_VERIFIER`
(`packages/contracts/src/crypto.ts:20-23`), and the three
`LINKING_HKDF_CONTEXTS` (`packages/contracts/src/crypto.ts:55-59`). The mapping
from logical name to `ctx` and id exists only in the two implementation copies,
`apps/desktop/src/main/crypto/keys.ts:19-27` and
`crates/memry-core/src/crypto/keys.rs:55-91`, and in the vector fixture table
(`packages/contracts/scripts/vector-fixtures.ts:18-19`). A conforming client
MUST reproduce all seven rows exactly; they are pinned as vectors under
`kdfDeriveFromKey` in `packages/contracts/test-vectors/crypto-vectors.json`.

**"HKDF" in older prose means this**: libsodium's BLAKE2b-based
`crypto_kdf_derive_from_key`, **not** HKDF-SHA256
(`packages/contracts/src/crypto.ts:53-54`).

### 1.2.1 Subkey ids 2 and 3 — Q01.1

`memry-signing-key-v1` (id 2) and `memry-verify-key-v1` (id 3) have **no
production caller anywhere in the tree**. The only references are the two
implementation maps and the committed vectors
(`packages/contracts/test-vectors/crypto-vectors.json:77`, `:85`). The
device signing key is a random Ed25519 pair, not a derived one (§1.5), so
nothing needs them.

**Normative — they are reserved, not dead.** A conforming client MAY omit the
derivation. A conforming client MUST NOT reuse subkey id 2 or id 3, or the
context strings `memrysgn` and `memryvrf`, for any other purpose. Both remain in
the vector set so that a future user of either id is forced to change a
committed vector and therefore this chapter (chapter 00 §0.8, obligation 3).

**Disposition of Q01.1: answered** (this section).

## 1.3 Recovery phrase normalisation — Q01.2

**Normative.** Before `validateMnemonic` and before `mnemonicToSeed`, a client
MUST apply these five steps, in this order:

1. NFKD-normalise;
2. trim leading and trailing whitespace;
3. collapse every run of whitespace to a single U+0020;
4. lowercase;
5. reject unless the result is a valid **24-word English** BIP39 mnemonic with a
   correct checksum.

`mnemonicToSeed` MUST then run with an **empty** passphrase: PBKDF2-HMAC-SHA512,
c=2048, dkLen=64, salt the literal ASCII `mnemonic`. Seed derivation MUST NOT run
on a phrase that failed validation.

The BIP39 library layer supplies only step 1 — `bip39@3.1.0`'s
`normalize(str) = str.normalize('NFKD')`, matched by `@scure/bip39@2.3.0`.
Memry's application layer supplies the other four:
`apps/desktop/src/renderer/src/components/sync/recovery-phrase-input.tsx:59`
(`phrase.trim().toLowerCase().replace(/\s+/g, ' ')`) and
`crates/memry-core/src/crypto/recovery.rs:34-42`. Validation gates derivation on both:
desktop `apps/desktop/src/main/ipc/auth-device-handlers.ts:428` precedes `:452`, and the
core's `phrase_to_seed` validates first (`crates/memry-core/src/crypto/recovery.rs:100-104`).

**Mandating this changes no existing phrase.** Every master key in existence was
derived from a canonical phrase: at creation the seed comes straight from
`generateMnemonic(256)` output
(`apps/desktop/src/main/crypto/recovery.ts:11-12`), canonical by construction; at
recovery both shipped clients canonicalise first. The English wordlist is
lowercase ASCII, so steps 2 to 4 are the identity on a canonical phrase. A
non-canonical phrase is rejected by the case-sensitive, single-space
`validateMnemonic` before any seed exists
(`apps/desktop/src/main/crypto/recovery.ts:18-20`).

**Two implementation traps a second implementation MUST handle.**

- JavaScript's `\s` is Unicode `White_Space` **plus U+FEFF**; Rust's
  `char::is_whitespace` is `White_Space` **without** it. Define the whitespace
  class as "`White_Space` or U+FEFF", or strip U+FEFF explicitly.
- Lowercase **ASCII only**, then reject any non-ASCII byte. A Unicode lowercase
  pass invites locale surprises and buys nothing: no non-ASCII phrase survives
  validation.

**Wrong word order needs no special handling.** The BIP39 checksum catches a
reordering with probability 255/256, and the residual 1/256 reaches Argon2id and
fails the account key verifier
(`apps/desktop/src/main/ipc/auth-device-handlers.ts:450`). Nothing is persisted
before the verifier passes.

**Disposition of Q01.2: answered** (this section).

## 1.4 The two verifiers

There are two verifiers and they MUST NOT be confused.

### 1.4.0 Where a client gets a peer's public key

**Normative.** Chapter 04 §4.8 has the verifier "resolve a public key by
`signerDeviceId`", which presumes a directory that no chapter named.

It is **`GET /auth/devices`**. The response's `devices[]` each carry
`signingPublicKey` — the same Ed25519 key the device committed at registration
(chapter 02 §2.3) — alongside the device id, whose field is spelled `id`. The
full shape is in chapter 02 §2.1.1. That list is the only source; a
client caches it, and a `signerDeviceId` it cannot resolve means refetching the
list before treating the record as unverifiable.

A record whose signer cannot be resolved is **unverified, not invalid**: it is
recorded as unapplied rather than dropped, because a device registered after
this client last fetched the list is the ordinary case, not an attack.

**It is therefore its own outcome, not a signature failure.** A client MUST NOT
report an unresolvable signer as `signature-invalid` (chapter 04 §4.11.1): that
code means the bytes were tampered with, and using it here would turn "we have
not refetched the device list yet" into a security incident in the logs, and
would tell a user their data is corrupt when it is merely new.

### 1.4.1 Account key verifier (server-visible)

**Normative.** The account key verifier is literally

```
base64_standard( crypto_kdf_derive_from_key(32, 4, "memrykve", masterKey) )
```

with **no hash wrapper** (`apps/desktop/src/main/crypto/keys.ts:110-117`). It is
served by `GET /auth/recovery-info` and `GET /auth/key-verifier` (chapter 02).

**Comparison is over the base64 _strings_ re-encoded as UTF-8, not over the
decoded bytes** (`apps/desktop/src/main/crypto/recovery.ts:48-55`): both sides
are `TextEncoder().encode(...)`d, lengths compared first, then `sodium.memcmp`.
A Rust implementation that compares decoded bytes accepts every correct input and
fails to reject some incorrect ones, because two distinct base64 spellings can
decode to the same bytes. Reproduce the string comparison.

### 1.4.2 Local vault key verifier (never leaves the device)

**Normative.**

```
base64_standard( crypto_generichash(32, utf8("memry/vault-key-verifier/v1/" + vaultId), key = vaultKey) )
```

— a keyed BLAKE2b-256 whose **key** is the vault key and whose **message** is the
context string with the vault id appended
(`apps/desktop/src/main/crypto/vault-key-state.ts:16-20`). Stored in the local
settings table under `vault.crypto.verifier.v1`
(`apps/desktop/src/main/crypto/vault-key-state.ts:14`). It MUST NOT be sent to
the server.

A change in this value means the vault key changed; desktop then purges
key-scoped sync state so a stale cursor cannot skip items
(`apps/desktop/src/main/crypto/vault-key-state.ts:44-55`).

## 1.5 Device identity

**Normative.** There are two device identity values and only one goes on the
wire.

- **Locally derived device id**:
  `hex(crypto_generichash(16, ed25519PublicKey, key = null))`, 32 lowercase hex
  characters (`apps/desktop/src/main/crypto/keys.ts:81`, recomputed from a stored
  secret key at `:103`). Pinned as `ed25519.deviceIdHex` in
  `packages/contracts/test-vectors/crypto-vectors.json`.
- **Server-assigned device id**: the `deviceId` returned by
  `POST /auth/devices` (`apps/desktop/src/main/sync/device-registration.ts:84`),
  stored at `:201` and used as the device's identity thereafter (`:189`, `:235`).

**A conforming client stores and sends the server-assigned id.** It is what
travels as `signerDeviceId` on a record envelope (chapter 04) and as the clock
key in a vector clock (chapter 06). The locally derived id is computed at
registration time and is not the wire identity.

**The device signing key is random, not derived.** `crypto_sign_keypair()`
(`apps/desktop/src/main/crypto/keys.ts:80`) — it comes from neither the master
key nor the seed, so a device that loses its keychain cannot recreate it and
MUST register anew. Lengths (`packages/contracts/src/crypto.ts:40-45`): seed 32,
public key 32, secret key 64, signature 64. The public key travels as standard
base64 in `authPublicKey`
(`apps/desktop/src/main/sync/device-registration.ts:75`).

## 1.6 What a client stores — Q01.3

**Normative.** A conforming client stores the 32-byte **master key**, one per
account, in device secure storage, and **MUST NOT persist the vault key**. The
vault key is derived on demand and held in memory only.

Desktop does exactly this: `KEYCHAIN_ENTRIES.MASTER_KEY`
(`packages/contracts/src/crypto.ts:71`) is written at
`apps/desktop/src/main/sync/device-registration.ts:146`, and the vault key is
derived per use and zeroed
(`apps/desktop/src/main/crypto/keys.ts:123-137`).

The master key, not the vault key, is what a second device needs: approving
another device's link (chapter 03), recomputing the account key verifier to
detect a mismatch (§1.4.1), and binding the local vault key verifier
(`apps/desktop/src/main/crypto/vault-key-state.ts:32-40`). A vault-key-only
client can do none of these and cannot re-derive anything if a new subkey id is
ever introduced (§1.2.1). Deriving the vault key costs one BLAKE2b KDF call, not
an Argon2id pass, so there is no performance argument for caching it.

**Disposition of Q01.3: answered** (this section).

## 1.7 One vault key per account — Q01.4

**Normative.**

```
vaultKey := crypto_kdf_derive_from_key(32, 1, "memryvlt", masterKey)
```

No vault id and no other per-vault input enters the derivation. A conforming
client **MUST NOT** mix `vaultId` into the vault key. `vaultId` MAY be mixed into
a **local** verifier only (§1.4.2). Separation between vaults is server routing
plus item ids, nothing else.

Every derivation site passes the same fixed context:
`apps/desktop/src/main/crypto/keys.ts:130`,
`apps/desktop/src/main/crypto/vault-key-state.ts:39`, and the core's
`crates/memry-core/src/crypto/keys.rs:138`. Exactly one `MASTER_KEY` keychain entry
exists per account (`packages/contracts/src/crypto.ts:71`).

**Security-critical consequence.** Because all vaults on an account share one
key, **a ciphertext from vault A decrypts cleanly under vault B**. A conforming
client **MUST NOT rely on decryption failure to detect a mis-routed record**.
Vault association is a routing fact carried outside the ciphertext — the
`X-Memry-Vault-Id` header and the route parameter
(`apps/sync-server/src/routes/sync.ts:79`) — and MUST be checked explicitly.

FR-021 therefore holds with no extra key exchange: a client holding the master
key can open every vault on the account, and choosing one is
`GET /sync/vaults` plus routing. There is no per-vault keychain entry.

**Disposition of Q01.4: answered** (this section).

## 1.8 Secret storage

**Normative.** Five keychain entries, all under service `com.memry.sync`
(`packages/contracts/src/crypto.ts:70-76`):

| Entry                | Account              | Value                          |
| -------------------- | -------------------- | ------------------------------ |
| `MASTER_KEY`         | `master-key`         | 32 raw bytes                   |
| `DEVICE_SIGNING_KEY` | `device-signing-key` | the 64-byte Ed25519 secret key |
| `ACCESS_TOKEN`       | `access-token`       | the JWT, UTF-8 encoded         |
| `REFRESH_TOKEN`      | `refresh-token`      | the token, UTF-8 encoded       |
| `SETUP_TOKEN`        | `setup-token`        | the token, UTF-8 encoded       |

Tokens are UTF-8 encoded on the way in and decoded on the way out
(`apps/desktop/src/main/sync/token-manager.ts:49-63`).

Desktop appends a `-<device>` suffix to the account name in development
(`apps/desktop/src/main/crypto/keychain-account.ts:26-32`). **That suffix is a
development affordance and is not part of the protocol**; a conforming client
MUST NOT reproduce it.

## 1.9 Identifier formats

**Normative** (`apps/desktop/src/main/lib/id.ts:13-49`):

| Kind                            | Format                       | Validator                        |
| ------------------------------- | ---------------------------- | -------------------------------- |
| note id                         | 12 characters from `0-9a-z`  | `/^[0-9a-z]{12}$/` (`:33`)       |
| journal id                      | `j` followed by `YYYY-MM-DD` | `/^j\d{4}-\d{2}-\d{2}$/` (`:49`) |
| general id (tasks, projects, …) | 21-character nanoid          | `/^[A-Za-z0-9_-]{21}$/` (`:41`)  |

The server is looser: `NoteIdSchema` is `/^[a-zA-Z0-9_-]+$/` capped at 128
characters (`apps/sync-server/src/routes/sync.ts:571-574`), which both a note id
and a journal id satisfy.

**Journal ids are the only deterministically generated ids in the product**
(`apps/desktop/src/main/lib/id.ts:20`). That is why a legacy CRDT store can hold
one journal document per day merged across vaults
(`apps/desktop/src/main/sync/crdt-legacy-partition.ts:19-32`), and it is why
chapter 07 forbids deriving a journal's document id from its date when a record
carries one.

### 1.9.1 One journal item per day (#2939)

**Normative.** A day `D` has exactly one journal item, `j<D>`. Any other
journal id whose payload carries date `D` is **foreign**. A client MUST NOT
project a foreign id as a row. It merges the foreign item's body into `j<D>`,
pushes `j<D>`, and tombstones the foreign id.

Desktop builds before this rule gave a day file added outside the app a note
id (the watcher and the indexer minted one) and pushed it as a `journal`
create. Applying such an item where `j<D>` already held the day failed on the
day's unique path or date on every pull: desktop deferred it forever, and the
core recorded it corrupt.

**Minting.** A markdown file new to the vault whose path is a journal day gets
`j<D>`, never a note id
(`apps/desktop/src/main/database/queries/notes/journal-queries.ts:71-74`, used
by `apps/desktop/src/main/vault/watcher.ts:623` and
`apps/desktop/src/main/vault/indexer.ts:227`).

**Apply.** The decision is a pure function of the incoming id, its date, and
the id of the local row holding that day, if any
(`packages/domain-notes/src/journal/day-identity.ts:26-37`, ported as
`crates/memry-core/src/domain/journal_rules/day_identity.rs:22`). The `dayIdentity` section of the `journal` vector class pins it.

| Incoming    | Local holder   | Action                                                                                         |
| ----------- | -------------- | ---------------------------------------------------------------------------------------------- |
| `j<D>`      | none or `j<D>` | ordinary apply                                                                                 |
| `j<D>`      | foreign `H`    | owe merge of `H`; remove `H`'s row, keep its body; apply `j<D>`                                |
| foreign `X` | anything       | owe merge of `X` (and of a foreign holder); apply nothing; the outcome is skipped, not corrupt |

An owed merge records the foreign id, `D`, and the foreign item's clock, which
the tombstone must exceed. Desktop keeps it in `sync_state` and declines the
ref so the manifest check does not count the unprojected id as server-only
(`apps/desktop/src/main/sync/item-handlers/journal-handler.ts:69-92`,
`apps/desktop/src/main/sync/journal-day-merge.ts:54-63`). The core keeps it in
`meta` under `journal.day_merge:<id>` (`crates/memry-core/src/sync/apply.rs:392`,
`crates/memry-core/src/sync/journal_day_merge.rs:180`).

**Merge.** After a pull run's body pass, each owed merge `F -> D` runs until it
settles (`apps/desktop/src/main/sync/engine/pull-coordinator.ts:189`,
`apps/desktop/src/main/sync/engine/crdt-sync-coordinator.ts:486-493`,
`apps/desktop/src/main/sync/journal-day-merge.ts:135-166`; core:
`crates/memry-core/src/api/sync/pass.rs:135`, `crates/memry-core/src/sync/journal_day_merge.rs:246`). The core
drains only in its steady-state pass; a first sync records owed merges and the
next pass settles them.

1. Create `j<D>` empty through the normal create path if no row holds it.
2. Pull `F`'s server body. If it is not fully merged, `F` stays owed.
3. Apply `F`'s whole Yjs state to `j<D>`'s doc as a local edit, so it is
   stored, written back and pushed as a CRDT update for `j<D>`
   (`apps/desktop/src/main/sync/crdt-provider.ts:1552-1579`; core:
   `crates/memry-core/src/sync/journal_day_merge.rs:407-414`).
4. Point task links at `F` to `j<D>`
   (`apps/desktop/src/main/notes/runtime-effects.ts:125-131`; core: `crates/memry-core/src/sync/journal_day_merge.rs:401`).
5. Queue `F`'s tombstone with clock `increment(F.clock, self)`, purge `F`'s
   local doc, and drop the owed merge (core: `crates/memry-core/src/sync/journal_day_merge.rs:419`, `:488`).

A tombstone for an owed `F` means another device merged it. The client marks
the merge deleted (`apps/desktop/src/main/sync/item-handlers/journal-handler.ts:175`,
`apps/desktop/src/main/sync/journal-day-merge.ts:70-77`; core:
`crates/memry-core/src/sync/apply.rs:253`, `:317`, `crates/memry-core/src/sync/journal_day_merge.rs:173`), folds in only what it
holds of `F`'s body, queues no tombstone, and settles even when that body is
empty.

Every step converges when repeated after a crash. Two devices merging the same
`F` at once integrate the same Yjs items, identified by `(clientID, clock)`, so
`j<D>` holds `F`'s text once after they exchange updates. `j<D>` is never
seeded from `F`'s markdown, which would mint new items on each device. Both
tombstones are deletes, and §5.7 either accepts or refuses the second; `F`
stays deleted either way. A build still editing `F` after its tombstone gets
§5.8's delete-wins answer, and what it typed before the merge is already in
`j<D>`. Both devices relink a task to the same list, so the field merge
converges.

A live `F` with no Yjs body stays owed. Its record's `content` is not merged, because
every device holds it and each would mint its own items. The one exception is
desktop's local holder: when `j<D>` takes the day from a foreign row on this
device, desktop keeps the day file's text, and if that row's doc is empty it
builds the doc from the text before merging
(`apps/desktop/src/main/sync/item-handlers/journal-handler.ts:76-83`). Only
that device holds the file, so no other device duplicates it. The core cannot
parse markdown (chapter 12) and has no foreign local rows, because it mints
only `j<D>`.
