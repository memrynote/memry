import { beforeAll, describe, expect, it } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'

import {
  AGENT_AT_REST_VERSION,
  decryptAgentJsonForVault,
  encryptAgentJsonForVault
} from '../encryption'

describe('Agent at-rest encryption', () => {
  let vaultKey: Uint8Array

  beforeAll(async () => {
    await sodium.ready
    vaultKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
  })

  it('round-trips a string', () => {
    const env = encryptAgentJsonForVault('hello world', vaultKey, 'agent_message_content')
    expect(env.version).toBe(AGENT_AT_REST_VERSION)
    expect(env.nonce).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(env.ciphertext).not.toContain('hello world')

    const back = decryptAgentJsonForVault(env, vaultKey, 'agent_message_content')
    expect(back).toBe('hello world')
  })

  it('rejects decryption with wrong associated data', () => {
    const env = encryptAgentJsonForVault('secret', vaultKey, 'agent_message_content')
    expect(() => decryptAgentJsonForVault(env, vaultKey, 'agent_attachments')).toThrow()
  })

  it('rejects decryption with tampered ciphertext', () => {
    const env = encryptAgentJsonForVault('secret', vaultKey, 'agent_message_content')
    const tampered = { ...env, ciphertext: env.ciphertext.slice(0, -1) + 'A' }
    expect(() => decryptAgentJsonForVault(tampered, vaultKey, 'agent_message_content')).toThrow()
  })

  it('produces different ciphertexts for the same input', () => {
    const a = encryptAgentJsonForVault('x', vaultKey, 'agent_message_content')
    const b = encryptAgentJsonForVault('x', vaultKey, 'agent_message_content')
    expect(a.ciphertext).not.toBe(b.ciphertext)
    expect(a.nonce).not.toBe(b.nonce)
  })

  it('serializes to a JSON-safe envelope', () => {
    const env = encryptAgentJsonForVault('x', vaultKey, 'agent_message_content')
    const serialized = JSON.stringify(env)
    const reparsed = JSON.parse(serialized)
    expect(decryptAgentJsonForVault(reparsed, vaultKey, 'agent_message_content')).toBe('x')
  })
})
