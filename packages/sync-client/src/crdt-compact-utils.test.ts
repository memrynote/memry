import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { compactYDoc } from './crdt-compact-utils'

const FRAGMENT = 'prosemirror'

function bloat(doc: Y.Doc): void {
  const fragment = doc.getXmlFragment(FRAGMENT)
  for (let i = 0; i < 200; i++) {
    const el = new Y.XmlElement('paragraph')
    const text = new Y.XmlText()
    text.insert(0, `line ${i} `.repeat(20))
    el.insert(0, [text])
    fragment.insert(fragment.length, [el])
  }
  // Churn so the doc carries deleted history worth compacting away.
  fragment.delete(0, 150)
}

describe('compactYDoc', () => {
  it('compacts a doc whose roots are all typed', () => {
    const doc = new Y.Doc({ gc: false })
    bloat(doc)
    doc.getMap('meta').set('title', 'note')

    const result = compactYDoc(doc, FRAGMENT)
    expect(result).not.toBeNull()

    const restored = new Y.Doc()
    Y.applyUpdate(restored, result!.compacted)
    expect(restored.getMap('meta').get('title')).toBe('note')
    expect(restored.getXmlFragment(FRAGMENT).length).toBe(50)
  })

  it('refuses to compact when a root is an untyped placeholder', () => {
    const source = new Y.Doc({ gc: false })
    bloat(source)
    source.getMap('markdownSource').set('record', { source: '# foreign\n' })

    // A doc that received the update without ever asking for `markdownSource`
    // by name holds it as a bare AbstractType.
    const doc = new Y.Doc({ gc: false })
    doc.getXmlFragment(FRAGMENT)
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(source))
    expect(doc.share.get('markdownSource')).not.toBeInstanceOf(Y.Map)

    expect(compactYDoc(doc, FRAGMENT)).toBeNull()

    // Once typed, compaction resumes and the root survives.
    expect(doc.getMap('markdownSource').get('record')).toEqual({ source: '# foreign\n' })
    const result = compactYDoc(doc, FRAGMENT)
    expect(result).not.toBeNull()
    const restored = new Y.Doc()
    Y.applyUpdate(restored, result!.compacted)
    expect(restored.getMap('markdownSource').get('record')).toEqual({ source: '# foreign\n' })
  })
})
