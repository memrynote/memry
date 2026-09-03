import sodium from 'libsodium-wrappers-sumo'

import { decrypt, encrypt } from '../../crypto/encryption'

export const AGENT_AT_REST_VERSION = 1 as const

export type AgentAtRestPurpose =
  'agent_conversation_title' | 'agent_message_content' | 'agent_attachments'

export interface AgentEnvelope {
  version: typeof AGENT_AT_REST_VERSION
  nonce: string
  ciphertext: string
}

const BASE64 = sodium.base64_variants.ORIGINAL

function purposeAd(purpose: AgentAtRestPurpose): Uint8Array {
  return new TextEncoder().encode(`memry/${AGENT_AT_REST_VERSION}/${purpose}`)
}

function toBase64(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, BASE64)
}

function fromBase64(value: string): Uint8Array {
  return sodium.from_base64(value, BASE64)
}

export function encryptAgentJsonForVault(
  plaintext: string,
  vaultKey: Uint8Array,
  purpose: AgentAtRestPurpose
): AgentEnvelope {
  const result = encrypt(new TextEncoder().encode(plaintext), vaultKey, purposeAd(purpose))
  return {
    version: AGENT_AT_REST_VERSION,
    nonce: toBase64(result.nonce),
    ciphertext: toBase64(result.ciphertext)
  }
}

export function decryptAgentJsonForVault(
  envelope: AgentEnvelope,
  vaultKey: Uint8Array,
  purpose: AgentAtRestPurpose
): string {
  if (envelope.version !== AGENT_AT_REST_VERSION) {
    throw new Error(`Unsupported agent envelope version: ${envelope.version}`)
  }

  const plaintext = decrypt(
    fromBase64(envelope.ciphertext),
    fromBase64(envelope.nonce),
    vaultKey,
    purposeAd(purpose)
  )
  return new TextDecoder().decode(plaintext)
}
