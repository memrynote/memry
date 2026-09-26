# 14 — Attachments

**Status**: normative, and **in scope in both directions**. Every normative
sentence carries a `path:line` citation (chapter 00 §0.1).

**Scope marker, moved by feature 003.** This chapter was written "scoped
read-only and deferred": `file`, `audio` and `video` rendered their metadata in
place, downloading their bytes was deferred, uploading anything was deferred,
and inline images were the one exception. **That marker is gone.** A
non-desktop client now downloads and uploads every attachment type, and two
consequences follow that a reader must not miss:

- **§14.8's standing condition has fired.** "A client that later gains the
  ability to delete an attachment MUST dereference" — gaining it is exactly
  what this change did, so dereferencing is now an obligation rather than an
  omission that was merely correct.
- **§14.5.1's three-route minimum described a read-only client.** It is still
  true for one; a writing client needs the upload session routes and
  `dereference` on top of those three.

## 14.1 Attachments are not records

**Normative.** `attachment` is in `SYNC_ITEM_TYPES`
(`packages/contracts/src/sync-api.ts:12`) but **not** in
`RECORD_SYNC_ITEM_TYPES` (`:36-62`) and **not** in `ENCRYPTABLE_ITEM_TYPES`
(`:127-153`). **Attachment bytes never travel as a record envelope.** What
travels as a record is the **note's** reference list (§14.7).

## 14.2 Chunking and framing

**Normative.**

- Plaintext is split into fixed **8 MiB** chunks, with the final chunk short
  (`CHUNK_SIZE = 8 * 1024 * 1024`,
  `apps/desktop/src/main/sync/attachments.ts:44`, applied at `:223`, `:228-230`).
- **At most 128 chunks per upload session**
  (`packages/contracts/src/blob-api.ts:17`, `:32`), so the effective per-file
  ceiling is **1 GiB** before plan limits.
- **Each chunk on the wire is `nonce(24) ‖ ciphertext`**, built explicitly
  (`apps/desktop/src/main/sync/attachments.ts:463-466`) and unpacked the same way
  on read (`:808-809`). The AEAD is chapter 04 §4.3.
- **All chunks share one file key** (`apps/desktop/src/main/sync/attachments.ts:463`
  encrypts every chunk under the same `fileKey`), wrapped under the vault key
  once, in the manifest (§14.4).

## 14.3 Addressing

**Normative.** A chunk's R2 identity is the **lowercase hex SHA-256 of its framed
ciphertext bytes** — that is, of `nonce ‖ ciphertext`, not of the plaintext —
matched by `/^[a-f0-9]{64}$/`
(`packages/contracts/src/blob-api.ts:10`, computed at
`apps/desktop/src/main/sync/attachments.ts:468`).

**The object key is derived server-side from the caller's user and vault scope,
so a client never submits key material** (`packages/contracts/src/blob-api.ts:5-8`).
The strict charset also keeps a hash from ever becoming a path fragment in a
signed URL.

**The plaintext chunk hash is a separate value** used for the integrity check
after decrypt (`apps/desktop/src/main/sync/attachments.ts:461`, checked at
`:812`; declared at
`packages/sync-client/src/push/attachment-manifest.ts:19-22`). **A reader MUST
verify it**: the ciphertext hash proves the server returned the bytes it was
asked for, and only the plaintext hash proves they decrypt to the right content.

## 14.4 The manifest

**Normative.** Contents
(`packages/sync-client/src/push/attachment-manifest.ts:26-36`):

| Field       | Meaning                                             |
| ----------- | --------------------------------------------------- |
| `id`        | the attachment id                                   |
| `filename`  |                                                     |
| `mimeType`  |                                                     |
| `size`      | plaintext byte size                                 |
| `checksum`  | SHA-256 of the **whole plaintext file** (`:31`)     |
| `chunks`    | `{ index, hash, encryptedHash, size }[]` (`:17-24`) |
| `chunkSize` | the writer's chunk size, carried per file           |
| `createdAt` |                                                     |

### 14.4.1 The manifest envelope and its signature

**Normative** (`packages/sync-client/src/push/attachment-manifest.ts:64-96`):

1. `JSON.stringify` the manifest and UTF-8 encode it (`:71`);
2. AEAD encrypt it under a **fresh file key** with **no AAD** (`:72`);
3. wrap that file key under the **vault key** (`:73`);
4. sign the four fields `encryptedManifest`, `manifestNonce`, `encryptedFileKey`,
   `keyNonce` as canonical CBOR in `CBOR_FIELD_ORDER.ATTACHMENT_MANIFEST` order
   (`:47-62`, `packages/contracts/src/cbor-ordering.ts:20-25`; the encoding rules
   are chapter 04 §4.7).

**The threat model is on record**
(`packages/sync-client/src/push/attachment-manifest.ts:10-14`): the manifest is
the **only** thing that names the file, since chunks in R2 are opaque ciphertext
addressed by hash, so the signature is what stops a server-side swap from
redirecting a note's picture at somebody else's bytes.

**Verification happens BEFORE unwrap and decrypt**
(`packages/sync-client/src/push/attachment-manifest.ts:104-109` precedes
`:111-120`). A conforming reader MUST keep that order.

An unresolvable signer device is a hard failure, not a fallback
(`apps/desktop/src/main/sync/attachments.ts:703`).

## 14.5 Routes

**Normative** (`apps/sync-server/src/routes/blob.ts`, mounted on `/sync`,
`apps/sync-server/src/index.ts:220`):

| Method | Path                                                      | Line   |
| ------ | --------------------------------------------------------- | ------ |
| GET    | `/sync/blob/:blob_key`                                    | `:150` |
| DELETE | `/sync/blob/:blob_key`                                    | `:196` |
| POST   | `/sync/attachments/upload/initiate`                       | `:219` |
| PUT    | `/sync/attachments/upload/:session_id/chunk/:chunk_index` | `:350` |
| POST   | `/sync/attachments/upload/:session_id/complete`           | `:440` |
| GET    | `/sync/attachments/upload/:session_id`                    | `:563` |
| DELETE | `/sync/attachments/upload/:session_id`                    | `:581` |
| POST   | `/sync/attachments/dereference`                           | `:654` |
| POST   | `/sync/attachments/presign-batch`                         | `:703` |
| HEAD   | `/sync/attachments/chunks/:chunk_hash`                    | `:764` |
| GET    | `/sync/attachments/chunks/:chunk_hash`                    | `:785` |
| GET    | `/sync/attachments/:attachment_id/manifest`               | `:816` |
| PUT    | `/sync/attachments/:attachment_id/manifest`               | `:831` |

### 14.5.1 The minimal read-only route set — Q14.1

**Normative. A read-only, inline-image-only client needs exactly three routes:**

| Route                                                    | Why                                                                                 |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /sync/attachments/:attachment_id/manifest` (`:816`) | the only way to learn a file's chunk list and get its wrapped key                   |
| `POST /sync/attachments/presign-batch` (`:703`)          | one call issues up to 1024 presigned GETs (`packages/contracts/src/blob-api.ts:62`) |
| `GET /sync/attachments/chunks/:chunk_hash` (`:785`)      | the proxied fallback when presign is unavailable (§14.6)                            |

It needs **none** of the upload session routes, **not** `dereference` (§14.8),
and **not** `/sync/blob/:blob_key`, which addresses record payload blobs rather
than attachment chunks. `HEAD /attachments/chunks/:chunk_hash` (`:764`) is
optional and is an existence probe, not a requirement.

**Disposition of Q14.1: answered (three routes).**

## 14.6 Two transfer paths

**Normative.** Either proxied through the Worker, or direct to R2 with presigned
URLs.

**Every presign field is optional on both request and response schemas**, so an
old client never sends them and a server without the presign secrets never
returns them; both shapes stay wire-compatible in both directions
(`packages/contracts/src/blob-api.ts:52-58`).

`STORAGE_PRESIGN_UNAVAILABLE` is the **typed, permanent** signal to fall back to
the proxied path (`apps/sync-server/src/lib/errors.ts:69-71`; chapter 00 §0.5).
A client MUST treat it as permanent for that deployment and MUST NOT retry the
presign route on a timer.

Caps:

| Call                                             |         Cap | Source                                  |
| ------------------------------------------------ | ----------: | --------------------------------------- |
| `presign-batch` (download)                       | 1024 hashes | `packages/contracts/src/blob-api.ts:62` |
| `upload/initiate` `chunkHashes` (upload presign) |         128 | `packages/contracts/src/blob-api.ts:32` |
| `dereference`                                    |        4096 | `packages/contracts/src/blob-api.ts:49` |

`PresignBatchResponseSchema` is `{ urls: Record<hash, url>, expiresAt }` with
`expiresAt` in **epoch seconds**
(`packages/contracts/src/blob-api.ts:65-70`). `dereference` is rate limited to 20
requests per 60 s (`apps/sync-server/src/routes/blob.ts:120-124`).

## 14.7 What connects a note to a manifest — Q14.2

**Normative.** The `note` payload carries `attachmentReferences`, an array of
**attachment ids** (`packages/contracts/src/sync-payloads.ts:266`; chapter 13
§13.7.1). An attachment id is exactly the `:attachment_id` path parameter of
`GET /sync/attachments/:attachment_id/manifest`
(`apps/sync-server/src/routes/blob.ts:816`) and the `id` field inside the
manifest itself (`packages/sync-client/src/push/attachment-manifest.ts:27`).

The resolution chain is therefore:

```
note.attachmentReferences[i]                       -> an attachment id
GET /sync/attachments/<that id>/manifest           -> the encrypted manifest
verify signature, unwrap file key, decrypt         -> the manifest
manifest.chunks[j].encryptedHash                   -> the R2 chunk address
presign-batch or GET /attachments/chunks/<hash>    -> nonce ‖ ciphertext
strip 24-byte nonce, AEAD decrypt under the file key
verify manifest.chunks[j].hash over the plaintext
concatenate in index order, verify manifest.checksum
```

Desktop matches a downloaded attachment back to its notes on the same field
(`apps/desktop/src/main/sync/attachment-download-redriver.ts:85`), and
`attachmentReferences` is maintained on the note's metadata rather than derived
from the body (`apps/desktop/src/main/sync/note-attachment-metadata.ts:14-23`).

**`attachmentReferences` is `.nullable().optional()`, so absent means "this
sender does not know"** (chapter 13 §13.4). A client MUST NOT infer "this note
has no attachments" from an absent key, and MUST NOT clear the local list on
seeing one.

**Disposition of Q14.2: answered** (this section).

## 14.8 Quota, and never dereferencing — Q14.3

**Normative.** **Quota is reserved against ciphertext size, not plaintext**,
because every chunk carries a nonce and a tag
(`packages/contracts/src/blob-api.ts:18-24`). A client sizing a plan limit
against `manifest.size` under-counts.

`POST /sync/attachments/dereference` is how chunk bytes are garbage collected: a
client that removes an attachment reference tells the server the chunks are no
longer needed (`apps/sync-server/src/routes/blob.ts:654`).

**A read-only client never dereferences, and never calling it is safe.** It
cannot leak quota, because quota is consumed by **uploads**, and a read-only
client performs none: it never calls `upload/initiate`, so it never reserves a
byte. Dereferencing is the writer's obligation for bytes the writer uploaded.

A dereference only lowers `blob_chunks.ref_count`; the scheduled
`cleanupOrphanedBlobChunks` sweep reaps rows at `ref_count <= 0`. It deletes a
row only while it is still unreferenced (`DELETE ... AND ref_count <= 0
RETURNING r2_key`), re-checks that no row claimed those keys since (an upload
retrying the same bytes puts the object, then inserts a fresh row), and only
then deletes the objects. An upload that re-references the hash before the
delete keeps its bytes; one that lands between the re-check and the object
delete can still lose them, a window of one R2 call. A failed object delete
only leaks storage. Ids are chunked under D1's bind limit, at most 300 rows per
tick (`apps/sync-server/src/services/cleanup.ts`, #2414).

**A client that later gains the ability to delete an attachment MUST
dereference**; until then the omission is correct rather than merely tolerated.

**Disposition of Q14.3: answered (safe; quota is consumed by uploads only).**

## 14.9 `CHUNK_SIZE` is not a contract constant — Q14.4

**Normative.** `CHUNK_SIZE = 8 MiB` is a **desktop constant**
(`apps/desktop/src/main/sync/attachments.ts:44`) and does not appear in
`packages/contracts`. The manifest carries **`chunkSize` per file**
(`packages/sync-client/src/push/attachment-manifest.ts:34`, written at
`apps/desktop/src/main/sync/attachments.ts:498`).

**A reader therefore does not need it and MUST NOT assume it**: it MUST size
every chunk from `manifest.chunks[j].size` and treat `manifest.chunkSize` as
informational. A writer needs a value, and a future writer MAY choose a different
one, subject only to the 128-chunk cap of §14.2.

**This feature's client never writes an attachment, so the question is moot for
it** — which is exactly why the reader rule above is stated rather than a writer
constant being promoted into the contract.

**Disposition of Q14.4: answered (per-file `chunkSize` in the manifest; the
desktop constant is a writer's choice).**
