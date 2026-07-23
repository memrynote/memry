import { describe, expect, it, vi } from 'vitest'
import { createVaultLibraryAdapter } from './canvas-library-adapter'
import type { CanvasLibraryItem } from '@memry/contracts/canvas-api'

function item(id: string): CanvasLibraryItem {
  return { id, status: 'unpublished', created: 1, elements: [] } as CanvasLibraryItem
}

function makeAdapter(overrides: Partial<Parameters<typeof createVaultLibraryAdapter>[0]> = {}) {
  const deps = {
    list: vi.fn().mockResolvedValue({ libraryItems: [item('a')] }),
    save: vi.fn().mockResolvedValue({ changed: 1 }),
    onError: vi.fn(),
    ...overrides
  }
  return { adapter: createVaultLibraryAdapter(deps), deps }
}

describe('createVaultLibraryAdapter', () => {
  it('loads the vault library', async () => {
    const { adapter } = makeAdapter()

    await expect(adapter.load({ source: 'load' })).resolves.toEqual({ libraryItems: [item('a')] })
  })

  it('returns null rather than an empty library when loading fails', async () => {
    // null means "nothing stored", which leaves Excalidraw's in-memory library
    // untouched. Returning { libraryItems: [] } would read as "the vault is
    // empty" and the next save would tombstone every row.
    const { adapter, deps } = makeAdapter({
      list: vi.fn().mockRejectedValue(new Error('ipc down'))
    })

    await expect(adapter.load({ source: 'save' })).resolves.toBeNull()
    expect(deps.onError).toHaveBeenCalledWith(expect.any(Error), 'load')
  })

  it('saves the full item list', async () => {
    const { adapter, deps } = makeAdapter()

    await adapter.save({ libraryItems: [item('a'), item('b')] as never })

    expect(deps.save).toHaveBeenCalledWith([item('a'), item('b')])
  })

  it('reports a failed save instead of swallowing it', async () => {
    const { adapter, deps } = makeAdapter({
      save: vi.fn().mockRejectedValue(new Error('disk full'))
    })

    await expect(adapter.save({ libraryItems: [item('a')] as never })).resolves.toBeUndefined()
    expect(deps.onError).toHaveBeenCalledWith(expect.any(Error), 'save')
  })
})
