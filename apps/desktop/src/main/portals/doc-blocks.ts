import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { PORTAL_BLOCK_LANGUAGE, anchorSuffix, extractAnchor } from '@memry/shared/portal-block'
import { ORIGIN_LOCAL } from '../sync/crdt-provider'

/** Node names whose content is not a run of inline text, so ` ^anchor` cannot go at its end. */
const NON_TEXT_CONTENT = new Set(['codeBlock', 'table', 'image', 'video', 'audio', 'file'])

/** Stand-in for an inline element (mention, tag, link target) in a block's text. */
const INLINE_ELEMENT = '\uFFFC'

type Container = Y.XmlElement

export interface DocBlock {
  id: string
  /** The block's own text, anchor included. Empty for a block without inline text. */
  text: string
  /** The element holding the inline runs, or null for a block without any. */
  content: Y.XmlElement | null
}

function isElement(node: unknown): node is Y.XmlElement {
  return node instanceof Y.XmlElement
}

/** The block's content node: its first child that is not the nested `blockGroup`. */
function contentOf(container: Container): Y.XmlElement | null {
  for (const child of container.toArray()) {
    if (isElement(child) && child.nodeName !== 'blockGroup') return child
  }
  return null
}

function textOf(content: Y.XmlElement): string {
  let text = ''
  for (const child of content.toArray()) {
    if (child instanceof Y.XmlText) {
      for (const op of child.toDelta() as { insert?: unknown }[]) {
        text += typeof op.insert === 'string' ? op.insert : INLINE_ELEMENT
      }
    } else if (isElement(child)) text += INLINE_ELEMENT
  }
  return text
}

function hasInlineText(content: Y.XmlElement): boolean {
  if (NON_TEXT_CONTENT.has(content.nodeName)) return false
  return content
    .toArray()
    .every(
      (child) => child instanceof Y.XmlText || (isElement(child) && child.nodeName !== 'tableRow')
    )
}

/** Every block of the note in document order, nested ones after their parent. */
export function listDocBlocks(doc: Y.Doc): DocBlock[] {
  const blocks: DocBlock[] = []
  const visit = (node: Y.XmlFragment | Y.XmlElement): void => {
    for (const child of node.toArray()) {
      if (!isElement(child)) continue
      if (child.nodeName === 'blockContainer') {
        const id = child.getAttribute('id')
        const content = contentOf(child)
        if (typeof id === 'string' && id !== '') {
          const readable = content !== null && hasInlineText(content)
          const isFenceOfOurs =
            content?.nodeName === 'codeBlock' &&
            content.getAttribute('language') === PORTAL_BLOCK_LANGUAGE
          blocks.push({
            id,
            text: readable && !isFenceOfOurs ? textOf(content) : '',
            content: readable ? content : null
          })
        }
      }
      visit(child)
    }
  }
  visit(doc.getXmlFragment(CRDT_FRAGMENT_NAME))
  return blocks
}

/** Anchors already present in the note, so a new one never collides. */
export function anchorsInDoc(blocks: readonly DocBlock[]): Set<string> {
  const anchors = new Set<string>()
  for (const block of blocks) {
    const anchor = extractAnchor(block.text)
    if (anchor) anchors.add(anchor)
  }
  return anchors
}

export type StampOutcome =
  { kind: 'stamped' | 'existing'; anchor: string } | { kind: 'missing-block' }

/**
 * Give a block its ` ^anchor`, or report the one it has. The suffix goes at
 * the end of the block's last text run and takes none of that run's marks, so
 * a bold or linked tail does not swallow the anchor. Returns `missing-block`
 * for a block that does not exist or has no inline text to carry it (code,
 * table, media).
 */
export function stampAnchorInDoc(
  doc: Y.Doc,
  blockId: string,
  makeAnchor: (taken: ReadonlySet<string>) => string
): StampOutcome {
  const blocks = listDocBlocks(doc)
  const block = blocks.find((candidate) => candidate.id === blockId)
  if (!block || block.content === null) return { kind: 'missing-block' }

  const existing = extractAnchor(block.text)
  if (existing) return { kind: 'existing', anchor: existing }

  const anchor = makeAnchor(anchorsInDoc(blocks))
  const content = block.content
  doc.transact(() => {
    const last = content.toArray().at(-1)
    if (last instanceof Y.XmlText) {
      const attributes: Record<string, null> = {}
      for (const op of last.toDelta() as { attributes?: Record<string, unknown> }[]) {
        for (const name of Object.keys(op.attributes ?? {})) attributes[name] = null
      }
      last.insert(last.length, anchorSuffix(anchor), attributes)
    } else {
      const text = new Y.XmlText()
      content.insert(content.length, [text])
      text.insert(0, anchorSuffix(anchor))
    }
  }, ORIGIN_LOCAL)
  return { kind: 'stamped', anchor }
}
