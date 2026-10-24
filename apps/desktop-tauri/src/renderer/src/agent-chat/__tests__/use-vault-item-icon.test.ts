import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearVaultItemIconCache,
  ICON_CACHE_LIMIT,
  ICON_CACHE_TTL_MS,
  lookupVaultItemIcon
} from '../messages/use-vault-item-icon'

const get = vi.fn(async (id: string) => ({ emoji: `icon-${id}` }))

beforeEach(() => {
  clearVaultItemIconCache()
  get.mockClear()
  get.mockImplementation(async (id: string) => ({ emoji: `icon-${id}` }))
  ;(window as unknown as { api: unknown }).api = { notes: { get } }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('lookupVaultItemIcon', () => {
  it('shares one in-flight request between concurrent callers', async () => {
    const first = lookupVaultItemIcon('note', 'note-1')
    const second = lookupVaultItemIcon('note', 'note-1')

    expect(first).toBe(second)
    await expect(first).resolves.toBe('icon-note-1')
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('serves a resolved icon from the cache', async () => {
    await lookupVaultItemIcon('note', 'note-1')
    await lookupVaultItemIcon('note', 'note-1')

    expect(get).toHaveBeenCalledTimes(1)
  })

  it('caps the cache and drops the least recently used entry first', async () => {
    for (let index = 0; index <= ICON_CACHE_LIMIT; index++) {
      await lookupVaultItemIcon('note', `note-${index}`)
    }
    expect(get).toHaveBeenCalledTimes(ICON_CACHE_LIMIT + 1)

    // The newest key is still cached, the oldest was evicted by the cap.
    await lookupVaultItemIcon('note', `note-${ICON_CACHE_LIMIT}`)
    expect(get).toHaveBeenCalledTimes(ICON_CACHE_LIMIT + 1)

    await lookupVaultItemIcon('note', 'note-0')
    expect(get).toHaveBeenCalledTimes(ICON_CACHE_LIMIT + 2)
  })

  it('keeps a re-read entry out of the eviction window', async () => {
    await lookupVaultItemIcon('note', 'note-0')
    for (let index = 1; index < ICON_CACHE_LIMIT; index++) {
      await lookupVaultItemIcon('note', `note-${index}`)
    }
    // Re-reading note-0 makes it the most recent, so the next insert evicts note-1.
    await lookupVaultItemIcon('note', 'note-0')
    await lookupVaultItemIcon('note', 'overflow')
    get.mockClear()

    await lookupVaultItemIcon('note', 'note-0')
    expect(get).not.toHaveBeenCalled()

    await lookupVaultItemIcon('note', 'note-1')
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('does not cache a failed lookup as a permanent missing icon', async () => {
    get.mockRejectedValueOnce(new Error('vault unavailable'))

    await expect(lookupVaultItemIcon('note', 'note-1')).resolves.toBeNull()
    expect(get).toHaveBeenCalledTimes(1)

    await expect(lookupVaultItemIcon('note', 'note-1')).resolves.toBe('icon-note-1')
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('re-reads an icon once its cached entry goes stale', async () => {
    const start = Date.now()
    const now = vi.spyOn(Date, 'now').mockReturnValue(start)

    await lookupVaultItemIcon('note', 'note-1')
    now.mockReturnValue(start + ICON_CACHE_TTL_MS - 1)
    await lookupVaultItemIcon('note', 'note-1')
    expect(get).toHaveBeenCalledTimes(1)

    now.mockReturnValue(start + ICON_CACHE_TTL_MS)
    await lookupVaultItemIcon('note', 'note-1')
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('resolves null without touching the vault for anything but notes', async () => {
    await expect(lookupVaultItemIcon('task', 'task-1')).resolves.toBeNull()
    await expect(lookupVaultItemIcon('note', undefined)).resolves.toBeNull()
    expect(get).not.toHaveBeenCalled()
  })
})
