import { describe, expect, it } from 'vitest'

import { createTestChain, signAppleJws } from '../__tests__/apple-test-chain'
import { verifyAppleJws } from './apple-jws'
import { APPLE_ROOT_CA_G3_DER } from './apple-root-ca'

describe('Apple Root CA - G3 pin', () => {
  it('embeds the certificate Apple publishes, by SHA-256 fingerprint', async () => {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', APPLE_ROOT_CA_G3_DER))
    expect(Buffer.from(digest).toString('hex')).toBe(
      '63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179'
    )
  })

  it('refuses a well-formed chain that does not end at Apple', async () => {
    const chain = await createTestChain()
    const jws = await signAppleJws(chain, { signedDate: Date.now() })
    await expect(verifyAppleJws(jws)).rejects.toThrow(/not signed by Apple Root CA - G3/)
  })
})
