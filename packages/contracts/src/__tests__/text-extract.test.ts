/**
 * Verifier for `text-extract.json` (T076).
 *
 * Applies each recorded update to a fresh `Y.Doc` and runs the reference
 * extractor, so the file is proven to be what the extractor actually produces
 * rather than what someone wrote down.
 *
 * This is also the guard on the SC-010 digest: both shells compute the digest
 * over `title + "\n" + extract_text(doc)`, so if the two ports disagree the
 * digest comparison fails for a reason that has nothing to do with content.
 * Pinning the extractor here is what stops that.
 */
import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'

import { extractText } from '../../scripts/extract-text'
import { fromHex, loadVectorFile } from './vector-loader'

const vectors = loadVectorFile<{
  meta: { caseCount: number; fragmentName: string; extractor: string }
  cases: Array<{ name: string; pins: string; updateHex: string; expectedText: string }>
}>('text-extract.json')

function applied(updateHex: string): Y.Doc {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, fromHex(updateHex))
  return doc
}

describe('text-extract vectors', () => {
  it('carries the recorded case count', () => {
    expect(vectors.cases).toHaveLength(vectors.meta.caseCount)
  })

  it('walks the prosemirror fragment', () => {
    expect(vectors.meta.fragmentName).toBe('prosemirror')
  })

  for (const entry of vectors.cases) {
    it(entry.name, () => {
      expect(extractText(applied(entry.updateHex)), entry.pins).toBe(entry.expectedText)
    })
  }

  it('heading markers are kept', () => {
    const entry = vectors.cases.find((c) => c.name === 'headings at every level')!
    expect(entry.expectedText.split('\n')).toEqual([
      '# Level 1',
      '## Level 2',
      '### Level 3',
      '#### Level 4',
      '##### Level 5',
      '###### Level 6'
    ])
  })

  it('list markers are kept, and numbering is NOT reconstructed', () => {
    const ordered = vectors.cases.find((c) => c.name === 'an ordered list')!
    expect(ordered.expectedText.split('\n').every((l) => l.startsWith('1. '))).toBe(true)
    const unordered = vectors.cases.find((c) => c.name === 'an unordered list')!
    expect(unordered.expectedText.split('\n').every((l) => l.startsWith('- '))).toBe(true)
  })

  it('inline marks and link targets are dropped', () => {
    const entry = vectors.cases.find((c) => c.name === 'inline marks')!
    expect(entry.expectedText).toBe('bold plain link')
    expect(entry.expectedText).not.toContain('example.invalid')
    expect(entry.expectedText).not.toContain('**')
  })

  it('a nested block contributes exactly one line, not two', () => {
    // The duplication a naive walker produces: emit the parent's line, then
    // re-walk the parent and emit its inline text a second time.
    const entry = vectors.cases.find((c) => c.name === 'a nested list')!
    expect(entry.expectedText.split('\n')).toEqual(['- Outer', '- Inner'])
  })

  it('an empty document extracts to the empty string, not a newline', () => {
    const entry = vectors.cases.find((c) => c.name === 'an empty document')!
    expect(entry.expectedText).toBe('')
  })

  it('non-ASCII text survives byte for byte', () => {
    const entry = vectors.cases.find((c) => c.name === 'a non-ASCII body')!
    expect(entry.expectedText).toContain('Grüße')
    expect(entry.expectedText).toContain('世界')
    expect(entry.expectedText).toContain('🙂')
  })

  it('an unknown block type still contributes its text', () => {
    // Never strip what you do not recognise: a block a future schema adds must
    // reach search rather than vanish from it.
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment('prosemirror')
    const container = new Y.XmlElement('blockContainer')
    fragment.insert(0, [container])
    const unknown = new Y.XmlElement('someBlockFromTheFuture')
    container.insert(0, [unknown])
    unknown.insert(0, [new Y.XmlText('still searchable')])
    expect(extractText(doc)).toContain('still searchable')
  })
})
