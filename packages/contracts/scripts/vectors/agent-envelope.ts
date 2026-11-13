/**
 * Class: agent at-rest envelope (`agent-envelope.json`), chapter 04 §4.17.
 *
 * Generated through Electron's sealer
 * `apps/desktop/src/main/agent/storage/encryption.ts`, imported for real, with
 * the `randombytes_buf` of its libsodium instance swapped for a fixed nonce
 * while each case seals. The column is `JSON.stringify` of the envelope, as
 * `conversation-store.ts:53-58` and `message-store.ts:51-64` store it (those
 * stores reach `electron-log`, so the step is repeated here, not imported).
 * Every `open` case is decided by Electron's `decryptAgentJsonForVault`.
 */
import { createRequire } from 'node:module'

import type sodium from 'libsodium-wrappers-sumo'

// A namespace import: desktop's sources are CommonJS to Node, and the ESM
// loader cannot see their named exports statically.
import * as electronModule from '../../../../apps/desktop/src/main/agent/storage/encryption.ts'
import type {
  AgentAtRestPurpose,
  AgentEnvelope
} from '../../../../apps/desktop/src/main/agent/storage/encryption.ts'
import { b64, fromB64, fromHex, hex } from '../../test-vectors/deterministic-provider'
import { meta } from './shared'

// Loaded as CommonJS, the exports may sit under `default`.
type Electron = typeof electronModule
const electron: Electron =
  (electronModule as Electron & { default?: Electron }).default ?? electronModule

// The libsodium instance `encryption.ts` holds: its CommonJS `require`, not
// this script's ESM import, which Node loads as a second instance.
const electronSodium: typeof sodium = createRequire(
  new URL('../../../../apps/desktop/src/main/crypto/encryption.ts', import.meta.url)
)('libsodium-wrappers-sumo')

const VAULT_KEY = '5b1e0c2a9d84f3706e1d2c3b4a5968778695a4b3c2d1e0f0f1e2d3c4b5a69788'
const OTHER_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'

interface SealSpec {
  name: string
  purpose: AgentAtRestPurpose
  plaintext: string
}

const SEALS: SealSpec[] = [
  { name: 'title, ascii', purpose: 'agent_conversation_title', plaintext: 'Weekly planning' },
  { name: 'title, empty', purpose: 'agent_conversation_title', plaintext: '' },
  {
    name: 'title, Turkish and emoji',
    purpose: 'agent_conversation_title',
    plaintext: 'Toplantı notları 🗓️ İğdır'
  },
  {
    name: 'title, JSON-special characters',
    purpose: 'agent_conversation_title',
    plaintext: 'quote " backslash \\ slash / newline \n tab \t'
  },
  {
    name: 'message content, text parts',
    purpose: 'agent_message_content',
    plaintext: JSON.stringify({
      parts: [{ type: 'text', text: 'Summarise my notes from last week.' }]
    })
  },
  {
    name: 'message content, 4 KiB',
    purpose: 'agent_message_content',
    plaintext: JSON.stringify({ parts: [{ type: 'text', text: 'lorem ipsum '.repeat(340) }] })
  },
  { name: 'attachments, empty list', purpose: 'agent_attachments', plaintext: '[]' },
  {
    name: 'attachments, one file',
    purpose: 'agent_attachments',
    plaintext: JSON.stringify([{ kind: 'file', name: 'plan.pdf', size: 1024 }])
  }
]

interface OpenSpec {
  name: string
  purpose: AgentAtRestPurpose
  keyHex: string
  column: string
}

/** Nonce `i`: 24 bytes counting up from `i * 24`. */
const nonceFor = (index: number): Uint8Array =>
  Uint8Array.from({ length: 24 }, (_, at) => (index * 24 + at) & 0xff)

function sealWithNonce(
  plaintext: string,
  key: Uint8Array,
  purpose: AgentAtRestPurpose,
  nonce: Uint8Array
): string {
  const random = electronSodium.randombytes_buf
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `encrypt` calls only the Uint8Array overload
  electronSodium.randombytes_buf = (() => nonce.slice()) as typeof sodium.randombytes_buf
  try {
    return JSON.stringify(electron.encryptAgentJsonForVault(plaintext, key, purpose))
  } finally {
    electronSodium.randombytes_buf = random
  }
}

/** What Electron's reader makes of `column`: the plaintext, or `null` when it throws. */
function electronOpen(column: string, key: Uint8Array, purpose: AgentAtRestPurpose): string | null {
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the stores parse the column the same way (`conversation-store.ts:58`)
    return electron.decryptAgentJsonForVault(JSON.parse(column) as AgentEnvelope, key, purpose)
  } catch {
    return null
  }
}

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every column parsed here was written by the generator
const parsed = (column: string): AgentEnvelope => JSON.parse(column) as AgentEnvelope

function tamper(envelope: AgentEnvelope): string {
  const bytes = fromB64(envelope.ciphertext)
  bytes[0] ^= 0x01
  return JSON.stringify({ ...envelope, ciphertext: b64(bytes) })
}

export async function buildAgentEnvelope(): Promise<Record<string, unknown>> {
  // A second instance: the entry point's `await ready` does not initialise it.
  await electronSodium.ready
  const key = fromHex(VAULT_KEY)
  const seals = SEALS.map((spec, index) => {
    const nonce = nonceFor(index)
    const column = sealWithNonce(spec.plaintext, key, spec.purpose, nonce)
    if (parsed(column).nonce !== b64(nonce)) {
      throw new Error(`agent-envelope: ${spec.name} was not sealed under the fixed nonce`)
    }
    if (electronOpen(column, key, spec.purpose) !== spec.plaintext) {
      throw new Error(`agent-envelope: ${spec.name} does not open under Electron`)
    }
    return { ...spec, nonceHex: hex(nonce), column }
  })

  const title = seals[0].column
  const content = seals[4].column
  const opens: OpenSpec[] = [
    {
      name: 'an extra key is ignored',
      purpose: 'agent_message_content',
      keyHex: VAULT_KEY,
      column: JSON.stringify({ ...parsed(content), extra: true })
    },
    {
      name: 'keys in another order',
      purpose: 'agent_conversation_title',
      keyHex: VAULT_KEY,
      column: JSON.stringify({
        ciphertext: parsed(title).ciphertext,
        nonce: parsed(title).nonce,
        version: parsed(title).version
      })
    },
    {
      name: 'a title does not open as message content',
      purpose: 'agent_message_content',
      keyHex: VAULT_KEY,
      column: title
    },
    { name: 'another key', purpose: 'agent_conversation_title', keyHex: OTHER_KEY, column: title },
    {
      name: 'one ciphertext bit flipped',
      purpose: 'agent_message_content',
      keyHex: VAULT_KEY,
      column: tamper(parsed(content))
    },
    {
      name: 'version 2',
      purpose: 'agent_conversation_title',
      keyHex: VAULT_KEY,
      column: title.replace('"version":1', '"version":2')
    },
    {
      name: 'not JSON',
      purpose: 'agent_conversation_title',
      keyHex: VAULT_KEY,
      column: 'Weekly planning'
    }
  ].map((spec) => ({
    ...spec,
    plaintext: electronOpen(spec.column, fromHex(spec.keyHex), spec.purpose)
  }))

  return {
    meta: meta({
      chapter: 'docs/protocol/04-record-envelope.md §4.17',
      oracle:
        'apps/desktop/src/main/agent/storage/encryption.ts (encryptAgentJsonForVault, decryptAgentJsonForVault) with a fixed nonce',
      note: '`column` is the text Electron stores in agent_conversations.title, agent_messages.content and agent_messages.attachments. An open case with `plaintext: null` is one Electron rejects.'
    }),
    keyHex: VAULT_KEY,
    seals,
    opens
  }
}
