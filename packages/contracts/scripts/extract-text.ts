/**
 * The TypeScript reference `extract_text`.
 *
 * A plain-text walk of a note document's `prosemirror` `XmlFragment` that keeps
 * heading and list markers, drops everything else, and claims NO markdown
 * fidelity. It feeds FTS `content`, previews, and the SC-010 cross-shell
 * digest, and nothing else.
 *
 * This is the contract between the two ports: `text-extract.json` is generated
 * from this function, and a second implementation is asserted against the same
 * file. The digest comparison can therefore only fail on content, never on two
 * extractors nobody pinned.
 *
 * WHAT IS DELIBERATELY NOT CLAIMED. This is not markdown. A case whose output
 * looks like markdown is a coincidence of its input. Inline marks, colours,
 * link targets, table structure, callout types and toggle state are all
 * dropped: search and previews read better with heading and list markers and
 * worse with everything else.
 *
 * Chapter: docs/protocol/12-note-body-format.md §12.1, §12.11.
 */
import * as Y from 'yjs'

/** BlockNote list blocks, and the marker each contributes. */
const LIST_MARKERS: Record<string, string> = {
  bulletListItem: '- ',
  checkListItem: '- ',
  numberedListItem: '1. ',
  taskBlock: '- '
}

/** Blocks whose own text is dropped entirely. */
const SKIPPED_BLOCKS = new Set(['divider'])

function headingMarker(node: Y.XmlElement): string {
  const raw = node.getAttribute('level')
  const level = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number(raw ?? 1)
  const clamped = Number.isFinite(level) ? Math.min(Math.max(level, 1), 6) : 1
  return `${'#'.repeat(clamped)} `
}

/**
 * `Y.XmlText#toString()` wraps formatted runs in `<mark>` tags; drop them.
 * Until stable, so removing one tag cannot leave another behind.
 */
function stripMarkTags(text: string): string {
  let out = text
  let previous: string
  do {
    previous = out
    out = out.replace(/<[^>]*>/g, '')
  } while (out !== previous)
  return out
}

/**
 * The concatenated text of a node's own INLINE descendants, marks discarded.
 *
 * Stops at a nested block: that block contributes its own line, and folding it
 * into the parent's would silently merge two paragraphs into one.
 */
function plainTextOf(node: Y.XmlElement | Y.XmlFragment): string {
  let out = ''
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) out += stripMarkTags(child.toString())
    else if (child instanceof Y.XmlElement && isInline(child)) out += plainTextOf(child)
  }
  return out
}

/**
 * Blocks that contribute a line of their own.
 *
 * y-prosemirror nests a BlockNote block's children under a
 * `blockContainer`/`blockGroup` pair, so "is this a block" is decided by the
 * node name rather than by depth.
 */
const LINE_BLOCKS = new Set([
  'heading',
  'paragraph',
  'quote',
  'callout',
  'codeBlock',
  'toggleListItem',
  'tableCell',
  'tableHeader',
  ...Object.keys(LIST_MARKERS)
])

/** Structural nodes carrying no line of their own. */
const CONTAINERS = new Set(['blockContainer', 'blockGroup', 'table', 'tableRow'])

function isInline(node: Y.XmlElement): boolean {
  const name = node.nodeName
  return !LINE_BLOCKS.has(name) && !CONTAINERS.has(name) && !SKIPPED_BLOCKS.has(name)
}

function walk(node: Y.XmlElement | Y.XmlFragment, lines: string[]): void {
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) {
      const text = stripMarkTags(child.toString())
      if (text.length > 0) lines.push(text)
      continue
    }
    if (!(child instanceof Y.XmlElement)) continue

    const name = child.nodeName
    if (SKIPPED_BLOCKS.has(name)) continue

    if (CONTAINERS.has(name)) {
      walk(child, lines)
      continue
    }

    if (LINE_BLOCKS.has(name)) {
      const marker = name === 'heading' ? headingMarker(child) : (LIST_MARKERS[name] ?? '')
      const line = `${marker}${plainTextOf(child)}`.trimEnd()
      if (line.length > 0) lines.push(line)
      // A block may nest further blocks — a list inside a list item, a row
      // inside a table — and those contribute their own lines, AFTER this one.
      // Only the block children are followed: the inline children are already
      // in the line above, and walking them again would duplicate it.
      for (const grandchild of child.toArray()) {
        if (grandchild instanceof Y.XmlElement && !isInline(grandchild)) {
          walk(grandchild, lines)
        }
      }
      continue
    }

    // An unknown element is walked rather than dropped: a block type this port
    // does not know must still contribute its text. Never strip what you do
    // not recognise.
    walk(child, lines)
  }
}

export function extractText(doc: Y.Doc, fragmentName = 'prosemirror'): string {
  const lines: string[] = []
  walk(doc.getXmlFragment(fragmentName), lines)
  return lines.join('\n')
}
