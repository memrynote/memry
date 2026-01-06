import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockApi } from '@tests/setup-dom'
import {
  searchService,
  onSearchIndexRebuildStarted,
  onSearchIndexRebuildProgress,
  onSearchIndexRebuildCompleted,
  onSearchIndexCorrupt,
  highlightTerms,
  escapeHtml,
  safeHighlight
} from './search-service'

describe('search-service', () => {
  let api: any

  beforeEach(() => {
    api = createMockApi()
    api.search.query = vi.fn().mockResolvedValue({ results: [], total: 0 })
    api.search.quick = vi.fn().mockResolvedValue([])
    api.search.suggestions = vi.fn().mockResolvedValue([])
    api.search.getRecent = vi.fn().mockResolvedValue([])
    api.search.clearRecent = vi.fn().mockResolvedValue({ success: true })
    api.search.addRecent = vi.fn().mockResolvedValue({ success: true })
    api.search.getStats = vi.fn().mockResolvedValue({})
    api.search.rebuildIndex = vi.fn().mockResolvedValue({ success: true })
    api.search.searchNotes = vi.fn().mockResolvedValue([])
    api.search.findByTag = vi.fn().mockResolvedValue([])
    api.search.findBacklinks = vi.fn().mockResolvedValue([])

    api.onSearchIndexRebuildStarted = vi.fn().mockReturnValue(() => {})
    api.onSearchIndexRebuildProgress = vi.fn().mockReturnValue(() => {})
    api.onSearchIndexRebuildCompleted = vi.fn().mockReturnValue(() => {})
    api.onSearchIndexCorrupt = vi.fn().mockReturnValue(() => {})

    ;(window as Window & { api: unknown }).api = api
  })

  it('forwards search queries and related calls', async () => {
    await searchService.query({ query: 'test' })
    expect(api.search.query).toHaveBeenCalledWith({ query: 'test' })

    await searchService.quick({ query: 'quick', limit: 5 })
    expect(api.search.quick).toHaveBeenCalledWith({ query: 'quick', limit: 5 })

    await searchService.suggestions({ prefix: 'ta' })
    expect(api.search.suggestions).toHaveBeenCalledWith({ prefix: 'ta' })

    await searchService.getRecent()
    expect(api.search.getRecent).toHaveBeenCalled()

    await searchService.clearRecent()
    expect(api.search.clearRecent).toHaveBeenCalled()

    await searchService.addRecent('task')
    expect(api.search.addRecent).toHaveBeenCalledWith('task')

    await searchService.rebuildIndex()
    expect(api.search.rebuildIndex).toHaveBeenCalled()

    await searchService.searchNotes('query', { tags: ['tag'] })
    expect(api.search.searchNotes).toHaveBeenCalledWith('query', { tags: ['tag'] })

    await searchService.findByTag('tag')
    expect(api.search.findByTag).toHaveBeenCalledWith('tag')

    await searchService.findBacklinks('note-1')
    expect(api.search.findBacklinks).toHaveBeenCalledWith('note-1')
  })

  it('registers search index event subscriptions', () => {
    const unsubscribe = vi.fn()
    api.onSearchIndexRebuildStarted = vi.fn(() => unsubscribe)
    api.onSearchIndexRebuildProgress = vi.fn(() => unsubscribe)
    api.onSearchIndexRebuildCompleted = vi.fn(() => unsubscribe)
    api.onSearchIndexCorrupt = vi.fn(() => unsubscribe)

    expect(onSearchIndexRebuildStarted(vi.fn())).toBe(unsubscribe)
    expect(onSearchIndexRebuildProgress(vi.fn())).toBe(unsubscribe)
    expect(onSearchIndexRebuildCompleted(vi.fn())).toBe(unsubscribe)
    expect(onSearchIndexCorrupt(vi.fn())).toBe(unsubscribe)
  })

  it('highlights and escapes search terms', () => {
    expect(highlightTerms('Hello world', 'world')).toBe('Hello <mark>world</mark>')
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;')
    expect(safeHighlight('<script>', 'script')).toBe('&lt;<mark>script</mark>&gt;')
  })
})
