import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteWithProperties, ViewConfig } from '@memry/contracts/folder-view-api'

const mocks = vi.hoisted(() => ({
  getAllWithCounts: vi.fn(),
  getFolders: vi.fn(),
  listWithProperties: vi.fn(),
  getViews: vi.fn()
}))

vi.mock('@/services/tags-service', () => ({
  tagsService: { getAllWithCounts: () => mocks.getAllWithCounts() }
}))

import { listBulkFolders, listBulkTags, loadBulkScopeOptions } from './canvas-bulk-sources'

function row(id: string, title: string, properties: Record<string, unknown> = {}) {
  return {
    id,
    path: `notes/${id}.md`,
    title,
    emoji: null,
    folder: '/',
    tags: [],
    created: '',
    modified: '',
    wordCount: 0,
    properties
  } satisfies NoteWithProperties
}

describe('canvas bulk sources', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset()
    Object.assign(window, {
      api: {
        notes: { getFolders: mocks.getFolders },
        folderView: {
          listWithProperties: mocks.listWithProperties,
          getViews: mocks.getViews
        }
      }
    })
  })

  it('lists used tags alphabetically, dropping empty ones', async () => {
    mocks.getAllWithCounts.mockResolvedValue({
      tags: [
        { name: 'zeta', count: 2 },
        { name: 'unused', count: 0 },
        { name: 'alpha', count: 5, color: '#fff' }
      ]
    })
    await expect(listBulkTags()).resolves.toEqual([
      { name: 'alpha', count: 5 },
      { name: 'zeta', count: 2 }
    ])
  })

  it('lists folders alphabetically without the vault root', async () => {
    mocks.getFolders.mockResolvedValue([
      { path: 'Projects/2026', icon: null },
      { path: '', icon: null },
      { path: 'Areas', icon: null }
    ])
    await expect(listBulkFolders()).resolves.toEqual(['Areas', 'Projects/2026'])
  })

  it('pages through every row and offers each filtering saved view', async () => {
    mocks.listWithProperties
      .mockResolvedValueOnce({
        notes: [row('b', 'Beta', { status: 'open' }), row('a', 'Alpha', { status: 'done' })],
        total: 3,
        hasMore: true
      })
      .mockResolvedValueOnce({
        notes: [row('c', 'Gamma', { status: 'open' })],
        total: 3,
        hasMore: false
      })
    const views: ViewConfig[] = [
      { name: 'Default', type: 'table', default: true },
      { name: 'Open', type: 'table', filters: 'status == "open"' }
    ]
    mocks.getViews.mockResolvedValue({ views, defaultIndex: 0 })

    const options = await loadBulkScopeOptions({ kind: 'folder', path: 'Projects' })

    expect(mocks.listWithProperties).toHaveBeenNthCalledWith(1, {
      scope: { kind: 'folder', path: 'Projects' },
      limit: 1000,
      offset: 0
    })
    expect(mocks.listWithProperties).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ offset: 2 })
    )
    // The unfiltered Default view would only repeat "all items".
    expect(options).toEqual([
      {
        viewName: null,
        refs: [
          { entityType: 'note', entityId: 'a' },
          { entityType: 'note', entityId: 'b' },
          { entityType: 'note', entityId: 'c' }
        ]
      },
      {
        viewName: 'Open',
        refs: [
          { entityType: 'note', entityId: 'b' },
          { entityType: 'note', entityId: 'c' }
        ]
      }
    ])
  })

  it('stops paging on an empty page even if the server says there is more', async () => {
    mocks.listWithProperties.mockResolvedValue({ notes: [], total: 5, hasMore: true })
    mocks.getViews.mockResolvedValue({ views: [], defaultIndex: 0 })

    await expect(loadBulkScopeOptions({ kind: 'tag', tag: 'x' })).resolves.toEqual([
      { viewName: null, refs: [] }
    ])
    expect(mocks.listWithProperties).toHaveBeenCalledTimes(1)
  })
})
