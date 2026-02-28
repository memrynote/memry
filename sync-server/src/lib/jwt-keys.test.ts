import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockPublicKey = { type: 'public' } as unknown as CryptoKey
const mockPrivateKey = { type: 'private' } as unknown as CryptoKey

vi.mock('jose', () => ({
  importSPKI: vi.fn().mockResolvedValue({ type: 'public' }),
  importPKCS8: vi.fn().mockResolvedValue({ type: 'private' })
}))

import { getPublicKey, getPrivateKey } from './jwt-keys'
import { importSPKI, importPKCS8 } from 'jose'

describe('getPublicKey', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should import and return the public key', async () => {
    // #when
    const key = await getPublicKey('public-pem')

    // #then
    expect(key).toEqual(mockPublicKey)
    expect(importSPKI).toHaveBeenCalledWith('public-pem', 'EdDSA')
  })

  it('should import again on subsequent calls with same PEM', async () => {
    // #given
    await getPublicKey('same-pem\\nline2')

    // #when
    const key = await getPublicKey('same-pem\\nline2')

    // #then
    expect(key).toEqual(mockPublicKey)
    expect(importSPKI).toHaveBeenNthCalledWith(1, 'same-pem\nline2', 'EdDSA')
    expect(importSPKI).toHaveBeenNthCalledWith(2, 'same-pem\nline2', 'EdDSA')
  })

  it('should re-import when PEM changes', async () => {
    // #given
    await getPublicKey('pem-a')
    vi.mocked(importSPKI).mockClear()

    // #when
    await getPublicKey('pem-b')

    // #then
    expect(importSPKI).toHaveBeenCalledWith('pem-b', 'EdDSA')
  })

  it('should propagate errors from importSPKI', async () => {
    // #given
    vi.mocked(importSPKI).mockRejectedValueOnce(new Error('invalid PEM'))

    // #when / #then
    await expect(getPublicKey('bad-pem')).rejects.toThrow('invalid PEM')
  })
})

describe('getPrivateKey', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should import and return the private key', async () => {
    // #when
    const key = await getPrivateKey('private-pem')

    // #then
    expect(key).toEqual(mockPrivateKey)
    expect(importPKCS8).toHaveBeenCalledWith('private-pem', 'EdDSA')
  })

  it('should import again on subsequent calls with same PEM', async () => {
    // #given
    await getPrivateKey('same-pem\\nline2')

    // #when
    const key = await getPrivateKey('same-pem\\nline2')

    // #then
    expect(key).toEqual(mockPrivateKey)
    expect(importPKCS8).toHaveBeenNthCalledWith(1, 'same-pem\nline2', 'EdDSA')
    expect(importPKCS8).toHaveBeenNthCalledWith(2, 'same-pem\nline2', 'EdDSA')
  })

  it('should re-import when PEM changes', async () => {
    // #given
    await getPrivateKey('pem-a')
    vi.mocked(importPKCS8).mockClear()

    // #when
    await getPrivateKey('pem-b')

    // #then
    expect(importPKCS8).toHaveBeenCalledWith('pem-b', 'EdDSA')
  })

  it('should propagate errors from importPKCS8', async () => {
    // #given
    vi.mocked(importPKCS8).mockRejectedValueOnce(new Error('invalid PEM'))

    // #when / #then
    await expect(getPrivateKey('bad-pem')).rejects.toThrow('invalid PEM')
  })
})
