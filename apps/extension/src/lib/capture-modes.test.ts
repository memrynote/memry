import { describe, it, expect } from 'vitest'
import type { ArticleCapture } from '@memry/article-extract'
import {
  bytesToDataUrl,
  buildScreenshotDraft,
  planStitch,
  toSelectionCapture
} from './capture-modes'

const base: ArticleCapture = {
  url: 'https://example.com/p',
  mode: 'article',
  contentMarkdown: '# Real markdown',
  excerpt: 'x',
  extractionStatus: 'full',
  properties: {
    title: 'Page',
    source: 'https://example.com/p',
    created: 'now'
  },
  tags: ['clippings']
}

describe('toSelectionCapture', () => {
  it('keeps defuddle markdown when present and marks the capture as a forced selection', () => {
    const c = toSelectionCapture(base, 'plain selected text', 'Page')
    expect(c.mode).toBe('selection')
    expect(c.force).toBe(true)
    expect(c.contentMarkdown).toBe('# Real markdown')
    expect(c.extractionStatus).toBe('full')
  })

  it('falls back to plain selection text when markdown is empty', () => {
    const c = toSelectionCapture({ ...base, contentMarkdown: '   ' }, 'plain selected text', 'Page')
    expect(c.contentMarkdown).toBe('plain selected text')
  })
})

describe('buildScreenshotDraft', () => {
  it('builds a forced screenshot capture with an empty body', () => {
    const c = buildScreenshotDraft(base, 'data:image/png;base64,AAAA')
    expect(c.mode).toBe('screenshot')
    expect(c.force).toBe(true)
    expect(c.contentMarkdown).toBe('')
    expect(c.screenshotDataUrl).toBe('data:image/png;base64,AAAA')
    expect(c.properties.title).toBe('Page')
  })
})

describe('planStitch', () => {
  it('returns a single bottom-clipped slice for a short page', () => {
    const p = planStitch({
      scrollHeight: 500,
      innerHeight: 800,
      innerWidth: 1000,
      dpr: 1,
      maxHeight: 15000
    })
    expect(p.slices).toEqual([{ scrollY: 0, drawY: 0 }])
    expect(p.height).toBe(500)
    expect(p.width).toBe(1000)
  })

  it('bottom-aligns the final slice on a non-multiple page', () => {
    const p = planStitch({
      scrollHeight: 2000,
      innerHeight: 800,
      innerWidth: 1000,
      dpr: 1,
      maxHeight: 15000
    })
    expect(p.slices.map((s) => s.scrollY)).toEqual([0, 800, 1200])
    expect(p.height).toBe(2000)
  })

  it('applies devicePixelRatio to canvas size and draw offsets', () => {
    const p = planStitch({
      scrollHeight: 1600,
      innerHeight: 800,
      innerWidth: 500,
      dpr: 2,
      maxHeight: 15000
    })
    expect(p.width).toBe(1000)
    expect(p.height).toBe(3200)
    expect(p.slices).toEqual([
      { scrollY: 0, drawY: 0 },
      { scrollY: 800, drawY: 1600 }
    ])
  })

  it('clamps total height to maxHeight', () => {
    const p = planStitch({
      scrollHeight: 99999,
      innerHeight: 800,
      innerWidth: 100,
      dpr: 1,
      maxHeight: 1600
    })
    expect(p.height).toBe(1600)
    expect(p.slices[p.slices.length - 1].scrollY).toBe(800)
  })

  it('returns a single slice without looping when innerHeight is 0', () => {
    const p = planStitch({
      scrollHeight: 2000,
      innerHeight: 0,
      innerWidth: 1000,
      dpr: 1,
      maxHeight: 15000
    })
    expect(p.slices).toEqual([{ scrollY: 0, drawY: 0 }])
    expect(p.height).toBe(2000)
    expect(p.width).toBe(1000)
  })
})

describe('bytesToDataUrl', () => {
  it('encodes bytes as a base64 data URL', () => {
    expect(bytesToDataUrl(new Uint8Array([104, 105]), 'image/png')).toBe(
      'data:image/png;base64,aGk='
    )
  })
})
