import { describe, it, expect } from 'vitest'
import { Root } from 'protobufjs'
import { descriptor, DOCUMENT_TYPE } from './descriptor.ts'
import { decodeNote } from './decode-note.ts'
import { docToMarkdown, ATTACHMENT_TOKEN_PREFIX } from './convert-doc.ts'
import { ANFontWeight, ANStyleType } from './types.ts'
import type { AttributeRun } from './types.ts'

/**
 * Encode a synthetic note document with our own descriptor, so the decode +
 * convert path is exercised end-to-end without a real NoteStore.sqlite.
 */
function encodeDocument(text: string, runs: AttributeRun[]): Uint8Array {
  const Document = Root.fromJSON(descriptor).lookupType(DOCUMENT_TYPE)
  const payload = { version: 1, note: { noteText: text, attributeRun: runs } }
  const err = Document.verify(payload)
  if (err) throw new Error(err)
  return Document.encode(Document.fromObject(payload)).finish()
}

describe('decodeNote + docToMarkdown round-trip', () => {
  it('decodes plain text and runs', () => {
    const text = 'Hello world\n'
    const bytes = encodeDocument(text, [{ length: text.length }])
    const doc = decodeNote(bytes)
    expect(doc.text).toBe(text)
    expect(doc.runs).toHaveLength(1)
    expect(doc.runs[0].length).toBe(text.length)
  })

  it('converts a title into an H1 heading', () => {
    const text = 'My Title\n'
    const bytes = encodeDocument(text, [
      { length: text.length, paragraphStyle: { styleType: ANStyleType.Title } }
    ])
    const { markdown } = docToMarkdown(decodeNote(bytes))
    expect(markdown).toBe('# My Title')
  })

  it('converts heading + subheading lines', () => {
    const text = 'Heading\nSub\n'
    const bytes = encodeDocument(text, [
      { length: 'Heading\n'.length, paragraphStyle: { styleType: ANStyleType.Heading } },
      { length: 'Sub\n'.length, paragraphStyle: { styleType: ANStyleType.Subheading } }
    ])
    const { markdown } = docToMarkdown(decodeNote(bytes))
    expect(markdown).toContain('## Heading')
    expect(markdown).toContain('### Sub')
  })

  it('applies bold formatting to a single run', () => {
    const text = 'a bold b\n'
    const bytes = encodeDocument(text, [
      { length: 'a '.length },
      { length: 'bold'.length, fontWeight: ANFontWeight.Bold },
      { length: ' b\n'.length }
    ])
    const { markdown } = docToMarkdown(decodeNote(bytes))
    expect(markdown).toBe('a **bold** b')
  })

  it('applies italic and strikethrough', () => {
    const text = 'i s\n'
    const bytes = encodeDocument(text, [
      { length: 'i'.length, fontWeight: ANFontWeight.Italic },
      { length: ' '.length },
      { length: 's'.length, strikethrough: 1 },
      { length: '\n'.length }
    ])
    const { markdown } = docToMarkdown(decodeNote(bytes))
    expect(markdown).toBe('*i* ~~s~~')
  })

  it('converts checkbox runs into task list items', () => {
    const text = 'todo\ndone\n'
    const bytes = encodeDocument(text, [
      {
        length: 'todo\n'.length,
        paragraphStyle: { styleType: ANStyleType.Checkbox, checklist: { done: 0 } }
      },
      {
        length: 'done\n'.length,
        paragraphStyle: { styleType: ANStyleType.Checkbox, checklist: { done: 1 } }
      }
    ])
    const { markdown } = docToMarkdown(decodeNote(bytes))
    expect(markdown).toContain('- [ ] todo')
    expect(markdown).toContain('- [x] done')
  })

  it('converts dashed and numbered lists', () => {
    const text = 'one\ntwo\n'
    const bytes = encodeDocument(text, [
      { length: 'one\n'.length, paragraphStyle: { styleType: ANStyleType.DashedList } },
      { length: 'two\n'.length, paragraphStyle: { styleType: ANStyleType.NumberedList } }
    ])
    const { markdown } = docToMarkdown(decodeNote(bytes))
    expect(markdown).toContain('- one')
    expect(markdown).toContain('1. two')
  })

  it('emits a markdown link for a linked run', () => {
    const text = 'click here\n'
    const bytes = encodeDocument(text, [
      { length: 'click here'.length, link: 'https://example.com' },
      { length: '\n'.length }
    ])
    const { markdown } = docToMarkdown(decodeNote(bytes))
    expect(markdown).toBe('[click here](https://example.com)')
  })

  it('wraps monospaced runs in a fenced code block', () => {
    const text = 'code line\n'
    const bytes = encodeDocument(text, [
      { length: text.length, paragraphStyle: { styleType: ANStyleType.Monospaced } }
    ])
    const { markdown } = docToMarkdown(decodeNote(bytes))
    expect(markdown).toContain('```')
    expect(markdown).toContain('code line')
  })

  it('collects inline image attachment ids and emits a placeholder token', () => {
    // Object-replacement char (U+FFFC) is the placeholder Apple uses for inline
    // attachments. The run carries an attachmentInfo with a file UTI.
    const text = '￼\n'
    const bytes = encodeDocument(text, [
      {
        length: 1,
        attachmentInfo: { attachmentIdentifier: 'ATT-123', typeUti: 'public.jpeg' }
      },
      { length: '\n'.length }
    ])
    const { markdown, attachmentIds } = docToMarkdown(decodeNote(bytes))
    expect(attachmentIds).toEqual(['ATT-123'])
    expect(markdown).toContain(`![](${ATTACHMENT_TOKEN_PREFIX}ATT-123)`)
  })

  it('emits an attachment on its own line without inheriting a heading/title prefix', () => {
    // Apple Notes can style an attachment-only paragraph as Title; the embedded
    // image must not become `# ![](...)` (which breaks the renderer file/image block).
    const text = '￼\n'
    const bytes = encodeDocument(text, [
      {
        length: 1,
        paragraphStyle: { styleType: ANStyleType.Title },
        attachmentInfo: { attachmentIdentifier: 'ATT-T', typeUti: 'public.png' }
      },
      { length: '\n'.length, paragraphStyle: { styleType: ANStyleType.Title } }
    ])
    const { markdown } = docToMarkdown(decodeNote(bytes))
    expect(markdown).toContain(`![](${ATTACHMENT_TOKEN_PREFIX}ATT-T)`)
    expect(markdown).not.toContain('#')
  })

  it('marks deferred attachment types (tables) without throwing', () => {
    const text = '￼\n'
    const bytes = encodeDocument(text, [
      {
        length: 1,
        attachmentInfo: { attachmentIdentifier: 'TBL-1', typeUti: 'com.apple.notes.table' }
      },
      { length: '\n'.length }
    ])
    const { markdown, attachmentIds } = docToMarkdown(decodeNote(bytes))
    expect(attachmentIds).toEqual([])
    expect(markdown).toContain('unsupported attachment')
  })

  it('handles an empty note body', () => {
    const bytes = encodeDocument('', [])
    const { markdown, attachmentIds } = docToMarkdown(decodeNote(bytes))
    expect(markdown).toBe('')
    expect(attachmentIds).toEqual([])
  })
})
