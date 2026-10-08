import { describe, it, expect, beforeEach, vi } from 'vitest'

let vaultPath: string | null = '/Users/k/Vaults/Notes'
vi.mock('../vault', () => ({ getStatus: () => ({ path: vaultPath }) }))
vi.mock('../vault/notes', () => ({
  getFolders: async () => [
    { path: 'Reading', icon: null },
    { path: 'Projects/Web', icon: null }
  ]
}))
const fileSpy = vi.fn(async () => ({ success: true, filedTo: 'Reading/x.md' }))
vi.mock('../inbox/filing', () => ({ fileToFolder: fileSpy }))

const { listCaptureFolders, routeCaptureToFolder } = await import('./folders')

describe('capture folders', () => {
  beforeEach(() => {
    vaultPath = '/Users/k/Vaults/Notes'
    fileSpy.mockClear()
  })

  it('lists sorted folders with an opaque vault id that does not leak the path', async () => {
    const list = await listCaptureFolders()
    expect(list?.vaultName).toBe('Notes')
    expect(list?.folders).toEqual(['Projects/Web', 'Reading'])
    expect(list?.vaultId).toMatch(/^[0-9a-f]{32}$/)
    expect(list?.vaultId).not.toContain('Vaults')
    expect(await listCaptureFolders()).toEqual(list)
  })

  it('returns null with no vault open', async () => {
    vaultPath = null
    expect(await listCaptureFolders()).toBeNull()
  })

  it('files into an existing folder of the open vault', async () => {
    const { vaultId } = (await listCaptureFolders())!
    expect(await routeCaptureToFolder('i1', 'Reading', vaultId)).toEqual({ filedTo: 'Reading' })
    expect(fileSpy).toHaveBeenCalledWith('i1', 'Reading')
  })

  it('leaves the clip in the Inbox when the vault changed since the folder was picked', async () => {
    const { vaultId } = (await listCaptureFolders())!
    vaultPath = '/Users/k/Vaults/Other'
    expect(await routeCaptureToFolder('i1', 'Reading', vaultId)).toEqual({
      filedTo: null,
      reason: 'vault-mismatch'
    })
    expect(await routeCaptureToFolder('i1', 'Reading', undefined)).toMatchObject({ filedTo: null })
    expect(fileSpy).not.toHaveBeenCalled()
  })

  it('never creates a missing or traversal folder', async () => {
    const { vaultId } = (await listCaptureFolders())!
    for (const folder of ['Gone', '../outside', 'Projects']) {
      expect(await routeCaptureToFolder('i1', folder, vaultId)).toEqual({
        filedTo: null,
        reason: 'folder-missing'
      })
    }
    expect(fileSpy).not.toHaveBeenCalled()
  })

  it('keeps the clip in the Inbox when filing fails or throws', async () => {
    const { vaultId } = (await listCaptureFolders())!
    fileSpy.mockResolvedValueOnce({ success: false, filedTo: null, error: 'disk' } as never)
    expect(await routeCaptureToFolder('i1', 'Reading', vaultId)).toMatchObject({ filedTo: null })
    fileSpy.mockRejectedValueOnce(new Error('boom'))
    expect(await routeCaptureToFolder('i1', 'Reading', vaultId)).toMatchObject({ filedTo: null })
  })
})
