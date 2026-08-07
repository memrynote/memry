import { describe, it, expect } from 'vitest'
import { splitPageContent } from './multipart.ts'

const BOUNDARY = '--MultipartBoundary_abc123'

function multipart(html: string, inkml: string): string {
  return [
    BOUNDARY,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    html,
    BOUNDARY,
    'Content-Type: application/inkml+xml',
    '',
    inkml,
    `${BOUNDARY}--`,
    ''
  ].join('\r\n')
}

describe('splitPageContent', () => {
  it('splits a multipart response into html + inkml', () => {
    const parts = splitPageContent(multipart('<html><body><p>hi</p></body></html>', '<ink/>'))
    expect(parts.html).toBe('<html><body><p>hi</p></body></html>')
    expect(parts.inkml).toBe('<ink/>')
  })

  it('passes plain HTML responses through untouched', () => {
    const html = '<html><body><p>no ink here</p></body></html>'
    expect(splitPageContent(html)).toEqual({ html, inkml: '' })
  })

  it('returns empty inkml when the multipart has only an html part', () => {
    const input = [BOUNDARY, 'Content-Type: text/html', '', '<p>solo</p>', `${BOUNDARY}--`].join(
      '\n'
    )
    expect(splitPageContent(input)).toEqual({ html: '<p>solo</p>', inkml: '' })
  })

  it('keeps the raw input when no part is recognizable', () => {
    const input = ['--weird', 'Content-Type: application/json', '', '{}', '--weird--'].join('\n')
    const parts = splitPageContent(input)
    expect(parts.html).toBe(input)
    expect(parts.inkml).toBe('')
  })
})
