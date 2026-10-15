import { beforeAll, describe, expect, it, vi } from 'vitest'

import {
  createTestChain,
  signAppleJws,
  trustedRoot,
  type TestChain
} from '../__tests__/apple-test-chain'
import { verifyAppleJws } from './apple-jws'

vi.mock('./apple-root-ca', async () => {
  const { trustedRoot: root } = await import('../__tests__/apple-test-chain')
  return {
    get APPLE_ROOT_CA_G3_DER() {
      return root.der
    }
  }
})

describe('verifyAppleJws', () => {
  let chain: TestChain

  beforeAll(async () => {
    chain = await createTestChain()
    trustedRoot.der = chain.rootDer
  })

  it('returns the payload of a JWS whose chain ends at the pinned root', async () => {
    const jws = await signAppleJws(chain, { signedDate: Date.now(), productId: 'p' })
    await expect(verifyAppleJws(jws)).resolves.toMatchObject({ productId: 'p' })
  })

  it('rejects a chain signed by any other root, even one shipped in x5c', async () => {
    const rogue = await createTestChain()
    const jws = await signAppleJws(rogue, { signedDate: Date.now() })
    await expect(verifyAppleJws(jws)).rejects.toThrow(/not signed by Apple Root CA - G3/)
  })

  it('rejects a leaf without the App Store signing marker OID', async () => {
    const unmarked = await createTestChain({ leafMarker: false })
    trustedRoot.der = unmarked.rootDer
    try {
      const jws = await signAppleJws(unmarked, { signedDate: Date.now() })
      await expect(verifyAppleJws(jws)).rejects.toThrow(/Leaf certificate is not an Apple/)
    } finally {
      trustedRoot.der = chain.rootDer
    }
  })

  it('rejects a payload signed outside the certificate validity window', async () => {
    const jws = await signAppleJws(chain, { signedDate: Date.now() + 2 * 365 * 86_400_000 })
    await expect(verifyAppleJws(jws)).rejects.toThrow(/not valid at signedDate/)
  })

  it('rejects a tampered payload', async () => {
    const jws = await signAppleJws(chain, { signedDate: Date.now(), productId: 'a' })
    const [header, , signature] = jws.split('.')
    const forged = Buffer.from(JSON.stringify({ signedDate: Date.now(), productId: 'b' })).toString(
      'base64url'
    )
    await expect(verifyAppleJws(`${header}.${forged}.${signature}`)).rejects.toThrow(
      /signature is invalid/
    )
  })
})
