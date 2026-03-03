import * as Y from 'yjs'
import { createLogger } from '../lib/logger'

const log = createLogger('CrdtCompaction')

export function compactYDoc(
  doc: Y.Doc,
  _fragmentName: string
): { compacted: Uint8Array; savedBytes: number } | null {
  const originalSize = Y.encodeStateAsUpdate(doc).byteLength

  const fresh = new Y.Doc({ gc: true })
  fresh.transact(() => {
    for (const [name, type] of doc.share) {
      if (type instanceof Y.XmlFragment) {
        copyXmlFragment(type, fresh.getXmlFragment(name))
      } else if (type instanceof Y.Map) {
        copyYMap(type as Y.Map<unknown>, fresh.getMap(name))
      } else if (type instanceof Y.Array) {
        copyYArray(type as Y.Array<unknown>, fresh.getArray(name))
      } else if (type instanceof Y.Text) {
        const dst = fresh.getText(name)
        dst.applyDelta(type.toDelta())
      } else {
        log.warn('Unknown shared type during compaction, skipping', {
          name,
          type: type.constructor.name
        })
      }
    }
  })

  const compacted = Y.encodeStateAsUpdate(fresh)
  fresh.destroy()

  const savedBytes = originalSize - compacted.byteLength
  if (savedBytes <= 0) {
    log.debug('Compaction would not reduce size', {
      originalSize,
      compactedSize: compacted.byteLength
    })
    return null
  }

  return { compacted, savedBytes }
}

export function copyXmlFragment(src: Y.XmlFragment, dst: Y.XmlFragment): void {
  for (let i = 0; i < src.length; i++) {
    const child = src.get(i)
    if (child instanceof Y.XmlElement) {
      const el = new Y.XmlElement(child.nodeName)
      dst.insert(dst.length, [el])
      const attrs = child.getAttributes()
      for (const [key, value] of Object.entries(attrs)) {
        if (value !== undefined) el.setAttribute(key, value)
      }
      copyXmlFragment(child, el)
    } else if (child instanceof Y.XmlText) {
      const delta = child.toDelta()
      const text = new Y.XmlText()
      dst.insert(dst.length, [text])
      if (delta.length > 0) {
        text.applyDelta(delta)
      }
    }
  }
}

export function copyYMap(src: Y.Map<unknown>, dst: Y.Map<unknown>): void {
  const json = src.toJSON()
  for (const [key, value] of Object.entries(json)) {
    dst.set(key, value)
  }
}

export function copyYArray(src: Y.Array<unknown>, dst: Y.Array<unknown>): void {
  const json = src.toJSON()
  dst.insert(0, json)
}
