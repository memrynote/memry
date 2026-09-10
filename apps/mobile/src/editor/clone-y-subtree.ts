import * as Y from 'yjs'
import { BRIDGE_FRAGMENT_NAME } from '@memry/contracts/webview-bridge'
import { generateId } from '../features/notes/note-ops'
import { createLogger } from '../lib/logger'

const log = createLogger('CloneYSubtree')

/**
 * Deep-copy one `blockContainer` subtree into another document's blockGroup
 * (#2100).
 *
 * The host COPIES; it never BUILDS. The contract comment on `doc-load`'s
 * `seedMarkdown` forbids the host turning markdown into blocks because that is
 * a surface writing structures the other shells cannot read. This is the
 * opposite: every attribute and every mark is carried across verbatim, so a
 * node type this build has never heard of survives byte-faithful — stronger
 * than the markdown route, not weaker. The ONE value the host changes is the
 * container id, and it changes it to a v4 UUID, which is exactly what
 * BlockNote's own `UniqueID` extension mints.
 *
 * Returns a thunk so the read and the write are separated: the snapshot is
 * taken from the live source doc at call time, inside the target draft's
 * mutation, and neither doc is held open across the other's commit.
 *
 * `index` inserts before that position instead of appending — see
 * `trailingEmptyParagraphIndex`.
 */
export function cloneYSubtree(src: Y.XmlElement): (into: Y.XmlElement, index?: number) => void {
  return (into, index) => {
    const copy = copyElement(src)
    if (index === undefined) into.push([copy])
    else into.insert(index, [copy])
  }
}

function copyElement(src: Y.XmlElement): Y.XmlElement {
  const copy = new Y.XmlElement(src.nodeName)

  // 1. ATTRIBUTES, verbatim. `heading.level`, `callout.type`,
  //    `paragraph.textColor` / `backgroundColor` / `textAlignment`,
  //    `image.url` — the host reads none of them and must not.
  for (const [name, value] of Object.entries(src.getAttributes())) {
    if (src.nodeName === 'blockContainer' && name === 'id') continue
    copy.setAttribute(name, value as string)
  }
  // 2. IDS. Fresh on EVERY blockContainer in the subtree, not just the root.
  //    Reuse would put one id in two notes for as long as the source delete is
  //    outstanding — and a crash makes that "for ever". `generateId()` is a v4
  //    UUID, the same shape BlockNote generates, and nothing in Memry parses a
  //    block id.
  if (src.nodeName === 'blockContainer') copy.setAttribute('id', generateId())

  // 3. CHILDREN, in order. A blockContainer's children are its content element
  //    plus an OPTIONAL nested `blockGroup` (`sync/note-materializer.ts` walks
  //    exactly this shape); a content element's children are a mix of
  //    `Y.XmlText` runs and `Y.XmlElement` inline atoms (wiki-link chips,
  //    inline images, date mentions). One loop handles all three because the
  //    dispatch is on the node type, not on the name.
  const children: (Y.XmlElement | Y.XmlText)[] = []
  for (let i = 0; i < src.length; i++) {
    const child = src.get(i)
    if (child instanceof Y.XmlElement) children.push(copyElement(child))
    else if (child instanceof Y.XmlText) children.push(copyText(child))
    // `Y.XmlHook` has no place in Memry's schema. Log and skip rather than
    // throw — losing a hook is better than aborting a move. The cast is
    // because the declared union says this branch is unreachable while the
    // runtime type it names is not.
    else {
      const other = child as { constructor: { name: string } }
      log.warn('Skipped an unclonable node', { child: other.constructor.name })
    }
  }
  // A `blockContainer` is its content element; one with nothing in it is a
  // block BlockNote cannot render, and writing that into a note breaks the
  // note on every device. It means the source was emptied under us — a pull
  // deleting the block while this was reading it — so refuse rather than
  // publish the wreckage.
  if (children.length === 0 && src.nodeName === 'blockContainer') {
    throw new Error('That block has no content to move')
  }
  if (children.length > 0) copy.push(children)
  return copy
}

function copyText(src: Y.XmlText): Y.XmlText {
  const copy = new Y.XmlText()
  // `toDelta()` carries text AND marks (bold, italic, code, link href, every
  // custom mark) as one array that `applyDelta` re-creates exactly.
  // `toString()` would drop every mark; walking marks by hand would drop the
  // ones this build has never heard of — which is the whole reason to copy
  // rather than rebuild.
  //
  // Both calls are legal on an UNINTEGRATED type: Yjs queues them in `_pending`
  // and flushes when the tree is finally pushed into the target document.
  copy.applyDelta(src.toDelta())
  return copy
}

/** The `blockContainer` carrying `blockId`, anywhere in the doc. */
export function findBlockContainer(doc: Y.Doc, blockId: string): Y.XmlElement | null {
  const fragment = doc.getXmlFragment(BRIDGE_FRAGMENT_NAME)
  const stack: (Y.XmlElement | Y.XmlText)[] = []
  for (let i = fragment.length - 1; i >= 0; i--) {
    const child = fragment.get(i)
    if (child instanceof Y.XmlElement) stack.push(child)
  }

  while (stack.length > 0) {
    const node = stack.pop()
    if (!(node instanceof Y.XmlElement)) continue
    if (node.nodeName === 'blockContainer' && node.getAttribute('id') === blockId) return node
    // Depth-first, and it descends through EVERY element rather than only the
    // two names it expects: a nested block lives under a `blockGroup` that is
    // itself under a `blockContainer`, and a name check here would have to be
    // kept in step with a structure the schema owns.
    for (let i = node.length - 1; i >= 0; i--) {
      const child = node.get(i)
      if (child instanceof Y.XmlElement) stack.push(child)
    }
  }
  return null
}

/** The fragment's single top-level `blockGroup` — where a moved block lands. */
export function topBlockGroup(doc: Y.Doc): Y.XmlElement | null {
  const fragment = doc.getXmlFragment(BRIDGE_FRAGMENT_NAME)
  // `null` when the fragment is EMPTY, which is NOT a case to paper over by
  // minting one: an empty doc can still be a note whose real body has not been
  // seeded into it yet, and the seed guard in `move-block.ts` is what decides
  // whether writing into it is safe.
  for (let i = 0; i < fragment.length; i++) {
    const child = fragment.get(i)
    if (child instanceof Y.XmlElement && child.nodeName === 'blockGroup') return child
  }
  return null
}

/**
 * Where the group's trailing EMPTY paragraph sits, or `null` when it has none.
 *
 * BlockNote keeps a blank paragraph at the end of most notes so there is
 * somewhere to put the caret. Appending after it leaves the moved block below
 * a stray blank line; inserting before it puts the block where the reader
 * would have typed it and keeps the caret line where it was.
 */
export function trailingEmptyParagraphIndex(group: Y.XmlElement): number | null {
  const index = group.length - 1
  if (index < 0) return null
  const last = group.get(index)
  if (!(last instanceof Y.XmlElement) || last.nodeName !== 'blockContainer') return null

  const first = last.get(0)
  if (!(first instanceof Y.XmlElement) || first.nodeName !== 'paragraph') return null
  if (!isEmptyContent(first)) return null

  // A container with children is not a blank line, whatever its own paragraph
  // holds — inserting before it would jump the moved block above them.
  for (let i = 1; i < last.length; i++) {
    const child = last.get(i)
    if (child instanceof Y.XmlElement && child.nodeName === 'blockGroup') return null
  }
  return index
}

/**
 * Whether a content element holds nothing a reader would see.
 *
 * An inline ATOM — a wiki-link chip, an inline image, a date mention — is
 * content even though it carries no text, so the check is on the children and
 * not on `toString()`.
 */
function isEmptyContent(element: Y.XmlElement): boolean {
  for (let i = 0; i < element.length; i++) {
    const child = element.get(i)
    if (child instanceof Y.XmlText) {
      if (child.toString().length > 0) return false
    } else {
      return false
    }
  }
  return true
}
