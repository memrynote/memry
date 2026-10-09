import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { renamedTag, type TagRename } from '@memry/shared/inline-tags'
import { ORIGIN_LOCAL } from '../sync/crdt-provider'

const INLINE_TAG_PATTERN = /#([a-zA-Z][a-zA-Z0-9_-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_-]*)*)/g

/**
 * Renames the body `#tags` of an open note inside its live doc, so the editor
 * and its pending edits keep their place and the change merges like typing.
 * A `hashTag` chip gets its `tag` attribute set; a `#tag` still held as text
 * is rewritten in place with its marks. Code blocks and `code`-marked text are
 * left alone, as `rewriteInlineTagsInMarkdown` leaves code in a file. Returns
 * whether anything changed.
 */
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
  const edits: Array<{ at: number; length: number; next: string; attributes: object }> = []
  let offset = 0
  let before = ''
  for (const op of text.toDelta() as TextOp[]) {
    if (typeof op.insert !== 'string') {
      offset += 1
      before = '\u0000'
      continue
    }
    const run = op.insert
    if (!op.attributes?.code) {
      for (const match of run.matchAll(INLINE_TAG_PATTERN)) {
        const preceding = match.index > 0 ? run[match.index - 1] : before
        if (preceding && !/\s/.test(preceding)) continue
        const next = renamedTag(match[1], renames)
        if (next === null || next === match[1]) continue
        edits.push({
          at: offset + match.index + 1,
          length: match[1].length,
          next,
          attributes: op.attributes ?? {}
        })
      }
    }
    offset += run.length
    if (run) before = run[run.length - 1]
  }
  for (const edit of edits.reverse()) {
    text.delete(edit.at, edit.length)
    text.insert(edit.at, edit.next, edit.attributes)
  }
  return edits.length > 0
}
