import { describe, expect, it } from 'vitest'

import { withoutImageBytes } from '../tool-image'

describe('withoutImageBytes', () => {
  it('drops the base64 of every MCP image part and keeps the rest of the result', () => {
    const codexResult = {
      content: [
        { type: 'text', text: '{"id":"file-1"}' },
        { type: 'image', data: 'A'.repeat(4096), mimeType: 'image/png' }
      ],
      structured_content: { id: 'file-1', width: 1568 }
    }

    expect(withoutImageBytes(codexResult)).toEqual({
      content: [
        { type: 'text', text: '{"id":"file-1"}' },
        { type: 'image', mimeType: 'image/png', dataOmitted: true }
      ],
      structured_content: { id: 'file-1', width: 1568 }
    })
  })

  it('handles the local backend output, whose images sit beside the data', () => {
    const output = {
      ok: true,
      data: { id: 'file-1' },
      images: [{ type: 'image', data: 'QUJD', mimeType: 'image/jpeg' }]
    }

    expect(withoutImageBytes(output)).toEqual({
      ok: true,
      data: { id: 'file-1' },
      images: [{ type: 'image', mimeType: 'image/jpeg', dataOmitted: true }]
    })
  })

  it('returns a result without images unchanged', () => {
    const plain = { id: 'note-1', tags: ['a'], nested: [{ type: 'text', text: 'x' }] }

    expect(withoutImageBytes(plain)).toBe(plain)
    expect(withoutImageBytes('text')).toBe('text')
    expect(withoutImageBytes(null)).toBeNull()
  })
})
