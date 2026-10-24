import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMockApi } from '@tests/setup-dom'
import { highlightTerms, searchService, stripMarkTags } from './search-service'

describe('searchService', () => {
  let api: any

  beforeEach(() => {
    api = createMockApi()
    api.search.query = vi.fn().mockResolvedValue({ results: [], total: 0 })
    api.search.quick = vi.fn().mockResolvedValue({ results: [] })
    api.search.getStats = vi.fn().mockResolvedValue({ notes: 1 })
    api.search.rebuildIndex = vi.fn().mockResolvedValue({ started: true })
    api.search.getReasons = vi.fn().mockResolvedValue([{ id: 'reason-1' }])
    api.search.addReason = vi.fn().mockResolvedValue({ id: 'reason-2' })
    api.search.clearReasons = vi.fn().mockResolvedValue({ cleared: true })
    api.search.getAllTags = vi.fn().mockResolvedValue(['alpha'])
    api.onSearchIndexRebuildStarted = vi.fn().mockReturnValue(() => {})
    api.onSearchIndexRebuildProgress = vi.fn().mockReturnValue(() => {})
    api.onSearchIndexRebuildCompleted = vi.fn().mockReturnValue(() => {})
    api.onSearchIndexCorrupt = vi.fn().mockReturnValue(() => {})
    ;(window as Window & { api: unknown }).api = api
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('forwards search commands to the preload API', async () => {
    await searchService.query({ query: 'roadmap' })
    expect(api.search.query).toHaveBeenCalledWith({ query: 'roadmap' })

    await searchService.quick('road')
    expect(api.search.quick).toHaveBeenCalledWith('road', undefined)

    await searchService.quick('road', ['markdown'])
    expect(api.search.quick).toHaveBeenCalledWith('road', ['markdown'])

    await searchService.getStats()
    expect(api.search.getStats).toHaveBeenCalled()

    await searchService.rebuildIndex()
    expect(api.search.rebuildIndex).toHaveBeenCalled()

    await searchService.getReasons()
    expect(api.search.getReasons).toHaveBeenCalled()

    await searchService.addReason({ noteId: 'note-1', reason: 'matched tag' })
    expect(api.search.addReason).toHaveBeenCalledWith({
      noteId: 'note-1',
      reason: 'matched tag'
    })

    await searchService.clearReasons()
    expect(api.search.clearReasons).toHaveBeenCalled()

    await searchService.getAllTags()
    expect(api.search.getAllTags).toHaveBeenCalled()
  })

  it('registers search rebuild event handlers', () => {
    const callback = vi.fn()

    searchService.onIndexRebuildStarted(callback)
    expect(api.onSearchIndexRebuildStarted).toHaveBeenCalledWith(callback)

    searchService.onIndexRebuildProgress(callback)
    expect(api.onSearchIndexRebuildProgress).toHaveBeenCalledWith(callback)

    searchService.onIndexRebuildCompleted(callback)
    expect(api.onSearchIndexRebuildCompleted).toHaveBeenCalledWith(callback)

    searchService.onIndexCorrupt(callback)
    expect(api.onSearchIndexCorrupt).toHaveBeenCalledWith(callback)
  })
})

describe('stripMarkTags', () => {
  it('removes <mark> and </mark> tags', () => {
    expect(stripMarkTags('<mark>hello</mark> world')).toBe('hello world')
  })

  it('handles multiple mark tags', () => {
    expect(stripMarkTags('<mark>a</mark> and <mark>b</mark>')).toBe('a and b')
  })

  it('is case-insensitive', () => {
    expect(stripMarkTags('<MARK>test</MARK>')).toBe('test')
  })

  it('returns unchanged text with no mark tags', () => {
    expect(stripMarkTags('plain text')).toBe('plain text')
  })

  it('handles empty string', () => {
    expect(stripMarkTags('')).toBe('')
  })
})

describe('highlightTerms', () => {
  it('splits text into highlighted and non-highlighted segments', () => {
    // #given
    const text = 'hello world hello'
    const query = 'hello'

    // #when
    const segments = highlightTerms(text, query)

    // #then
    const highlighted = segments.filter((s) => s.highlight)
    expect(highlighted.length).toBeGreaterThanOrEqual(1)
    expect(highlighted[0].text.toLowerCase()).toBe('hello')
  })

  it('returns single non-highlighted segment for empty query', () => {
    const segments = highlightTerms('some text', '')
    expect(segments).toEqual([{ text: 'some text', highlight: false }])
  })

  it('returns single non-highlighted segment for whitespace query', () => {
    const segments = highlightTerms('some text', '   ')
    expect(segments).toEqual([{ text: 'some text', highlight: false }])
  })

  it('handles case-insensitive matching', () => {
    const segments = highlightTerms('Hello World', 'hello')
    const highlighted = segments.filter((s) => s.highlight)
    expect(highlighted.length).toBe(1)
    expect(highlighted[0].text).toBe('Hello')
  })

  it('highlights multiple different terms', () => {
    const segments = highlightTerms('the quick brown fox', 'quick fox')
    const highlighted = segments.filter((s) => s.highlight)
    expect(highlighted).toHaveLength(2)
  })

  it('handles text with no matches', () => {
    const segments = highlightTerms('hello world', 'xyz')
    const highlighted = segments.filter((s) => s.highlight)
    expect(highlighted).toHaveLength(0)
  })

  it('escapes regex special characters in query', () => {
    const segments = highlightTerms('price is $100', '$100')
    expect(segments.some((s) => s.highlight && s.text === '$100')).toBe(true)
  })
})
