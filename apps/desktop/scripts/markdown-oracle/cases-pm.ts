/**
 * Inputs of `pm-schema.json` and `yxml.json`. Expected outputs come from the
 * oracle (`pm-oracle.ts`); nothing here states an answer.
 *
 * Yjs documents are built here from small trees and stored as update hex, so
 * the Rust harness needs no builder and a case reads as the structure it pins.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as Y from 'yjs'

import type { OracleCase } from './cases-frontmatter'

const here = dirname(fileURLToPath(import.meta.url))
const NOTE_BLOCKS = resolve(here, '../../../../packages/contracts/test-vectors/note-blocks.json')
/**
 * What shipped releases wrote (`blocknote-history.mts`): their documents are read by this
 * build's schema, so a mark or attribute a release wrote and this schema dropped shows here.
 */
const RELEASE_DOCS = ['0.47.1'].map((version) => ({
  version,
  path: resolve(
    here,
    `../../../../packages/contracts/test-vectors/markdown-convert/blocknote-${version}.json`
  )
}))

/**
 * One node per distinct content expression: `inline*` (paragraph), `text*`
 * (codeBlock), leaf (divider, wikiLink), and every structural expression.
 * The rest share an expression with one of these, which the schema dump pins.
 */
const NODE_NAMES = [
  'doc',
  'paragraph',
  'codeBlock',
  'divider',
  'wikiLink',
  'table',
  'tableRow',
  'tableCell',
  'tableParagraph',
  'blockContainer',
  'blockGroup',
  'column',
  'columnList'
]
function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}

export function pmSchemaCases(): OracleCase[] {
  const cases: OracleCase[] = [{ id: 'pm-schema/schema/memry', op: 'schema', input: {} }]
  for (const node of NODE_NAMES) {
    cases.push({ id: `pm-content/match-sweep/${kebab(node)}`, op: 'match-sweep', input: { node } })
    cases.push({
      id: `pm-content/find-wrapping/${kebab(node)}`,
      op: 'find-wrapping',
      input: { node }
    })
  }
  return cases
}

interface El {
  tag: string
  attrs?: Record<string, unknown>
  children?: Child[]
}
interface Run {
  runs: { insert: string; attributes?: Record<string, unknown> }[]
}
type Child = El | Run

function build(child: Child): Y.XmlElement | Y.XmlText {
  if ('runs' in child) {
    const text = new Y.XmlText()
    text.applyDelta(child.runs)
    return text
  }
  const element = new Y.XmlElement(child.tag)
  for (const [key, value] of Object.entries(child.attrs ?? {})) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- setAttribute is typed for strings; Yjs stores any JSON value or undefined
    element.setAttribute(key, value as string)
  }
  element.insert(0, (child.children ?? []).map(build))
  return element
}

/** The update of a document whose fragment holds `roots`, authored under a fixed client id. */
export function updateHex(roots: Child[]): string {
  const doc = new Y.Doc()
  doc.clientID = 0x6d656d72
  doc.getXmlFragment('prosemirror').insert(0, roots.map(build))
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString('hex')
}

const text = (insert: string, attributes?: Record<string, unknown>): Run => ({
  runs: [{ insert, attributes }]
})
const block = (tag: string, attrs: Record<string, unknown>, children: Child[] = []): El => ({
  tag,
  attrs,
  children
})
const container = (id: string, content: El, nested?: El): El => ({
  tag: 'blockContainer',
  attrs: { id },
  children: nested ? [content, nested] : [content]
})
const group = (...containers: El[]): El => ({ tag: 'blockGroup', children: containers })
const para = (...children: Child[]): El => ({ tag: 'paragraph', children })
const doc = (...containers: El[]): Child[] => [group(...containers)]

function handCases(): { slug: string; roots: Child[] }[] {
  const one = (...children: Child[]): Child[] => doc(container('a', para(...children)))
  return [
    { slug: 'minimal-paragraph', roots: one(text('hello')) },
    { slug: 'surrogate-pair-text', roots: one(text('a 😀 b')) },
    { slug: 'empty-xml-text', roots: one({ runs: [] }) },
    {
      slug: 'extra-attribute-dropped',
      roots: doc(container('a', block('paragraph', { bogus: 'x', textColor: 'red' }, [text('x')])))
    },
    {
      slug: 'undefined-and-null-attributes',
      roots: doc(
        container('a', block('numberedListItem', { start: undefined }, [text('one')])),
        container('b', block('image', { url: 'u', previewWidth: null })),
        container('c', block('heading', { level: 3, isToggleable: true }, [text('h')]))
      )
    },
    { slug: 'marks-sorted-by-rank', roots: one(text('x', { italic: {}, bold: {}, strike: {} })) },
    { slug: 'hashed-mark-name', roots: one(text('x', { 'bold--abCD12+/': {} })) },
    { slug: 'mark-attribute-non-map', roots: one(text('x', { bold: true })) },
    {
      slug: 'link-and-color-marks',
      roots: one({
        runs: [
          { insert: 'see ', attributes: { textColor: { stringValue: 'red' } } },
          { insert: 'link', attributes: { link: { href: 'https://example.com' }, bold: {} } }
        ]
      })
    },
    { slug: 'unknown-mark-drops-text', roots: one(text('gone', { sparkle: {} }), text('kept')) },
    { slug: 'adjacent-runs-join', roots: one(text('ab'), text('cd')) },
    { slug: 'adjacent-runs-differ', roots: one(text('ab', { bold: {} }), text('cd')) },
    {
      slug: 'hard-break-and-atoms',
      roots: one(
        text('a'),
        block('hardBreak', {}),
        block('wikiLink', { target: 'T', alias: 'A' }),
        text('b')
      )
    },
    {
      slug: 'code-block-rejects-marks',
      roots: doc(
        container('a', block('codeBlock', { language: 'js' }, [text('x', { bold: {} })])),
        container('b', para(text('after')))
      )
    },
    {
      slug: 'unknown-node-drops-container',
      roots: doc(container('a', block('mysteryBlock', {}, [text('x')])))
    },
    {
      slug: 'unknown-node-keeps-sibling',
      roots: doc(container('a', block('mysteryBlock', {})), container('b', para(text('kept'))))
    },
    {
      slug: 'text-directly-in-block-group',
      roots: [{ tag: 'blockGroup', children: [text('loose')] }]
    },
    {
      slug: 'childless-table-row',
      roots: doc(
        container('a', block('table', {}, [{ tag: 'tableRow' }])),
        container('b', para(text('after')))
      )
    },
    {
      slug: 'table-with-header-and-cells',
      roots: doc(
        container(
          'a',
          block('table', {}, [
            {
              tag: 'tableRow',
              children: [
                block('tableHeader', { colwidth: [100, null] }, [
                  { tag: 'tableParagraph', children: [text('h')] }
                ]),
                block('tableHeader', {}, [{ tag: 'tableParagraph', children: [text('i')] }])
              ]
            },
            {
              tag: 'tableRow',
              children: [
                block('tableCell', { colspan: 2 }, [
                  { tag: 'tableParagraph', children: [text('c')] }
                ])
              ]
            }
          ])
        )
      )
    },
    {
      slug: 'column-list-with-one-column',
      roots: doc(container('a', para(text('before'))), {
        tag: 'columnList',
        attrs: { id: 'cl' },
        children: [
          {
            tag: 'column',
            attrs: { id: 'c1', width: 1 },
            children: [container('x', para(text('only')))]
          }
        ]
      })
    },
    {
      slug: 'column-list-valid',
      roots: [
        group(container('a', para(text('before')))),
        {
          tag: 'columnList',
          attrs: { id: 'cl' },
          children: [
            { tag: 'column', attrs: { id: 'c1' }, children: [container('x', para(text('l')))] },
            { tag: 'column', attrs: { id: 'c2' }, children: [container('y', para(text('r')))] }
          ]
        }
      ]
    },
    {
      slug: 'nested-invalid-group-removed',
      roots: doc(
        container('a', para(text('parent')), group(container('b', block('mysteryBlock', {}))))
      )
    },
    {
      slug: 'nested-blocks',
      roots: doc(
        container(
          'a',
          block('bulletListItem', {}, [text('p')]),
          group(container('b', block('bulletListItem', {}, [text('c')])))
        )
      )
    },
    {
      slug: 'block-container-beside-block-group',
      roots: [group(container('a', para(text('in')))), container('b', para(text('loose')))]
    },
    { slug: 'text-at-fragment-root', roots: [text('bare')] },
    { slug: 'empty-fragment', roots: [] }
  ]
}

export function yxmlCases(): OracleCase[] {
  const cases: OracleCase[] = []
  const sources: { slug: string; updateHex: string }[] = []
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the file is a committed vector
  const noteBlocks = JSON.parse(readFileSync(NOTE_BLOCKS, 'utf8')) as {
    cases: { name: string; updateHex: string }[]
  }
  for (const entry of noteBlocks.cases) {
    const slug = `note-blocks-${entry.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')}`
    sources.push({ slug, updateHex: entry.updateHex })
  }
  for (const release of RELEASE_DOCS) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the file is a committed vector
    const file = JSON.parse(readFileSync(release.path, 'utf8')) as {
      docs: { name: string; updateHex?: string }[]
    }
    for (const entry of file.docs) {
      if (entry.updateHex === undefined) continue
      const slug = entry.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
      sources.push({ slug: `bn-${release.version}-${slug}`, updateHex: entry.updateHex })
    }
  }
  for (const hand of handCases())
    sources.push({ slug: hand.slug, updateHex: updateHex(hand.roots) })
  for (const source of sources) {
    const input = { updateHex: source.updateHex, fragment: 'prosemirror' }
    cases.push({ id: `yxml/read/${source.slug}`, op: 'yxml-read', input })
    cases.push({ id: `yxml/roundtrip/${source.slug}`, op: 'yxml-roundtrip', input })
  }
  return cases
}
