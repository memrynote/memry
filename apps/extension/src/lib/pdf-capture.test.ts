import { describe, expect, it } from 'vitest'
import {
  buildPdfDraft,
  checkPdfBytes,
  checkPdfContentLength,
  isPdfBytes,
  MAX_PDF_BYTES,
  originPatternOf,
  pdfFilenameFrom
} from './pdf-capture'

describe('originPatternOf', () => {
  it('builds a host pattern for http and https', () => {
    expect(originPatternOf('https://example.com/docs/paper.pdf')).toBe('https://example.com/*')
    expect(originPatternOf('http://files.test/a.pdf')).toBe('http://files.test/*')
  })

  it('drops a non-default port — match-pattern hosts may not carry one', () => {
    // With the port left in, permissions.contains() either throws (and we skip
    // the grant entirely) or the host `intranet.corp:8443` never matches the real
    // host, so the fetch is blocked with no prompt ever shown.
    expect(originPatternOf('https://intranet.corp:8443/policy.pdf')).toBe('https://intranet.corp/*')
    expect(originPatternOf('http://files.test:8080/a.pdf')).toBe('http://files.test/*')
  })

  it('drops an explicitly-written default port too', () => {
    expect(originPatternOf('https://example.com:443/a.pdf')).toBe('https://example.com/*')
    expect(originPatternOf('http://example.com:80/a.pdf')).toBe('http://example.com/*')
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

  it('decodes an RFC 5987 filename* value', () => {
    expect(
      pdfFilenameFrom('https://x.test/dl', "attachment; filename*=UTF-8''R%C3%A9sum%C3%A9.pdf")
    ).toBe('Résumé.pdf')
  })

  it('prefers filename* over the ASCII filename fallback beside it', () => {
    expect(
      pdfFilenameFrom(
        'https://x.test/dl',
        'attachment; filename="Resume.pdf"; filename*=UTF-8\'\'R%C3%A9sum%C3%A9.pdf'
      )
    ).toBe('Résumé.pdf')
  })

  it('falls back to the plain filename when filename* is undecodable', () => {
    expect(
      pdfFilenameFrom('https://x.test/dl', 'attachment; filename*=%%%; filename="Resume.pdf"')
    ).toBe('Resume.pdf')
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

describe('checkPdfBytes', () => {
  const pdfMagic = new TextEncoder().encode('%PDF-1.7\n')

  function bytesOfLength(length: number, magic?: Uint8Array): Uint8Array {
    const bytes = new Uint8Array(length)
    if (magic) bytes.set(magic)
    return bytes
  }

  it('accepts a valid pdf under the size cap', () => {
    expect(checkPdfBytes(bytesOfLength(1024, pdfMagic))).toEqual({ ok: true })
  })

  it('rejects a valid pdf over the size cap as too-large', () => {
    expect(checkPdfBytes(bytesOfLength(MAX_PDF_BYTES + 1, pdfMagic))).toEqual({
      ok: false,
      error: 'pdf-too-large'
    })
  })

  it('rejects an oversized non-pdf as not-a-pdf, never as too-large — pins the check order', () => {
    // A buffer bigger than the cap but without the PDF magic bytes must fail the
    // magic-byte check first. If the two checks inside checkPdfBytes were ever
    // swapped, this would wrongly report pdf-too-large instead of not-a-pdf.
    expect(checkPdfBytes(bytesOfLength(MAX_PDF_BYTES + 1))).toEqual({
      ok: false,
      error: 'not-a-pdf'
    })
  })
})

describe('checkPdfContentLength', () => {
  it('rejects a declared body over the cap before a single byte is buffered', () => {
    expect(checkPdfContentLength(String(MAX_PDF_BYTES + 1))).toEqual({
      ok: false,
      error: 'pdf-too-large'
    })
    expect(checkPdfContentLength(String(4 * 1024 * 1024 * 1024))).toEqual({
      ok: false,
      error: 'pdf-too-large'
    })
  })

  it('accepts a declared body at or under the cap', () => {
    expect(checkPdfContentLength(String(MAX_PDF_BYTES))).toEqual({ ok: true })
    expect(checkPdfContentLength('1024')).toEqual({ ok: true })
    expect(checkPdfContentLength(' 1024 ')).toEqual({ ok: true })
  })

  it('falls through to the post-read check when the header is absent or unparseable', () => {
    // Chunked responses legitimately omit Content-Length, so "no header" must not
    // mean "too large" — checkPdfBytes still catches the real size after the read.
    expect(checkPdfContentLength(null)).toEqual({ ok: true })
    expect(checkPdfContentLength('')).toEqual({ ok: true })
    expect(checkPdfContentLength('not-a-number')).toEqual({ ok: true })
    expect(checkPdfContentLength('123, 123')).toEqual({ ok: true })
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
    const draft = buildPdfDraft({ url: 'https://x.test/.pdf', title: 'Annual Report' }, now)
    expect(draft?.properties.title).toBe('Annual Report')
  })

  it('matches a .pdf path case-insensitively', () => {
    expect(buildPdfDraft({ url: 'https://x.test/docs/PAPER.PDF', title: 'p' }, now)?.mode).toBe(
      'pdf'
    )
  })

  it('ignores the query string and fragment when matching the path', () => {
    expect(
      buildPdfDraft({ url: 'https://x.test/p.pdf?token=abc#page=3', title: 'p' }, now)?.mode
    ).toBe('pdf')
    // …and a query string alone must never make a non-pdf path look like one.
    expect(buildPdfDraft({ url: 'https://x.test/view?file=a.pdf', title: 'p' }, now)).toBeNull()
    expect(buildPdfDraft({ url: 'https://x.test/article#a.pdf', title: 'p' }, now)).toBeNull()
  })

  it('returns null for a page whose path is not a .pdf', () => {
    // A failed EXTRACT is not proof of a PDF: browsers do not inject content
    // scripts into tabs already open when the extension updated, so an ordinary
    // article looks identical to a PDF viewer. Offering the PDF card there would
    // prompt for a persistent site grant and then save nothing.
    expect(buildPdfDraft({ url: 'https://x.test/blog/post', title: 'Post' }, now)).toBeNull()
    expect(buildPdfDraft({ url: 'https://x.test/', title: 'Home' }, now)).toBeNull()
  })

  it('returns null for a tab we could never fetch', () => {
    expect(buildPdfDraft({ url: 'chrome://settings', title: 'Settings' }, now)).toBeNull()
    expect(buildPdfDraft({ url: 'file:///tmp/a.pdf', title: 'a.pdf' }, now)).toBeNull()
    expect(buildPdfDraft({ url: undefined, title: 'x' }, now)).toBeNull()
  })
})

describe('MAX_PDF_BYTES', () => {
  it('is 16MB, leaving headroom under the 25MB /capture body cap after base64', () => {
    expect(MAX_PDF_BYTES).toBe(16 * 1024 * 1024)
  })
})
