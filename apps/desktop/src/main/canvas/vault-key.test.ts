import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  getOrInitializeLocalVaultKey: vi.fn(),
  secureCleanup: vi.fn(),
  requireDatabase: vi.fn(() => ({}) as never),
  getOrCreateVaultUuid: vi.fn(() => 'vault-1')
}))

vi.mock('../crypto', () => ({
  getOrInitializeLocalVaultKey: mocks.getOrInitializeLocalVaultKey,
  secureCleanup: mocks.secureCleanup
}))
vi.mock('../database', () => ({ requireDatabase: mocks.requireDatabase }))
vi.mock('../agent/storage/vault-id', () => ({ getOrCreateVaultUuid: mocks.getOrCreateVaultUuid }))

describe('canvas vault key', () => {
  beforeEach(async () => {
    const { disposeCanvasVaultKey } = await import('./vault-key')
    disposeCanvasVaultKey()
    vi.clearAllMocks()
  })

  it('initializes the vault key exactly once across concurrent callers', async () => {
    mocks.getOrInitializeLocalVaultKey.mockResolvedValue(new Uint8Array([1, 2, 3]))
    const { getCanvasContext } = await import('./vault-key')

    const [a, b] = await Promise.all([getCanvasContext(), getCanvasContext()])

    expect(mocks.getOrInitializeLocalVaultKey).toHaveBeenCalledTimes(1)
    expect(a.vaultKey).toEqual(b.vaultKey)
    expect(a.vaultId).toBe('vault-1')
  })

  it('does not cache a failed resolution so a transient keychain error can retry', async () => {
    mocks.getOrInitializeLocalVaultKey.mockRejectedValueOnce(new Error('keychain busy'))
    mocks.getOrInitializeLocalVaultKey.mockResolvedValueOnce(new Uint8Array([9]))
    const { getCanvasContext } = await import('./vault-key')

    await expect(getCanvasContext()).rejects.toThrow('keychain busy')
    await expect(getCanvasContext()).resolves.toMatchObject({ vaultId: 'vault-1' })
    expect(mocks.getOrInitializeLocalVaultKey).toHaveBeenCalledTimes(2)
  })

  it('zeroes the key on dispose', async () => {
    const key = new Uint8Array([4, 5])
    mocks.getOrInitializeLocalVaultKey.mockResolvedValue(key)
    const { getCanvasContext, disposeCanvasVaultKey } = await import('./vault-key')

    await getCanvasContext()
    disposeCanvasVaultKey()

    await vi.waitFor(() => expect(mocks.secureCleanup).toHaveBeenCalledWith(key))
  })
})
