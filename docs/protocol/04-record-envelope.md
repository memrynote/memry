# 04 — The record envelope

**Status**: normative. Every normative sentence carries a `path:line` citation
(chapter 00 §0.1).

This chapter specifies the two encrypted envelopes on the wire: the **record
envelope**, a JSON object with base64 fields, and the **packed CRDT envelope**, a
single binary blob. It also specifies compression, AEAD, key wrap, base64 and
canonical CBOR, because both envelopes are built out of them.

## 4.1 Compression frame

**Normative.** One leading flag byte, then the payload
(`packages/sync-client/src/compress.ts:50-54`).

| Flag   | Name   | Payload from offset 1                                                                                                  |
| ------ | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| `0x00` | stored | the plaintext verbatim                                                                                                 |
| `0x01` | zlib   | a **zlib-wrapped DEFLATE stream, RFC 1950**, as produced by `pako.deflate` (`packages/sync-client/src/compress.ts:11`) |

The `0x01` payload begins with the zlib header bytes `78 9c` at pako's default
level. It is **not** gzip (`1f 8b 08`) and **not** headerless raw DEFLATE
(RFC 1951). A Rust implementation MUST use a zlib wrapper — `flate2::ZlibEncoder`,
not `DeflateEncoder`.

### 4.1.1 The deflate implementation is part of the format

**Normative.** The writer's output is pinned byte for byte by
`packages/contracts/test-vectors/compression.json`, so the deflate
implementation is not an implementation detail a client may choose. Two
parameters, both load-bearing:

| Parameter              | Value                                                           |
| ---------------------- | --------------------------------------------------------------- |
| compression level      | **6**, `pako`'s default (`Z_DEFAULT_COMPRESSION` resolves to 6) |
| deflate implementation | **stock zlib**                                                  |

`pako` is a direct port of stock zlib (`packages/sync-client/src/compress.ts:11`
calls `pako.deflate` with no options), and stock zlib's level-6 block and
Huffman choices are what the vectors record.

**A "zlib wrapper" is not sufficient on its own.** Three Rust backends produce a
valid RFC 1950 stream that inflates to the right bytes and still fails the
committed vectors, because deflate is free to choose among many valid encodings
of the same input:

- `miniz_oxide`, which is **`flate2`'s default backend**, emits a longer
  dynamic-Huffman stream at level 6;
- `zlib-rs` and `zlib-ng` are zlib-**ng** derivatives, which deliberately trade
  ratio for speed and diverge from stock zlib at the same level;
- any backend at a level other than 6.

A conforming Rust client therefore selects the stock-zlib backend explicitly,
`flate2 = { default-features = false, features = ["zlib"] }`, and uses level 6.
`default-features = false` is required: leaving it on keeps `miniz_oxide`
compiled in alongside the requested backend.

Round-tripping is **not** a sufficient test. All three backends decompress each
other's output, so a suite that only asserts `decompress(compress(x)) == x`
passes on every one of them; only the committed frame bytes catch it.

The only gzip in the product is unrelated: the embedded editor bundle asset,
packed with `node:zlib` `gzipSync` and unpacked with `pako.ungzip`
(`apps/mobile/scripts/build-editor-web.mjs:28`, `:144`,
`apps/mobile/src/editor/editor-web-asset.ts:24`). **That asset never touches this
frame.** Confusing the two produces a client that cannot read any note body.

**Writer rules** — both are load-bearing for byte identity:

- a payload of **strictly fewer than 64 bytes** is always stored
  (`packages/sync-client/src/compress.ts:7-9`);
- a compressed result whose length is **greater than or equal to** the input is
  discarded in favour of stored
  (`packages/sync-client/src/compress.ts:12-14`). The comparison is `>=`, not `>`.

A writer that compresses a 60-byte payload produces a different envelope from the
reference for the same input.

**Reader rules:**

- a reader treats **any** flag other than `0x01` as stored
  (`packages/sync-client/src/compress.ts:47`); there is no unknown-flag
  rejection;
- an empty input is returned as-is, with no flag consumed
  (`packages/sync-client/src/compress.ts:20`);
- a `0x01` frame whose stream is **truncated MUST be a hard error**, never an
  empty decode. `pako.inflate` returns `undefined` rather than throwing for a
  stream that never reaches `Z_STREAM_END`, and handing that back under a
  `Uint8Array` return type turns a truncated body into a successful decrypt of an
  empty item, which the applier writes as a **content wipe**. The reference
  throws `Failed to decompress payload: incomplete deflate stream`
  (`packages/sync-client/src/compress.ts:26-43`).

## 4.2 Compression sits inside the ciphertext

**Normative.** The compression byte is **inside** the ciphertext in both
envelopes. There is no envelope-level compression field. Order on write is
compress then encrypt
(`packages/sync-client/src/push/record-encrypt.ts:50-51`,
`apps/desktop/src/main/sync/encrypt.ts:47-48`); on read, decrypt then decompress
(`packages/sync-client/src/pull/record-decrypt.ts:96-97`, `:149-150`).

Compression before encryption is a deliberate, recorded trade: the compression
oracle risk is accepted because CRDT updates have low entropy variance and every
crypto operation uses constant-time primitives
(`apps/desktop/src/main/sync/encrypt.ts:7-9`).

## 4.3 AEAD

**Normative.** XChaCha20-Poly1305-IETF
(`sodium.crypto_aead_xchacha20poly1305_ietf_encrypt`,
`apps/desktop/src/main/crypto/encryption.ts:33`) with:

| Parameter | Value                                     | Citation                                                                                |
| --------- | ----------------------------------------- | --------------------------------------------------------------------------------------- |
| nonce     | 24 bytes, `randombytes_buf` per operation | `packages/contracts/src/crypto.ts:35`, `apps/desktop/src/main/crypto/encryption.ts:6-7` |
| key       | 32 bytes                                  | `packages/contracts/src/crypto.ts:36`                                                   |
| tag       | 16 bytes, appended to the ciphertext      | `packages/contracts/src/crypto.ts:37`                                                   |

**The nonce is random per operation and is never a counter.** Record content is
encrypted with **no associated data**
(`apps/desktop/src/main/sync/encrypt.ts:48` passes no AAD; the parameter defaults
to libsodium `null`, `apps/desktop/src/main/crypto/encryption.ts:35`).

## 4.4 Key wrap

**Normative.** Every item gets a fresh random 32-byte file key
(`apps/desktop/src/main/crypto/primitives.ts:4-6`), which is AEAD-encrypted under
the **vault key** with its own nonce and **no associated data**
(`apps/desktop/src/main/crypto/encryption.ts:87-93`). The wrapped length is
therefore exactly **48 bytes**: 32 key + 16 tag.

The file key MUST be zeroed after use
(`apps/desktop/src/main/sync/encrypt.ts:106-108`,
`packages/sync-client/src/pull/record-decrypt.ts:98-100`).

## 4.5 Base64

**Normative.** Standard alphabet with `+` and `/`, **with** `=` padding
(`sodium.base64_variants.ORIGINAL`, `apps/desktop/src/main/sync/encrypt.ts:52`).
**Not** URL-safe.

The dependency-free reference implementation is
`packages/sync-client/src/pull/base64.ts:8-30`: it emits padding, strips it on
decode, and throws `invalid base64 input` on a non-alphabet character
(`packages/sync-client/src/pull/base64.ts:30`).

## 4.6 The record envelope on the wire

**Normative.** `PushItem` (`packages/contracts/src/sync-api.ts:215-228`, schema
`PushItemBaseSchema` at `:351-364`):

| Field            | Type                               | Required |
| ---------------- | ---------------------------------- | -------- |
| `id`             | string                             | yes      |
| `type`           | `SyncItemType`                     | yes      |
| `operation`      | `create \| update \| delete`       | yes      |
| `encryptedKey`   | base64                             | yes      |
| `keyNonce`       | base64                             | yes      |
| `encryptedData`  | base64                             | yes      |
| `dataNonce`      | base64                             | yes      |
| `signature`      | base64, 64 bytes decoded           | yes      |
| `signerDeviceId` | string                             | yes      |
| `clock`          | `Record<string, non-negative int>` | optional |
| `stateVector`    | string                             | optional |
| `deletedAt`      | non-negative int (epoch ms)        | optional |

**`clock`, `stateVector` and `deletedAt` are omitted entirely when absent, never
sent as `null`** (`apps/desktop/src/main/sync/encrypt.ts:100-102`,
`packages/sync-client/src/push/record-encrypt.ts:98-100`). This matters: a
canonical CBOR map with a key whose value is an empty map is a different byte
string from the same map with the key absent.

**The record push schema omits `stateVector` entirely.**
`RecordPushItemSchema` is `PushItemBaseSchema.omit({ type: true, stateVector:
true })` re-extended with the record type enum
(`packages/contracts/src/sync-api.ts:374-377`). A conforming client MUST NOT send
`stateVector` on `POST /sync/push`; the field exists on the general `PushItem`
shape and on the signature payload, not on the record push.

## 4.7 Canonical CBOR — `CBOR_FIELD_ORDER` is an allowlist, not the byte order

**This is the single most misread fact in the codebase and the chapter opens the
section with it.**

The encoder is `cborg`'s `encode` applied to a JavaScript `Map` built by walking
the declared field list (`packages/sync-client/src/pull/cbor.ts:9-29`, desktop
twin `apps/desktop/src/main/crypto/cbor.ts:7-28`).

**What the field list does** (`packages/sync-client/src/pull/cbor.ts:13-27`):

- **inclusion**: a key is encoded only when it is present in the input **and**
  its value is not `undefined`. `null` is a value and encodes as `f6`.
- **rejection**: a defined key that is not in the list is a hard throw, never a
  silent exclusion, with the message
  `CBOR encoding rejected: fields not in ordering would be excluded: <keys>. Update CBOR_FIELD_ORDER.`
  (`packages/sync-client/src/pull/cbor.ts:15-19`).

**What the field list does NOT do is determine the output byte order.** `cborg`
canonicalises map keys itself, **length-first then bytewise**, which is
**RFC 8949 §4.2.3, "Length-First Map Key Ordering"**. It is **not** §4.2.1: the
core deterministic encoding in §4.2.1 is plain bytewise and is a **different**
order. A Rust crate advertising "canonical" usually means §4.2.1.

`cborg` also sorts **recursively**, including plain nested objects.

**Verified empirically against the `cborg` in this workspace**:

| Input map                                   | Encoded bytes                                                                                | Encoded key order                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `{aa: 1, z: 2}`                             | `a2 617a 02 6161 01`                                                                         | `z`, then `aa`                                      |
| `{d1: 1, aa: 2}`                            | `a2 626161 02 626431 01`                                                                     | `aa`, then `d1`                                     |
| `{metadata: {stateVector, clock: {zz, a}}}` | `a1 686d65746164617461 a2 65636c6f636b a2 6161 02 627a7a 01 6b7374617465566563746f72 627376` | `clock` before `stateVector`; inner `a` before `zz` |

Row 1 is the case where length-first and plain lexicographic order **disagree**:
a lexicographic encoder produces `a2 6161 01 617a 02` and fails here and nowhere
else. Row 3 proves recursion.

**Input insertion order has no effect on the bytes.** The implementation's own
test asserts exactly that for `TOMBSTONE`
(`apps/desktop/src/main/crypto/cbor.test.ts:73-98`).

### 4.7.1 The stale in-code comments — Q04.8

Three comments in the tree claim CBOR preserves a nested object's own key order:
`packages/sync-client/src/pull/record-decrypt.ts:72-74`,
`packages/sync-client/src/push/record-encrypt.ts:74-76`, and the section-number
citation at `apps/desktop/src/main/crypto/cbor.test.ts:68`.

**They are wrong about the mechanism.** The encoder sorts. The bytes happen to be
identical either way here because `clock` (5 bytes) is shorter than `stateVector`
(11 bytes). The "clock first, then stateVector" construction discipline is
harmless; the comment is misleading, and a second implementer who believes it
builds an insertion-order encoder that diverges the first time two same-length
keys appear.

**What actually matters, and what the replacement comments say**: a key must be
**absent** rather than `undefined` when neither side has it, because an empty map
is a different byte string from no key at all. All four comments are corrected in
the change that lands this chapter.

**Disposition of Q04.8: answered** (this section).

### 4.7.2 Scalar encoding rules

**Normative**, verified empirically against this workspace's `cborg`:

| Value                 | Bytes                 | Rule                                                    |
| --------------------- | --------------------- | ------------------------------------------------------- |
| `1`                   | `01`                  | shortest-form unsigned integer                          |
| `1000000`             | `1a 000f4240`         | shortest form, 4-byte argument                          |
| `-1`                  | `20`                  | shortest-form negative integer                          |
| `1.5`                 | `f9 3e00`             | **narrowed to float16** when exactly representable      |
| `0.1`                 | `fb 3fb999999999999a` | float64 when narrowing is lossy                         |
| `Uint8Array([1,2,3])` | `43 010203`           | major type 2, byte string, **not** an array of integers |
| `null`                | `f6`                  |                                                         |
| `true`                | `f5`                  |                                                         |

**Float narrowing is the trap**: a Rust encoder that always emits float64
produces a different signature for the same input. See §4.13 for whether a signed
field can be non-integral today.

### 4.7.3 The field-order lists

**Normative**, verbatim from `packages/contracts/src/cbor-ordering.ts:1-26`. Each
is an **allowlist** for its payload.

| Name                     | Fields                                                                                                      | Line     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- | -------- |
| `SYNC_ITEM`              | `id, type, operation, cryptoVersion, encryptedKey, keyNonce, encryptedData, dataNonce, deletedAt, metadata` | `:2-13`  |
| `TOMBSTONE`              | `id, type, deletedAt, deviceId`                                                                             | `:14`    |
| `LINKING_PROOF`          | `sessionId, devicePublicKey`                                                                                | `:15`    |
| `SCAN_CONFIRM`           | `sessionId, initiatorPublicKey, devicePublicKey`                                                            | `:16`    |
| `KEY_CONFIRM`            | `sessionId, encryptedMasterKey`                                                                             | `:17`    |
| `PROVIDER_AUTH_CONFIRM`  | `sessionId, encryptedProviderAuth`                                                                          | `:18`    |
| `VAULT_TRANSFER_CONFIRM` | `sessionId, encryptedVaultTransfer`                                                                         | `:19`    |
| `ATTACHMENT_MANIFEST`    | `encryptedManifest, manifestNonce, encryptedFileKey, keyNonce`                                              | `:20-25` |

For `SYNC_ITEM` with every key present, the **encoded** order — verified
empirically against this workspace's `cborg` — is

```
id(2), type(4), keyNonce(8), metadata(8), dataNonce(9), deletedAt(9),
operation(9), encryptedKey(12), cryptoVersion(13), encryptedData(13)
```

sorted length-first then bytewise, which is **not** the list order. Restricted to
the four blob fields it is `keyNonce, dataNonce, encryptedKey, encryptedData`;
chapter 05 §5.8 contrasts that with the JSON sort the server applies to the same
four fields.

**The allowlist applies only at the top level.** Nested keys are sorted by the
encoder and are neither included by nor rejected against the list
(`packages/sync-client/src/pull/cbor.ts:13-19` inspects `Object.keys(data)`
only).

## 4.8 Signature payload v1

**Normative.** Assemble the field set, drop absent keys, encode as canonical CBOR
per §4.7, sign Ed25519 detached, base64 the 64-byte signature
(`apps/desktop/src/main/sync/encrypt.ts:59-85`,
`packages/sync-client/src/push/record-encrypt.ts:59-85`; schema
`SignaturePayloadV1Schema`, `packages/contracts/src/crypto.ts:205-222`).

Rules a second implementation MUST reproduce:

- **The signed values are the base64 _strings_, not the raw ciphertext bytes**
  (`apps/desktop/src/main/sync/encrypt.ts:54-57`, `:64-67`).
- `cryptoVersion` is the **literal `1`** on the write side
  (`apps/desktop/src/main/sync/encrypt.ts:63`), and the schema pins it as
  `z.literal(CRYPTO_VERSION)` (`packages/contracts/src/crypto.ts:209`).
- `deletedAt` is included **only when defined**
  (`apps/desktop/src/main/sync/encrypt.ts:70-72`).
- `metadata` is included **only when `clock` or `stateVector` exists**, and it
  carries only the ones that exist
  (`apps/desktop/src/main/sync/encrypt.ts:74-79`).

### 4.8.1 `metadata.fieldClocks` — Q04.3

`SignaturePayloadV1Schema.metadata` admits `fieldClocks`
(`packages/contracts/src/crypto.ts:218`). **No writer sets it**: neither
`apps/desktop/src/main/sync/encrypt.ts:74-79` nor
`packages/sync-client/src/push/record-encrypt.ts:77-82` nor the server's
reconstruction (`apps/sync-server/src/services/sync.ts:149-152`) ever does.

**Normative — a writer MUST NOT set `metadata.fieldClocks`.** Because the
allowlist governs only the top level (§4.7.3), setting it would not be rejected;
it would silently change the signed bytes for that item, and the server, which
reconstructs `metadata` from `clock` and `stateVector` only
(`apps/sync-server/src/services/sync.ts:149-152`), would then compute different
bytes and answer `403 SYNC_INVALID_SIGNATURE`. **A reader therefore never sees
it.** Field clocks travel in the payload (chapter 13), not in the envelope.

**Disposition of Q04.3: answered** (this section).

### 4.8.2 `signedAt` — Q04.4

`EncryptedItem.signedAt` exists in the type
(`packages/contracts/src/crypto.ts:134`) and in the schema
(`packages/contracts/src/crypto.ts:187`). It is **not** in the signed CBOR
(`packages/contracts/src/crypto.ts:205-222` has no such key), **not** in
`PushItem` (`packages/contracts/src/sync-api.ts:215-228`), and no replay window
reads it (chapter 05 §5.7 is a clock rule, not a timestamp rule).

**Normative — `signedAt` is unused.** A conforming client MUST NOT send it and
MUST ignore it on read. It is not removed here because removing it is a contract
change with no benefit; it is recorded so a Rust type derived from the contract
does not model it as meaningful.

**Disposition of Q04.4: answered** (this section).

### 4.8.3 `CBOR_FIELD_ORDER.TOMBSTONE` — Q04.6

`TOMBSTONE` (`packages/contracts/src/cbor-ordering.ts:14`) has **no producer**.
Tombstones travel as ordinary signed records with `deletedAt` set (chapter 05
§5.12).

**Normative — `TOMBSTONE` is reserved and unused.** A conforming client never
encodes under it. It is exercised only by the encoder's own insertion-order test
(`apps/desktop/src/main/crypto/cbor.test.ts:73-98`).

**Disposition of Q04.6: answered** (this section).

## 4.9 Two divergences between the read and write sides

**Normative.** Both are real and a second implementation MUST match the behaviour
described, not the one it would guess.

1. **The read side defaults a missing `operation` to `'update'`**
   (`packages/sync-client/src/pull/record-decrypt.ts:60`), while the push schema
   makes `operation` required
   (`packages/contracts/src/sync-api.ts:354`) and the server uses
   `item.operation` directly
   (`apps/sync-server/src/services/sync.ts:143`). A reader MUST apply the
   `'update'` default so that an item written by a path that omitted it still
   verifies.
2. **The server signs with a hardcoded `CRYPTO_VERSION`, not the version the
   item declared** (`apps/sync-server/src/services/sync.ts:144`). See §4.10.

## 4.10 Server-side validation, in order — and Q04.5

**Normative.** Before any signature check
(`apps/sync-server/src/services/sync.ts:91-126`):

| Check                          | Rule                                       | Failure                                                      |
| ------------------------------ | ------------------------------------------ | ------------------------------------------------------------ |
| `keyNonce` decoded length      | exactly 24                                 | `400 CRYPTO_INVALID_PAYLOAD` (`:92-98`)                      |
| `encryptedKey` decoded length  | at least `32 + 16 = 48`                    | `400 CRYPTO_INVALID_PAYLOAD` (`:100-108`)                    |
| `encryptedData` decoded length | at most `MAX_ENCRYPTED_DATA_BYTES = 5 MiB` | `400 CRYPTO_INVALID_PAYLOAD` (`:110-117`, constant at `:30`) |
| `signature` decoded length     | exactly 64                                 | `400 CRYPTO_INVALID_PAYLOAD` (`:119-126`)                    |

Then, per item
(`apps/sync-server/src/services/sync.ts:129-168`):

| Condition                 | Answer                                |
| ------------------------- | ------------------------------------- |
| signer device unknown     | `404 AUTH_DEVICE_NOT_FOUND` (`:134`)  |
| signer device revoked     | `403 AUTH_DEVICE_REVOKED` (`:137`)    |
| signature does not verify | `403 SYNC_INVALID_SIGNATURE` (`:166`) |

**Q04.5 — the server rewrites `cryptoVersion` to `1`.** It reconstructs the
signature payload with `cryptoVersion: CRYPTO_VERSION`
(`apps/sync-server/src/services/sync.ts:144`) rather than with the value the
item declared. **Normative: this is correct and intended today**, because
`cryptoVersion` is not a wire field on `PushItem` at all
(`packages/contracts/src/sync-api.ts:215-228`) — there is nothing for the client
to have declared. The signed constant is `1` on both sides (§4.8), so the
reconstruction is exact. **When a version 2 is introduced,
`cryptoVersion` must become a push field and the server must sign the declared
value**; until then a client MUST sign the literal `1`.

**Disposition of Q04.5: answered** (this section).

## 4.11 The packed CRDT envelope — Q04.1

**Normative.** Total header **160 bytes**, signature at offset **96**. All fields
are opaque byte runs: no integers, therefore no endianness.

| Offset | Length | Field                                                |
| -----: | -----: | ---------------------------------------------------- |
|      0 |     24 | `dataNonce`, the XChaCha20 nonce of the ciphertext   |
|     24 |     24 | `keyNonce`, the nonce of the wrapped file key        |
|     48 |     48 | `wrappedKey`, a 32-byte file key plus a 16-byte tag  |
| **96** |     64 | Ed25519 detached signature                           |
|    160 |   rest | ciphertext: compressed Yjs update, AEAD tag included |

`HEADER_LEN = NONCE_LEN + NONCE_LEN + WRAPPED_KEY_LEN + SIGNATURE_LEN = 24 + 24 +
48 + 64` (`apps/desktop/src/main/sync/crdt-encrypt.ts:11-14`; twin at
`packages/sync-client/src/pull/record-decrypt.ts:103-106`). Written at
`apps/desktop/src/main/sync/crdt-encrypt.ts:32-36`, `:40`; read at `:59-62`,
`:71-74`.

**Minimum accepted length is 161** — `HEADER_LEN + 1`
(`apps/desktop/src/main/sync/crdt-encrypt.ts:54`,
`packages/sync-client/src/pull/record-decrypt.ts:122`). A 160-byte blob is
rejected with `CRDT update too short: 160 bytes`.

**Core obligation.** `HEADER = 160`, `SIG_OFF = 96`, reject `len < 161`, and
**verify the signature before unwrapping the key**.

**A stale comment at `apps/desktop/src/main/sync/crdt-encrypt.ts:35` says the
signature slot is at offset 72.** It is at 96. The comment is corrected in the
change that lands this chapter. No 168-byte figure survives anywhere in the tree.

**Disposition of Q04.1: answered** (this section).

## 4.12 The CRDT signed message and AAD

**Normative.** The signed message is

```
UTF-8(noteId) ‖ packed[0..96) ‖ packed[160..end)
```

— the 64-byte signature slot is **excised**, and on write the signature is
computed while that slot is still zero-filled
(`apps/desktop/src/main/sync/crdt-encrypt.ts:85-93`; the buffer is allocated
zeroed at `:31` and the signature is written at `:40`, after `:38-39` computes
it). Read side: `packages/sync-client/src/pull/record-decrypt.ts:129-135`.

**The note id is therefore authenticated, not merely associated**: a packet made
for one note fails as a **signature** error when read as another, not as an AEAD
error (`packages/sync-client/src/push/roundtrip.test.ts:173-188`).

**AEAD associated data for the CRDT content is the UTF-8 note id**
(`apps/desktop/src/main/sync/crdt-encrypt.ts:23`, `:27`, `:78`). **The key unwrap
uses no AAD** (`apps/desktop/src/main/sync/crdt-encrypt.ts:28` calls
`wrapFileKey`, which passes none,
`apps/desktop/src/main/crypto/encryption.ts:91`).

The platform-free provider interface types AAD as a `string` because the mobile
binding accepts only strings, with `''` meaning libsodium NULL
(`packages/sync-client/src/pull/crypto-provider.ts:10-13`, `:24`).

**Order of operations on read**, identical in both envelopes: verify the
signature, then unwrap the file key, then decrypt, then decompress, then zero the
file key (`packages/sync-client/src/pull/record-decrypt.ts:82-100`, `:137-153`).

### 4.12.1 `EncryptedCrdtItem` — Q04.2

`EncryptedCrdtItem` and `EncryptedCrdtItemSchema`
(`packages/contracts/src/crypto.ts:139-150`, `:192-203`) declare
`encryptedSnapshot`, `snapshotNonce` and `stateVector`. **Nothing on the wire has
those fields**, and nothing produces the type: snapshots ship as the same packed
blob as updates (chapter 07 §7.11).

**Normative — the type is dead, a pre-packed-envelope relic, and a Rust type
derived from it would be wrong.** A conforming client MUST NOT model it. It is
referenced only by `packages/contracts/src/crypto.test.ts`. Its removal, and the
correction of `CRDT_SYNC_ITEM_TYPES`, are tracked together as **#2186** (chapter
07 §7.1).

**Disposition of Q04.2: answered** (this section).

## 4.13 Can a signed field be non-integral — Q04.7

**Today, no.** Every signed numeric field is an integer by construction:
`cryptoVersion` is the literal `1` (§4.8); every clock tick is
`z.number().int().nonnegative()`
(`packages/contracts/src/sync-api.ts:308`); and `deletedAt` on the push item is
`z.number().int().min(0)` (`packages/contracts/src/sync-api.ts:363`).

**But `SignaturePayloadV1Schema.deletedAt` is a bare `z.number().optional()` with
no `.int()`** (`packages/contracts/src/crypto.ts:214`), so the signature schema
admits a fractional value that would encode as a float and hit the float16
narrowing rule of §4.7.2.

**Normative — a conforming writer MUST NOT sign a non-integral number.**
`deletedAt` is epoch milliseconds and MUST be an integer. A reader that receives
one anyway MUST encode it with the §4.7.2 float rules rather than rounding it,
because rounding changes the signed bytes and turns a verifiable item into a
`403`. The two float cases are pinned as vectors (`cbor-canonical.json` cases 10
and 11) so the behaviour is fixed rather than discovered.

**Disposition of Q04.7: answered** (this section).

## 4.14 Per-item size ceiling

**Normative** (`packages/sync-client/src/note-size.ts:16-31`):

| Constant                      | Value                                   |
| ----------------------------- | --------------------------------------- |
| `SYNC_ITEM_MAX_ENCRYPT_BYTES` | `5 * 1024 * 1024`                       |
| `SYNC_ITEM_ENCRYPT_OVERHEAD`  | `1.37`                                  |
| `NOTE_SYNC_MAX_BYTES`         | `floor(5242880 / 1.37)` = **3 826 919** |
| `NOTE_SYNC_WARN_RATIO`        | `0.8`                                   |
| `NOTE_SYNC_WARN_BYTES`        | `floor(3826919 * 0.8)` = **3 061 535**  |

The check runs **before any crypto** and raises a non-retryable
`ItemTooLargeError`
(`apps/desktop/src/main/sync/encrypt.ts:36-42`,
`packages/sync-client/src/push/record-encrypt.ts:40-46`). It is typed so the
batch layers can distinguish it from a crypto failure and name the note that
stopped syncing.

## 4.15 The vault-name envelope

**Normative.** A vault's display name is its own small envelope, **not** a record
payload. XChaCha20-Poly1305 under the **vault key** with AAD
`vault-name-v1:<vaultUuid>`
(`apps/desktop/src/main/sync/vault-name-crypto.ts:5-8`, `:21`), yielding
`encryptedName` and `nameNonce`, both standard base64
(`apps/desktop/src/main/sync/vault-name-crypto.ts:22`).

**Its failure contract differs from every other envelope in this chapter: decrypt
failure returns `null` rather than throwing**
(`apps/desktop/src/main/sync/vault-name-crypto.ts:31-36`). A client that reuses
the item envelope for a vault name produces the wrong bytes; a client that
propagates a throw here breaks the vault list.
