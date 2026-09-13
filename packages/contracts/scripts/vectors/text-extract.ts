/**
 * Class: text extraction (`text-extract.json`), 12 cases.
 *
 * Document bytes in, extracted plain text out. The extractor is the TypeScript
 * reference port in `packages/contracts/scripts/extract-text.ts`, which walks
 * the same `prosemirror` fragment a second implementation's `extract_text`
 * walks — so this file IS the contract between the two ports, and the SC-010
 * cross-shell digest can only fail on content rather than on two extractors
 * nobody pinned.
 *
 * Documents are built with `yjs` directly rather than loaded from a staging
 * vault fixture: a fixture would make the file reproducible only on a machine
 * holding that vault, which is the carve-out `vectors:check` exists to
 * prevent. The node names are BlockNote's, which is what the real documents
 * carry.
 *
 * WHAT IS NOT CLAIMED: this is not markdown. Headings and list markers are kept
 * because search and previews read better with them; everything else is
 * dropped. A case whose output looks like markdown is a coincidence of its
 * input.
 *
 * Chapter: docs/protocol/12-note-body-format.md §12.1, §12.11.
 */
import * as Y from 'yjs'

import { extractText } from '../extract-text'
import { meta } from './shared'

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

/**
 * A Y.Doc with a PINNED client id.
 *
 * `new Y.Doc()` draws a random `clientID`, and that id is encoded into every
 * update, so an unpinned document makes this class non-reproducible and
 * therefore exempt from the `vectors:check` gate — exactly the carve-out the
 * gate exists to prevent. The value is arbitrary; only its fixedness matters.
 */
const VECTOR_CLIENT_ID = 0x6d656d72

function fixedDoc(): Y.Doc {
  const doc = new Y.Doc()
  doc.clientID = VECTOR_CLIENT_ID
  return doc
}

/** `blockContainer` wrapping one block, as y-prosemirror nests them. */
function container(inner: Y.XmlElement): Y.XmlElement {
  const wrapper = new Y.XmlElement('blockContainer')
  wrapper.insert(0, [inner])
  return wrapper
}

function block(name: string, text?: string, attrs: Record<string, string> = {}): Y.XmlElement {
  const node = new Y.XmlElement(name)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
  if (text !== undefined) node.insert(0, [new Y.XmlText(text)])
  return node
}

function docOf(build: (fragment: Y.XmlFragment) => void): Y.Doc {
  const doc = fixedDoc()
  build(doc.getXmlFragment('prosemirror'))
  return doc
}

interface Spec {
  name: string
  build: (fragment: Y.XmlFragment) => void
  pins: string
}

const SPECS: Spec[] = [
  {
    name: 'a plain paragraph document',
    build: (f) => f.insert(0, [container(block('paragraph', 'One plain paragraph.'))]),
    pins: 'the simplest possible document'
  },
  {
    name: 'headings at every level',
    build: (f) =>
      f.insert(
        0,
        [1, 2, 3, 4, 5, 6].map((level) =>
          container(block('heading', `Level ${level}`, { level: String(level) }))
        )
      ),
    pins: 'heading markers are KEPT, and the level is clamped to 1..6'
  },
  {
    name: 'an ordered list',
    build: (f) =>
      f.insert(
        0,
        ['First', 'Second', 'Third'].map((t) => container(block('numberedListItem', t)))
      ),
    pins: 'every ordered item takes the same `1. ` marker; numbering is not reconstructed'
  },
  {
    name: 'an unordered list',
    build: (f) =>
      f.insert(
        0,
        ['Alpha', 'Beta'].map((t) => container(block('bulletListItem', t)))
      ),
    pins: 'bullet markers are kept'
  },
  {
    name: 'a nested list',
    build: (f) => {
      // Attached before the nested group goes in: reading `.length` on a
      // detached Yjs type logs "Invalid access", and a generator that prints
      // warnings trains people to ignore its output.
      const outer = block('bulletListItem', 'Outer')
      f.insert(0, [container(outer)])
      const group = new Y.XmlElement('blockGroup')
      outer.insert(outer.length, [group])
      group.insert(0, [container(block('bulletListItem', 'Inner'))])
    },
    pins: 'a nested block contributes its own line; indentation is NOT preserved'
  },
  {
    name: 'a table',
    build: (f) => {
      const table = new Y.XmlElement('table')
      const header = new Y.XmlElement('tableRow')
      header.insert(0, [block('tableHeader', 'Name'), block('tableHeader', 'Value')])
      const row = new Y.XmlElement('tableRow')
      row.insert(0, [block('tableCell', 'alpha'), block('tableCell', '1')])
      table.insert(0, [header, row])
      f.insert(0, [container(table)])
    },
    pins: 'each cell is its own line; the grid is not reconstructed'
  },
  {
    name: 'a callout',
    build: (f) => f.insert(0, [container(block('callout', 'Mind the gap.', { type: 'info' }))]),
    pins: 'the callout type is dropped; only its text survives'
  },
  {
    name: 'a toggle',
    build: (f) => {
      const toggle = block('toggleListItem', 'Summary line')
      f.insert(0, [container(toggle)])
      const group = new Y.XmlElement('blockGroup')
      toggle.insert(toggle.length, [group])
      group.insert(0, [container(block('paragraph', 'Hidden body.'))])
    },
    pins: 'open or closed is a rendering fact and is not extracted; the body IS'
  },
  {
    name: 'a code block',
    build: (f) =>
      f.insert(0, [
        container(block('codeBlock', 'const x = 1\nconsole.log(x)', { language: 'ts' }))
      ]),
    pins: 'the language is dropped and no fence is emitted'
  },
  {
    name: 'inline marks',
    build: (f) => {
      const paragraph = new Y.XmlElement('paragraph')
      const text = new Y.XmlText()
      text.insert(0, 'bold', { bold: true })
      text.insert(4, ' plain ')
      text.insert(11, 'link', { link: 'https://example.invalid' })
      paragraph.insert(0, [text])
      f.insert(0, [container(paragraph)])
    },
    pins: 'marks are discarded and link targets are NOT emitted; only the visible text survives'
  },
  {
    name: 'an empty document',
    build: () => {},
    pins: 'the empty string, not a newline'
  },
  {
    name: 'a non-ASCII body',
    build: (f) =>
      f.insert(0, [
        container(block('paragraph', 'Grüße, 世界 — «citation» 🙂')),
        container(block('heading', 'Überschrift', { level: '2' }))
      ]),
    pins: 'the walker is byte-transparent over UTF-8; combining marks and astral code points survive'
  }
]

export function buildTextExtract(): Record<string, unknown> {
  const cases = SPECS.map((spec) => {
    const doc = docOf(spec.build)
    return {
      name: spec.name,
      pins: spec.pins,
      updateHex: hex(Y.encodeStateAsUpdate(doc)),
      expectedText: extractText(doc)
    }
  })

  return {
    meta: meta({
      class: 'text-extract',
      chapter: 'docs/protocol/12-note-body-format.md §12.1, §12.11',
      extractor: 'packages/contracts/scripts/extract-text.ts',
      fragmentName: 'prosemirror',
      notClaimed:
        'this is not markdown; heading and list markers are kept and everything else is dropped',
      caseCount: cases.length
    }),
    cases
  }
}
