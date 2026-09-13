/**
 * The FR-008 constant coverage table, and the digest over it.
 *
 * Lives beside the test rather than inside it so `vectors:check` and the
 * generator can print the current digest without running vitest. The
 * assertions are in `protocol-chapters.test.ts`.
 *
 * `docs/protocol/00..14` state constants they were derived from. Nothing stops
 * a constant changing while the chapter that quotes it does not, and a
 * specification that is quietly wrong is worse than one that is missing.
 *
 * Two mechanisms, both required:
 *
 *  1. Per-constant assertions. Each row below imports the production constant
 *     and asserts the chapter's fact table still spells it. A changed constant
 *     fails on the row that names it, so the failure points at the paragraph
 *     to fix.
 *  2. A digest over the whole constant set, recorded in chapter 00. It catches
 *     a change to something no row lists yet: the digest moves, chapter 00 has
 *     to be edited, and a reviewer is then looking at the fact tables.
 *
 * Neither alone is enough. Rows only cover what someone remembered to list;
 * the digest only says "something moved". Together they say what moved and
 * where it is written down.
 *
 * This file deliberately imports only from `packages/contracts`, so it runs
 * identically in all three pickups (the desktop vitest `shared` project,
 * `turbo run test --filter=@memry/contracts`, and iOS CI). Constants that live
 * outside contracts are pinned by the vector classes instead, which is where a
 * cross-package import is already paid for.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { CBOR_FIELD_ORDER } from '../cbor-ordering'
import {
  ARGON2_PARAMS,
  CRYPTO_VERSION,
  ED25519_PARAMS,
  KEYCHAIN_ENTRIES,
  KEY_DERIVATION_CONTEXTS,
  LINKING_HKDF_CONTEXTS,
  X25519_PARAMS,
  XCHACHA20_PARAMS
} from '../crypto'
import { LINKING_SESSION_STATUSES } from '../linking-api'
import {
  PACK_FOOTER_SIZE,
  PACK_HEADER_SIZE,
  PACK_MAGIC,
  PACK_MAX_ENTRIES,
  PACK_MAX_INDEX_ENTRY_BYTES,
  PACK_VERSION,
  PackKindCode
} from '../pack-format'
import {
  CLIENT_PLATFORMS,
  CRDT_SYNC_ITEM_TYPES,
  ENCRYPTABLE_ITEM_TYPES,
  LEGACY_RECORD_SYNC_ITEM_TYPES,
  OFFLINE_CLOCK_DEVICE_ID,
  RECORD_CLOCK_REQUIRED_ITEM_TYPES,
  RECORD_SYNC_ITEM_TYPES,
  SYNC_ITEM_TYPES,
  SYNC_OPERATIONS
} from '../sync-api'
import { BOOTSTRAP_TOKEN_HEADER } from '../bootstrap-api'
import { SYNC_SOCKET_CLOSE, SYNC_SOCKET_MESSAGE_TYPES, SYNC_SOCKET_PING } from '../sync-socket'
import { BRIDGE_FRAGMENT_NAME, BRIDGE_PROTOCOL_VERSION } from '../webview-bridge'

export const CHAPTER_DIR = new URL('../../../../docs/protocol/', import.meta.url)

export const rawChapter = (slug: string): string =>
  readFileSync(new URL(`${slug}.md`, CHAPTER_DIR), 'utf8')

/**
 * Collapse every run of whitespace to one space.
 *
 * Chapters are prettier-formatted, so a markdown table's column padding and a
 * paragraph's line wrapping are both cosmetic and both move whenever an
 * unrelated cell grows. Comparing normalised text keeps this test about the
 * facts rather than about the formatter.
 */
export const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim()

export const chapter = (slug: string): string => normalize(rawChapter(slug))

/**
 * One covered constant: where it lives, what it is, and the literal a chapter
 * must contain for that chapter to still be telling the truth.
 */
export interface Covered {
  /** Chapter file slug, without `.md`. */
  readonly slug: string
  /** What the row is about, used as the test name. */
  readonly label: string
  /** The production value, whatever its shape. Feeds the digest. */
  readonly value: unknown
  /** Literal(s) the chapter must contain. Every entry must be present. */
  readonly spelledAs: readonly string[]
}

export const C00 = '00-overview-and-versioning'
export const C01 = '01-identity-and-keys'
export const C03 = '03-device-linking'
export const C04 = '04-record-envelope'
export const C08 = '08-pack-container'
export const C09 = '09-realtime'
export const C10 = '10-bootstrap-session'
export const C11 = '11-client-policy'
export const C12 = '12-note-body-format'

export const COVERED: readonly Covered[] = [
  // --- chapter 00 -----------------------------------------------------------
  {
    slug: C00,
    label: 'CRYPTO_VERSION',
    value: CRYPTO_VERSION,
    spelledAs: ['`CRYPTO_VERSION` | `1`']
  },
  { slug: C00, label: 'PACK_VERSION', value: PACK_VERSION, spelledAs: ['`PACK_VERSION` | `1`'] },
  {
    slug: C00,
    label: 'BRIDGE_PROTOCOL_VERSION',
    value: BRIDGE_PROTOCOL_VERSION,
    spelledAs: ['`BRIDGE_PROTOCOL_VERSION` | `1`']
  },
  {
    slug: C00,
    label: 'SYNC_ITEM_TYPES size',
    value: SYNC_ITEM_TYPES.length,
    spelledAs: ['| `SYNC_ITEM_TYPES` | **26** |']
  },
  {
    slug: C00,
    label: 'RECORD_SYNC_ITEM_TYPES size',
    value: RECORD_SYNC_ITEM_TYPES.length,
    spelledAs: ['| `RECORD_SYNC_ITEM_TYPES` | 25 |']
  },
  {
    slug: C00,
    label: 'RECORD_CLOCK_REQUIRED_ITEM_TYPES size',
    value: RECORD_CLOCK_REQUIRED_ITEM_TYPES.length,
    spelledAs: ['| `RECORD_CLOCK_REQUIRED_ITEM_TYPES` | 24 |']
  },
  {
    slug: C00,
    label: 'CRDT_SYNC_ITEM_TYPES size',
    value: CRDT_SYNC_ITEM_TYPES.length,
    spelledAs: ['| `CRDT_SYNC_ITEM_TYPES` | 1 |']
  },
  {
    slug: C00,
    label: 'LEGACY_RECORD_SYNC_ITEM_TYPES size',
    value: LEGACY_RECORD_SYNC_ITEM_TYPES.length,
    spelledAs: ['| `LEGACY_RECORD_SYNC_ITEM_TYPES` | 15 |']
  },
  {
    slug: C00,
    label: 'ENCRYPTABLE_ITEM_TYPES size',
    value: ENCRYPTABLE_ITEM_TYPES.length,
    spelledAs: ['| `ENCRYPTABLE_ITEM_TYPES` | 25 |']
  },
  {
    slug: C00,
    label: 'SYNC_OPERATIONS',
    value: SYNC_OPERATIONS,
    spelledAs: ["`['create', 'update', 'delete']`"]
  },

  // --- chapter 01 -----------------------------------------------------------
  {
    slug: C01,
    label: 'ARGON2_PARAMS',
    value: ARGON2_PARAMS,
    spelledAs: [
      '`ARGON2_PARAMS.OPS_LIMIT = 3`',
      '`ARGON2_PARAMS.MEMORY_LIMIT = 67108864`',
      '`ARGON2_PARAMS.SALT_LENGTH = 16`'
    ]
  },
  {
    slug: C01,
    label: 'KEY_DERIVATION_CONTEXTS',
    value: KEY_DERIVATION_CONTEXTS,
    spelledAs: ['`memry-vault-key-v1`', '`memry-key-verifier-v1`']
  },
  {
    slug: C01,
    label: 'LINKING_HKDF_CONTEXTS',
    value: LINKING_HKDF_CONTEXTS,
    spelledAs: ['`memry-linking-enc-v1`', '`memry-linking-mac-v1`', '`memry-linking-sas-v1`']
  },
  {
    slug: C01,
    label: 'ED25519_PARAMS',
    value: ED25519_PARAMS,
    spelledAs: ['seed 32, public key 32, secret key 64, signature 64']
  },
  {
    slug: C01,
    label: 'KEYCHAIN_ENTRIES',
    value: KEYCHAIN_ENTRIES,
    spelledAs: [
      '`com.memry.sync`',
      '`master-key`',
      '`device-signing-key`',
      '`access-token`',
      '`refresh-token`',
      '`setup-token`'
    ]
  },

  // --- chapter 03 -----------------------------------------------------------
  {
    slug: C03,
    label: 'X25519_PARAMS',
    value: X25519_PARAMS,
    spelledAs: ['32-byte length checks on both inputs']
  },
  {
    slug: C03,
    label: 'LINKING_SESSION_STATUSES',
    value: LINKING_SESSION_STATUSES,
    spelledAs: ['`pending → scanned → approved → completed`', '`expired`']
  },
  {
    slug: C03,
    label: 'CBOR_FIELD_ORDER linking families',
    value: {
      LINKING_PROOF: CBOR_FIELD_ORDER.LINKING_PROOF,
      SCAN_CONFIRM: CBOR_FIELD_ORDER.SCAN_CONFIRM,
      KEY_CONFIRM: CBOR_FIELD_ORDER.KEY_CONFIRM,
      PROVIDER_AUTH_CONFIRM: CBOR_FIELD_ORDER.PROVIDER_AUTH_CONFIRM,
      VAULT_TRANSFER_CONFIRM: CBOR_FIELD_ORDER.VAULT_TRANSFER_CONFIRM
    },
    spelledAs: [
      '| `LINKING_PROOF` | `sessionId`, `devicePublicKey` |',
      '| `SCAN_CONFIRM` | `sessionId`, `initiatorPublicKey`, `devicePublicKey` |',
      '| `KEY_CONFIRM` | `sessionId`, `encryptedMasterKey` |',
      '| `PROVIDER_AUTH_CONFIRM` | `sessionId`, `encryptedProviderAuth` |',
      '| `VAULT_TRANSFER_CONFIRM` | `sessionId`, `encryptedVaultTransfer` |'
    ]
  },

  // --- chapter 04 -----------------------------------------------------------
  {
    slug: C04,
    label: 'XCHACHA20_PARAMS',
    value: XCHACHA20_PARAMS,
    spelledAs: ['| nonce | 24 bytes', '| key | 32 bytes', '| tag | 16 bytes']
  },
  {
    slug: C04,
    label: 'CBOR_FIELD_ORDER.SYNC_ITEM',
    value: CBOR_FIELD_ORDER.SYNC_ITEM,
    spelledAs: [
      '`id, type, operation, cryptoVersion, encryptedKey, keyNonce, encryptedData, dataNonce, deletedAt, metadata`'
    ]
  },
  {
    slug: C04,
    label: 'CBOR_FIELD_ORDER.ATTACHMENT_MANIFEST',
    value: CBOR_FIELD_ORDER.ATTACHMENT_MANIFEST,
    spelledAs: ['`encryptedManifest, manifestNonce, encryptedFileKey, keyNonce`']
  },
  {
    slug: C04,
    label: 'CBOR_FIELD_ORDER.TOMBSTONE',
    value: CBOR_FIELD_ORDER.TOMBSTONE,
    spelledAs: ['`id, type, deletedAt, deviceId`']
  },

  // --- chapter 08 -----------------------------------------------------------
  {
    slug: C08,
    label: 'pack header and footer sizes',
    value: { PACK_HEADER_SIZE, PACK_FOOTER_SIZE, PACK_MAGIC, PACK_VERSION },
    spelledAs: [
      '`PACK_HEADER_SIZE = 8`',
      '`PACK_FOOTER_SIZE = 53`',
      "`PACK_MAGIC = 'MPAK'`",
      '`PACK_VERSION = 1`'
    ]
  },
  {
    slug: C08,
    label: 'PackKindCode',
    value: PackKindCode,
    spelledAs: ['`record = 0`, `crdt_snapshot = 1`,\n`crdt_update = 2`']
  },
  {
    slug: C08,
    label: 'pack memory bounds',
    value: { PACK_MAX_INDEX_ENTRY_BYTES, PACK_MAX_ENTRIES },
    spelledAs: ['| `PACK_MAX_INDEX_ENTRY_BYTES` | 4096 |', '| `PACK_MAX_ENTRIES` | 4096 |']
  },

  // --- chapter 09 -----------------------------------------------------------
  {
    slug: C09,
    label: 'SYNC_SOCKET_MESSAGE_TYPES',
    value: SYNC_SOCKET_MESSAGE_TYPES,
    spelledAs: SYNC_SOCKET_MESSAGE_TYPES.map((t) => `\`${t}\``)
  },
  {
    slug: C09,
    label: 'SYNC_SOCKET_CLOSE',
    value: SYNC_SOCKET_CLOSE,
    spelledAs: [
      '| 4001 | `replaced` |',
      '| 4003 | `tokenExpired` |',
      '| 4004 | `deviceRevoked` |',
      '| 4008 | `rateLimited` |',
      '| 4009 | `versionIncompatible` |'
    ]
  },
  {
    slug: C09,
    label: 'SYNC_SOCKET_PING',
    value: SYNC_SOCKET_PING,
    spelledAs: ['the literal text frame `ping`']
  },

  // --- chapter 10 -----------------------------------------------------------
  {
    slug: C10,
    label: 'BOOTSTRAP_TOKEN_HEADER',
    value: BOOTSTRAP_TOKEN_HEADER,
    spelledAs: ['`X-Memry-Bootstrap-Token`']
  },

  // --- chapter 11 -----------------------------------------------------------
  {
    slug: C11,
    label: 'CLIENT_PLATFORMS',
    value: CLIENT_PLATFORMS,
    spelledAs: ['`ios | android | desktop`']
  },

  // --- chapter 12 -----------------------------------------------------------
  {
    slug: C12,
    label: 'BRIDGE_FRAGMENT_NAME',
    value: BRIDGE_FRAGMENT_NAME,
    spelledAs: ['an `XmlFragment` named **`prosemirror`**']
  },

  // --- chapter 06 -----------------------------------------------------------
  {
    slug: '06-vector-clocks-and-field-merge',
    label: 'OFFLINE_CLOCK_DEVICE_ID',
    value: OFFLINE_CLOCK_DEVICE_ID,
    spelledAs: ['the literal string `_offline`']
  }
]

/**
 * The digest a covered format change has to move.
 *
 * Stable JSON: keys sorted recursively, so a reordering in a source file does
 * not fabricate a change and a real value change cannot hide behind one.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

export function chapterConstantsDigest(): string {
  const payload = COVERED.map((row) => ({
    slug: row.slug,
    label: row.label,
    value: row.value
  }))
  return createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex')
}
