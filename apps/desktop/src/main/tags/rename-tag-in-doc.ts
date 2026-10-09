import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { findInlineTags, renamedTag, type TagRename } from '@memry/shared/inline-tags'
import { ORIGIN_LOCAL } from '../sync/crdt-provider'

export function renameTagsInDoc(doc: Y.Doc, renames: readonly TagRename[]): boolean {
  let changed = false
  const visit = (node: Y.XmlFragment | Y.XmlElement): void => {
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlElement) {
        if (child.nodeName === 'codeBlock') continue
        if (child.nodeName === 'hashTag') {
          const tag = child.getAttribute('tag')
          const next = typeof tag === 'string' ? renamedTag(tag, renames) : null
          if (next !== null && next !== tag) {
            child.setAttribute('tag', next)
            changed = true
          }
          continue
        }
        visit(child)
      } else if (child instanceof Y.XmlText) {
        if (renameTagsInText(child, renames)) changed = true
      }
    }
  }
  doc.transact(() => visit(doc.getXmlFragment(CRDT_FRAGMENT_NAME)), ORIGIN_LOCAL)
  return changed
}

type TextOp = { insert?: unknown; attributes?: Record<string, unknown> }

function renameTagsInText(text: Y.XmlText, renames: readonly TagRename[]): boolean {
  let joined = ''
  const at: number[] = []
  const attrsAt: Array<Record<string, unknown>> = []
  let offset = 0
  for (const op of text.toDelta() as TextOp[]) {
    if (typeof op.insert !== 'string') {
      joined += '\uFFFC'
      at.push(offset)
      attrsAt.push({})
      offset += 1
      continue
    }
    if (!op.attributes?.code) {
      for (let i = 0; i < op.insert.length; i += 1) {
        at.push(offset + i)
        attrsAt.push(op.attributes ?? {})
      }
      joined += op.insert
    }
    offset += op.insert.length
  }
  const edits: Array<{ at: number; length: number; next: string; attributes: object }> = []
  for (const { index, tag } of findInlineTags(joined)) {
    const next = renamedTag(tag, renames)
    if (next === null || next === tag) continue
    const first = index + 1
    const last = first + tag.length - 1
    if (at[last] - at[first] !== tag.length - 1) continue
    edits.push({ at: at[first], length: tag.length, next, attributes: attrsAt[first] })
  }
  for (const edit of edits.reverse()) {
    text.delete(edit.at, edit.length)
    text.insert(edit.at, edit.next, edit.attributes)
  }
  return edits.length > 0
}
