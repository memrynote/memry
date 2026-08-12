import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getStartupTheme } from './startup-theme'
import {
  clearLinkPreviewCache,
  extractDomain,
  fetchLinkPreview,
  getFaviconUrl,
  linkPreviewCacheSize
} from './url-metadata'
import { getYouTubeEmbedUrl, getYouTubeThumbnailUrl } from './youtube-utils'

const api = window.api as unknown as {
  inbox: { previewLink: ReturnType<typeof vi.fn> }
  settings?: { getStartupThemeSync?: ReturnType<typeof vi.fn> }
}

describe('URL metadata utilities', () => {
  beforeEach(() => {
    clearLinkPreviewCache()
    api.inbox.previewLink.mockReset()
    api.inbox.previewLink.mockResolvedValue({
      title: 'Example',
      domain: 'example.com'
    })
  })

  it('extracts domains and falls back for invalid URLs', () => {
    expect(extractDomain('https://www.example.com/articles?id=1')).toBe('example.com')
    expect(extractDomain('not a url')).toBe('not a url')
    expect(getFaviconUrl('docs.example.com')).toBe(
      'https://www.google.com/s2/favicons?domain=docs.example.com&sz=32'
    )
  })

  it('caches previews and fills missing favicons', async () => {
    const first = await fetchLinkPreview('https://example.com/a')
    const second = await fetchLinkPreview('https://example.com/a')

    expect(first).toEqual({
      title: 'Example',
      domain: 'example.com',
      favicon: 'https://www.google.com/s2/favicons?domain=example.com&sz=32'
    })
    expect(second).toBe(first)
    expect(api.inbox.previewLink).toHaveBeenCalledTimes(1)
  })

  it('drops failed previews from cache so a retry can succeed', async () => {
    api.inbox.previewLink
      .mockRejectedValueOnce(new Error('preview failed'))
      .mockResolvedValueOnce({ title: 'Retry', domain: '' })

    await expect(fetchLinkPreview('https://retry.test/page')).rejects.toThrow('preview failed')
    await expect(fetchLinkPreview('https://retry.test/page')).resolves.toMatchObject({
      title: 'Retry',
      favicon: 'https://www.google.com/s2/favicons?domain=retry.test&sz=32'
    })
    expect(api.inbox.previewLink).toHaveBeenCalledTimes(2)
  })

  it('caps the preview cache at 200 entries', async () => {
    for (let i = 0; i < 1000; i++) {
      await fetchLinkPreview(`https://example.com/page-${i}`)
    }

    expect(linkPreviewCacheSize()).toBeLessThanOrEqual(200)
    expect(linkPreviewCacheSize()).toBe(200)
  })

  it('evicts the least recently used preview, not the oldest inserted', async () => {
    for (let i = 0; i < 200; i++) {
      await fetchLinkPreview(`https://example.com/page-${i}`)
    }
    expect(api.inbox.previewLink).toHaveBeenCalledTimes(200)

    // Touch the oldest insert so it becomes the most recently used entry.
    await fetchLinkPreview('https://example.com/page-0')
    expect(api.inbox.previewLink).toHaveBeenCalledTimes(200)

    // One more distinct URL pushes past the cap and must evict page-1.
    await fetchLinkPreview('https://example.com/page-200')
    expect(linkPreviewCacheSize()).toBe(200)

    await fetchLinkPreview('https://example.com/page-0')
    expect(api.inbox.previewLink).toHaveBeenCalledTimes(201)

    await fetchLinkPreview('https://example.com/page-1')
    expect(api.inbox.previewLink).toHaveBeenCalledTimes(202)
  })
})

describe('startup and YouTube URL helpers', () => {
  it('reads startup theme from the preload bridge with a system fallback', () => {
    api.settings!.getStartupThemeSync!.mockReturnValueOnce('dark')
    expect(getStartupTheme()).toBe('dark')

    const originalGetter = api.settings!.getStartupThemeSync
    api.settings!.getStartupThemeSync = undefined
    expect(getStartupTheme()).toBe('system')
    api.settings!.getStartupThemeSync = originalGetter
  })

  it('builds YouTube thumbnail and embed URLs', () => {
    expect(getYouTubeThumbnailUrl('abc123')).toBe('https://img.youtube.com/vi/abc123/hqdefault.jpg')
    expect(getYouTubeEmbedUrl('abc123')).toBe(
      'https://www.youtube-nocookie.com/embed/abc123?autoplay=1&rel=0'
    )
  })
})
