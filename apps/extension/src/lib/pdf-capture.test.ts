import { describe, expect, it } from 'vitest'
import {
  buildPdfDraft,
  isPdfBytes,
  MAX_PDF_BYTES,
  originPatternOf,
  pdfFilenameFrom
} from './pdf-capture'

describe('originPatternOf', () => {
  it('builds a host pattern for http and https', () => {
    expect(originPatternOf('https://example.com/docs/paper.pdf')).toBe('https://example.com/*')
    expect(originPatternOf('http://files.test:8080/a.pdf')).toBe('http://files.test:8080/*')
  })

  it('returns null for schemes we can never fetch', () => {
    expect(originPatternOf('chrome://settings')).toBeNull()
    expect(originPatternOf('file:///tmp/a.pdf')).toBeNull()
    expect(originPatternOf('blob:https://example.com/abc')).toBeNull()
    expect(originPatternOf('not a url')).toBeNull()
  })
})

describe('pdfFilenameFrom', () => {
  it('prefers a quoted Content-Disposition filename', () => {
    expect(pdfFilenameFrom('https://x.test/dl?id=9', 'attachment; filename="Q3 Report.pdf"')).toBe(
      'Q3 Report.pdf'
    )
  })

  it('reads an unquoted Content-Disposition filename', () => {
    expect(pdfFilenameFrom('https://x.test/dl', 'attachment; filename=report.pdf')).toBe(
      'report.pdf'
    )
  })

  it('falls back to the URL path segment', () => {
    expect(pdfFilenameFrom('https://x.test/docs/paper.pdf?v=2', null)).toBe('paper.pdf')
  })

  it('decodes a percent-encoded path segment', () => {
    expect(pdfFilenameFrom('https://x.test/docs/my%20paper.pdf', null)).toBe('my paper.pdf')
  })

  it('appends .pdf when the source name lacks it', () => {
    expect(pdfFilenameFrom('https://x.test/download', null)).toBe('download.pdf')
  })

  it('falls back to document.pdf when there is no usable name', () => {
    expect(pdfFilenameFrom('https://x.test/', null)).toBe('document.pdf')
  })

  it('strips path separators out of a hostile Content-Disposition', () => {
    expect(pdfFilenameFrom('https://x.test/a.pdf', 'attachment; filename="../../etc/passwd"')).toBe(
      '.._.._etc_passwd.pdf'
    )
  })
})

describe('isPdfBytes', () => {
  it('accepts a real PDF header', () => {
    expect(isPdfBytes(new TextEncoder().encode('%PDF-1.7\n...'))).toBe(true)
  })

  it('rejects an HTML login page served with a 200', () => {
    expect(isPdfBytes(new TextEncoder().encode('<!doctype html><html>'))).toBe(false)
  })

  it('rejects a response too short to have a header', () => {
    expect(isPdfBytes(new Uint8Array([0x25, 0x50]))).toBe(false)
  })
})

describe('buildPdfDraft', () => {
  const now = '2026-08-08T00:00:00.000Z'

  it('builds a forced pdf draft titled from the URL filename', () => {
    const draft = buildPdfDraft({ url: 'https://x.test/docs/paper.pdf', title: 'paper.pdf' }, now)
    expect(draft).toEqual({
      url: 'https://x.test/docs/paper.pdf',
      mode: 'pdf',
      contentMarkdown: '',
      excerpt: '',
      extractionStatus: 'full',
      force: true,
      tags: ['clippings'],
      properties: {
        title: 'paper',
        source: 'https://x.test/docs/paper.pdf',
        created: now
      }
    })
  })

  it('falls back to the tab title when the URL yields no name', () => {
    const draft = buildPdfDraft({ url: 'https://x.test/', title: 'Annual Report' }, now)
    expect(draft?.properties.title).toBe('Annual Report')
  })

  it('returns null for a tab we could never fetch', () => {
    expect(buildPdfDraft({ url: 'chrome://settings', title: 'Settings' }, now)).toBeNull()
    expect(buildPdfDraft({ url: undefined, title: 'x' }, now)).toBeNull()
  })
})

describe('MAX_PDF_BYTES', () => {
  it('is 16MB, leaving headroom under the 25MB /capture body cap after base64', () => {
    expect(MAX_PDF_BYTES).toBe(16 * 1024 * 1024)
  })
})
