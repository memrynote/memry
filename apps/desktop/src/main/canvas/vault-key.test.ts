import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  getOrInitializeLocalVaultKey: vi.fn(),
  secureCleanup: vi.fn(),
  requireDatabase: vi.fn(() => ({}) as never),
  getOrCreateVaultUuid: vi.fn(() => 'vault-1'),
  getCanvasVaultPath: vi.fn(() => '/vaults/Memry' as string | null)
}))

vi.mock('../crypto', () => ({
  getOrInitializeLocalVaultKey: mocks.getOrInitializeLocalVaultKey,
  secureCleanup: mocks.secureCleanup
}))
vi.mock('../database', () => ({ requireDatabase: mocks.requireDatabase }))
vi.mock('../agent/storage/vault-id', () => ({ getOrCreateVaultUuid: mocks.getOrCreateVaultUuid }))
vi.mock('./vault-path', () => ({ getCanvasVaultPath: mocks.getCanvasVaultPath }))

describe('canvas context', () => {
  beforeEach(async () => {
    const { disposeCanvasVaultKey } = await import('./vault-key')
    disposeCanvasVaultKey()
    vi.clearAllMocks()
    mocks.getCanvasVaultPath.mockReturnValue('/vaults/Memry')
  })

  it('resolves db + vault id + vault path WITHOUT touching key material', async () => {
    const { getCanvasContext } = await import('./vault-key')

    const ctx = getCanvasContext()

    expect(ctx.vaultId).toBe('vault-1')
    expect(ctx.vaultPath).toBe('/vaults/Memry')
    // The whole point of file-backed canvases: reads and writes never consult
    // the keychain, so they survive a master-key change and a copied vault.
    expect(mocks.getOrInitializeLocalVaultKey).not.toHaveBeenCalled()
  })

  it('throws when no vault is open', async () => {
    mocks.getCanvasVaultPath.mockReturnValue(null)
    const { getCanvasContext } = await import('./vault-key')

    expect(() => getCanvasContext()).toThrow('No vault is open')
  })
})

describe('legacy vault key (migration only)', () => {
  beforeEach(async () => {
    const { disposeCanvasVaultKey } = await import('./vault-key')
    disposeCanvasVaultKey()
    vi.clearAllMocks()
  })

  it('initializes the vault key exactly once across concurrent callers', async () => {
    mocks.getOrInitializeLocalVaultKey.mockResolvedValue(new Uint8Array([1, 2, 3]))
    const { getLegacyCanvasVaultKey } = await import('./vault-key')

    const [a, b] = await Promise.all([
      getLegacyCanvasVaultKey({} as never, 'vault-1'),
      getLegacyCanvasVaultKey({} as never, 'vault-1')
    ])

    expect(mocks.getOrInitializeLocalVaultKey).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
  })

  it('does not cache a failed resolution so a transient keychain error can retry', async () => {
    mocks.getOrInitializeLocalVaultKey.mockRejectedValueOnce(new Error('keychain busy'))
    mocks.getOrInitializeLocalVaultKey.mockResolvedValueOnce(new Uint8Array([9]))
    const { getLegacyCanvasVaultKey } = await import('./vault-key')

    await expect(getLegacyCanvasVaultKey({} as never, 'vault-1')).rejects.toThrow('keychain busy')
    await expect(getLegacyCanvasVaultKey({} as never, 'vault-1')).resolves.toEqual(
      new Uint8Array([9])
    )
    expect(mocks.getOrInitializeLocalVaultKey).toHaveBeenCalledTimes(2)
  })

  it('zeroes the key on dispose', async () => {
    const key = new Uint8Array([4, 5])
    mocks.getOrInitializeLocalVaultKey.mockResolvedValue(key)
    const { getLegacyCanvasVaultKey, disposeCanvasVaultKey } = await import('./vault-key')

    await getLegacyCanvasVaultKey({} as never, 'vault-1')
    disposeCanvasVaultKey()

    await vi.waitFor(() => expect(mocks.secureCleanup).toHaveBeenCalledWith(key))
  })
})
