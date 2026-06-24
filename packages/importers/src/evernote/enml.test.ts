import { describe, it, expect } from 'vitest'
import { prepareEnml } from './enml.ts'

const wrap = (inner: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note>${inner}</en-note>`

describe('prepareEnml', () => {
  it('strips the en-note wrapper and XML declaration', () => {
    const result = prepareEnml(wrap('<p>Hello world</p>'))
    expect(result).not.toContain('<en-note')
    expect(result).not.toContain('<?xml')
    expect(result).toContain('<p>Hello world</p>')
  })

  it('converts a checked en-todo to a checkbox list item', () => {
    const result = prepareEnml(wrap('<en-todo checked="true"/>Buy milk'))
    expect(result).toContain('<input type="checkbox" checked>')
    expect(result).toContain('Buy milk')
    expect(result).toContain('<ul><li>')
  })

  it('converts an unchecked en-todo to an unchecked checkbox', () => {
    const result = prepareEnml(wrap('<en-todo checked="false"/>Read book'))
    expect(result).toContain('<input type="checkbox">')
    expect(result).not.toContain('checked>')
    expect(result).toContain('Read book')
  })

  it('handles multiple todos', () => {
    const result = prepareEnml(
      wrap('<en-todo checked="true"/>Done<en-todo checked="false"/>Not done')
    )
    // Two list items
    const matches = result.match(/<input type="checkbox"/g) ?? []
    expect(matches).toHaveLength(2)
  })

  it('leaves en-media tags untouched', () => {
    const result = prepareEnml(wrap('<en-media hash="abc123" type="image/png"/>'))
    expect(result).toContain('en-media')
    expect(result).toContain('hash="abc123"')
  })

  it('handles en-note with attributes', () => {
    const enml =
      '<?xml version="1.0"?><en-note style="word-wrap: break-word;"><p>Text</p></en-note>'
    const result = prepareEnml(enml)
    expect(result).toContain('<p>Text</p>')
    expect(result).not.toContain('<en-note')
  })
})
