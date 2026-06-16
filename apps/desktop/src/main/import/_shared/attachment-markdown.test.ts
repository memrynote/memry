import { describe, it, expect } from 'vitest'
import {
  encodeAttachmentUrl,
  serializeFileBlockMarker,
  attachmentMarkdown
} from './attachment-markdown'

describe('encodeAttachmentUrl', () => {
  it('encodes spaces and parens so markdown link parsing does not break', () => {
    const url = 'memry-file://local/Users/me/attachments/x/ab12-Pasted Graphic (1).png'
    expect(encodeAttachmentUrl(url)).toBe(
      'memry-file://local/Users/me/attachments/x/ab12-Pasted%20Graphic%20%281%29.png'
    )
  })

  it('leaves scheme and path separators intact', () => {
    const url = 'memry-file://local/Users/me/file.png'
    expect(encodeAttachmentUrl(url)).toBe(url)
  })
})

describe('attachmentMarkdown', () => {
  it('embeds an image inline with the filename as alt and an encoded url', () => {
    const md = attachmentMarkdown({
      success: true,
      path: 'memry-file://local/v/attachments/n/a-My Pic.png',
      name: 'My Pic.png',
      size: 10,
      mimeType: 'image/png',
      type: 'image'
    })
    expect(md).toBe('![My Pic.png](memry-file://local/v/attachments/n/a-My%20Pic.png)')
  })

  it('renders a non-image file as a file-block marker (clickable)', () => {
    const md = attachmentMarkdown({
      success: true,
      path: 'memry-file://local/v/attachments/n/a-Sheet.xlsx',
      name: 'Sheet.xlsx',
      size: 99,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      type: 'file'
    })
    expect(md).toMatch(/^<!-- file:\{.*\} -->$/)
    expect(md).toContain('"name":"Sheet.xlsx"')
    expect(md).not.toMatch(/^!\[/)
  })

  it('returns null when the save failed', () => {
    expect(attachmentMarkdown({ success: false, error: 'nope' })).toBeNull()
  })
})

describe('serializeFileBlockMarker', () => {
  it('matches the renderer file-block line format', () => {
    const marker = serializeFileBlockMarker({
      success: true,
      path: 'memry-file://local/v/a/n/doc.pdf',
      name: 'doc.pdf',
      size: 5,
      mimeType: 'application/pdf'
    })
    expect(/^<!-- file:\{[^}]+\} -->$/.test(marker)).toBe(true)
    expect(JSON.parse(marker.match(/<!-- file:(\{[^}]+\}) -->/)![1])).toEqual({
      url: 'memry-file://local/v/a/n/doc.pdf',
      name: 'doc.pdf',
      size: 5,
      mimeType: 'application/pdf'
    })
  })
})
