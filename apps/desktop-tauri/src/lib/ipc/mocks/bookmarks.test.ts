import { describe, it, expect } from 'vitest'

import { bookmarksRoutes } from './bookmarks'

describe('bookmarksRoutes', () => {
  it('bookmarks_list returns at least 10 fixtures across multiple domains', async () => {
    const list = (await bookmarksRoutes.bookmarks_list!(undefined)) as Array<{
      id: string
      url: string
    }>
    expect(list.length).toBeGreaterThanOrEqual(10)
    const domains = new Set(list.map((b) => new URL(b.url).hostname))
    expect(domains.size).toBeGreaterThanOrEqual(5)
  })

  it('bookmarks_get returns bookmark by id', async () => {
    const b = (await bookmarksRoutes.bookmarks_get!({ id: 'bookmark-1' })) as { id: string }
    expect(b.id).toBe('bookmark-1')
  })

  it('bookmarks_get rejects unknown id', async () => {
    await expect(bookmarksRoutes.bookmarks_get!({ id: 'missing' })).rejects.toThrow(/not found/i)
  })

  it('bookmarks_create adds a new bookmark', async () => {
    const created = (await bookmarksRoutes.bookmarks_create!({
      url: 'https://example.com',
      title: 'Example'
    })) as { id: string; url: string; title: string }
    expect(created.id).toMatch(/^bookmark-\d+/)
    expect(created.url).toBe('https://example.com')
  })

  it('bookmarks_update mutates fields', async () => {
    const updated = (await bookmarksRoutes.bookmarks_update!({
      id: 'bookmark-2',
      title: 'Renamed'
    })) as { title: string }
    expect(updated.title).toBe('Renamed')
  })

  it('bookmarks_delete removes a bookmark', async () => {
    const created = (await bookmarksRoutes.bookmarks_create!({
      url: 'https://temp.com',
      title: 'Temp'
    })) as { id: string }
    const result = (await bookmarksRoutes.bookmarks_delete!({ id: created.id })) as {
      ok: boolean
    }
    expect(result.ok).toBe(true)
  })

  it('bookmarks_preview returns link preview metadata for a URL', async () => {
    const preview = (await bookmarksRoutes.bookmarks_preview!({
      url: 'https://example.com'
    })) as { url: string; title: string; description: string }
    expect(preview.url).toBe('https://example.com')
    expect(typeof preview.title).toBe('string')
  })
})
