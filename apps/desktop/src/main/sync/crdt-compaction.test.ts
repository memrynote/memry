import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { compactYDoc, copyXmlFragment, copyYMap } from './crdt-compact-utils'

describe('crdt-compaction', () => {
  describe('compactYDoc', () => {
    it('reduces size of doc with heavy edit history', () => {
      // #given — doc with hundreds of overwrites generating tombstones
      const doc = new Y.Doc()
      const fragment = doc.getXmlFragment('prosemirror')
      const meta = doc.getMap('meta')
      meta.set('title', 'Test Note')

      for (let i = 0; i < 200; i++) {
        doc.transact(() => {
          if (fragment.length > 0) fragment.delete(0, fragment.length)
          const text = new Y.XmlText()
          text.insert(0, `Revision ${i} — some text content that gets overwritten each time`)
          const el = new Y.XmlElement('paragraph')
          el.insert(0, [text])
          fragment.insert(0, [el])
        })
      }

      const originalSize = Y.encodeStateAsUpdate(doc).byteLength

      // #when
      const result = compactYDoc(doc, 'prosemirror')

      // #then
      expect(result).not.toBeNull()
      expect(result!.savedBytes).toBeGreaterThan(0)
      expect(result!.compacted.byteLength).toBeLessThan(originalSize)

      doc.destroy()
    })

    it('preserves content after compaction', () => {
      // #given
      const doc = new Y.Doc()
      const fragment = doc.getXmlFragment('prosemirror')
      const meta = doc.getMap('meta')
      meta.set('title', 'Keep Me')
      meta.set('date', '2026-01-01')

      const tags = doc.getArray('tags')
      tags.push(['tag1', 'tag2'])

      doc.transact(() => {
        const text = new Y.XmlText()
        text.insert(0, 'Final content')
        const el = new Y.XmlElement('paragraph')
        el.insert(0, [text])
        fragment.insert(0, [el])
      })

      for (let i = 0; i < 50; i++) {
        meta.set('counter', i)
      }

      // #when
      const result = compactYDoc(doc, 'prosemirror')

      // #then — re-hydrate compacted into fresh doc and verify content
      const rehydrated = new Y.Doc()
      Y.applyUpdate(rehydrated, result!.compacted)

      const rMeta = rehydrated.getMap('meta')
      expect(rMeta.get('title')).toBe('Keep Me')
      expect(rMeta.get('date')).toBe('2026-01-01')
      expect(rMeta.get('counter')).toBe(49)

      const rTags = rehydrated.getArray('tags')
      expect(rTags.toJSON()).toEqual(['tag1', 'tag2'])

      const rFragment = rehydrated.getXmlFragment('prosemirror')
      expect(rFragment.length).toBe(1)

      doc.destroy()
      rehydrated.destroy()
    })

    it('returns null when compaction would not save space', () => {
      // #given — minimal doc with no edit history
      const doc = new Y.Doc()
      doc.getXmlFragment('prosemirror')
      doc.getMap('meta')
      doc.getArray('tags')

      // #when
      const result = compactYDoc(doc, 'prosemirror')

      // #then
      expect(result).toBeNull()

      doc.destroy()
    })
  })

  describe('copyXmlFragment', () => {
    it('deep-copies nested elements with attributes and text', () => {
      // #given — nested prosemirror-like structure
      const srcDoc = new Y.Doc()
      const srcFrag = srcDoc.getXmlFragment('test')
      srcDoc.transact(() => {
        const blockquote = new Y.XmlElement('blockquote')

        const p1 = new Y.XmlElement('paragraph')
        p1.setAttribute('align', 'center')
        const t1 = new Y.XmlText()
        t1.insert(0, 'Hello ')
        t1.format(0, 5, { bold: true })
        p1.insert(0, [t1])

        const p2 = new Y.XmlElement('paragraph')
        const t2 = new Y.XmlText()
        t2.insert(0, 'World')
        p2.insert(0, [t2])

        blockquote.insert(0, [p1, p2])
        srcFrag.insert(0, [blockquote])
      })

      // #when
      const dstDoc = new Y.Doc()
      const dstFrag = dstDoc.getXmlFragment('test')
      dstDoc.transact(() => {
        copyXmlFragment(srcFrag, dstFrag)
      })

      // #then
      expect(dstFrag.length).toBe(1)
      const blockquote = dstFrag.get(0) as Y.XmlElement
      expect(blockquote.nodeName).toBe('blockquote')
      expect(blockquote.length).toBe(2)

      const p1 = blockquote.get(0) as Y.XmlElement
      expect(p1.nodeName).toBe('paragraph')
      expect(p1.getAttribute('align')).toBe('center')

      const t1 = p1.get(0) as Y.XmlText
      const delta = t1.toDelta()
      expect(delta[0]).toEqual({ insert: 'Hello', attributes: { bold: true } })

      srcDoc.destroy()
      dstDoc.destroy()
    })
  })

  describe('copyYMap', () => {
    it('copies all key-value pairs including nested objects', () => {
      // #given
      const srcDoc = new Y.Doc()
      const srcMap = srcDoc.getMap('test')
      srcMap.set('str', 'hello')
      srcMap.set('num', 42)
      srcMap.set('nested', { a: 1, b: [2, 3] })

      // #when
      const dstDoc = new Y.Doc()
      const dstMap = dstDoc.getMap('test')
      dstDoc.transact(() => {
        copyYMap(srcMap, dstMap)
      })

      // #then
      expect(dstMap.get('str')).toBe('hello')
      expect(dstMap.get('num')).toBe(42)
      expect(dstMap.get('nested')).toEqual({ a: 1, b: [2, 3] })

      srcDoc.destroy()
      dstDoc.destroy()
    })
  })
})
