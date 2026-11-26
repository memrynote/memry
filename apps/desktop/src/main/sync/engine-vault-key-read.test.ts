import { describe, expect, it, vi } from 'vitest'
import { SyncEngine } from './engine'
import { createMockDeps, setupTestDb } from '@tests/utils/engine-mocks'

// #5345 L4: an editor waiting vault-locked kept its notice after the keychain
// unlocked, until a later CRDT body pull ran.
describe('SyncEngine vault key reads', () => {
  const { getDb } = setupTestDb()

  it('a key read again by any cycle ends the vault-locked wait and tells the runtime once', async () => {
    // The server has no changes; only each pull's key read matters here.
    vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
      items: [],
      deleted: [],
      hasMore: false,
      nextCursor: 0
    })
    const onVaultKeyReadable = vi.fn()
    const deps = createMockDeps(getDb(), { onVaultKeyReadable })
    vi.mocked(deps.getVaultKey).mockResolvedValue(null)
    const engine = new SyncEngine(deps)

    // #given a pull that found no vault key (a locked keychain)
    await engine.pull()
    expect(engine.isCrdtPullVaultKeyMissing()).toBe(true)
    expect(onVaultKeyReadable).not.toHaveBeenCalled()

    // #when the keychain unlocks and the next pull reads the key
    vi.mocked(deps.getVaultKey).mockResolvedValue(new Uint8Array(32))
    await engine.pull()
    await engine.pull()

    // #then the wait reason clears, and the runtime hears it once
    expect(engine.isCrdtPullVaultKeyMissing()).toBe(false)
    expect(onVaultKeyReadable).toHaveBeenCalledOnce()
  })
})
