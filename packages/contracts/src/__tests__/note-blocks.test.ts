/**
 * Verifier for `note-blocks.json` (N104).
 *
 * Applies each recorded update to a fresh `Y.Doc` and runs the reference block
 * walk, so the file is proven to be what the walk actually produces rather
 * than what someone wrote down. It reads the committed file and never imports
 * the builder — rule 2 of `test-vectors/README.md`.
 *
 * **Why this class exists at all.** `extract_blocks` had no vector class, and
 * the only test holding it compared the block walk against the text walk of
 * the *same port* — two readings that agree with each other whether or not
 * either is right. Dropping `divider` passed that test. So the assertions
 * below are deliberately about the things a self-consistency check cannot
 * see: that a divider is a block, that a colour mark carries its value, that
 * a table keeps its rows, and that the registry is covered.
 */
import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import registryManifest from '@memry/editor-schema/registry-manifest.json' with { type: 'json' }

import { extractBlocks, type Block } from '../../scripts/extract-blocks'
import { canonicalFragment } from '../../scripts/fragment-canonical'
import { fromHex, loadVectorFile } from './vector-loader'

interface Case {
  name: string
  pins: string
  updateHex: string
  expectedBlocks: Block[]
  expectedCanonical: string
}

const vectors = loadVectorFile<{
  meta: {
    caseCount: number
    fragmentName: string
    registry: { blocks: number; inline: number; styles: number }
  }
  cases: Case[]
}>('note-blocks.json')

function applied(updateHex: string): Y.Doc {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, fromHex(updateHex))
  return doc
}

const byName = new Map(vectors.cases.map((entry) => [entry.name, entry]))
function required(name: string): Case {
  const entry = byName.get(name)
  if (!entry) throw new Error(`the class has no case named ${name}`)
  return entry
}

/** Every `kind` the corpus produces, across every case. */
const producedKinds = new Set(
  vectors.cases.flatMap((entry) => entry.expectedBlocks.map((block) => block.kind))
)
/** Every mark name the corpus produces. */
const producedMarks = new Set(
  vectors.cases.flatMap((entry) =>
    entry.expectedBlocks.flatMap((block) => block.inline.flatMap((run) => run.marks))
  )
)

describe('note-blocks vectors', () => {
  it('carries the recorded case count', () => {
    expect(vectors.cases).toHaveLength(vectors.meta.caseCount)
  })

  it('walks the prosemirror fragment', () => {
    expect(vectors.meta.fragmentName).toBe('prosemirror')
  })

  for (const entry of vectors.cases) {
    it(entry.name, () => {
      const doc = applied(entry.updateHex)
      expect(extractBlocks(doc), entry.pins).toEqual(entry.expectedBlocks)
      expect(canonicalFragment(doc), entry.pins).toBe(entry.expectedCanonical)
    })
  }

  // MARK: coverage, asserted against the registry rather than eyeballed

  it('covers every block type in the FR-040 registry', () => {
    // A type nobody wrote a case for is a failing test, which is what makes
    // "a new block type is not done until it has a case" enforceable rather
    // than a review note. `table` contributes its rows and cells too.
    const missing = registryManifest.blocks.filter((kind) => !producedKinds.has(kind))
    expect(missing, `no case produces these block types: ${missing.join(', ')}`).toEqual([])
    expect(registryManifest.blocks).toHaveLength(vectors.meta.registry.blocks)
  })

  it('covers every inline type in the registry', () => {
    // `text` is not a mark — it is the run itself, and every case with text
    // exercises it. The other seven arrive as marks on a run.
    const inlineMarks = registryManifest.inline.filter((type) => type !== 'text')
    const missing = inlineMarks.filter((type) => !producedMarks.has(type))
    expect(missing, `no case produces these inline types: ${missing.join(', ')}`).toEqual([])
    expect(registryManifest.inline).toHaveLength(vectors.meta.registry.inline)
  })

  it('covers every style in the registry', () => {
    const missing = registryManifest.styles.filter((style) => !producedMarks.has(style))
    expect(missing, `no case produces these styles: ${missing.join(', ')}`).toEqual([])
    expect(registryManifest.styles).toHaveLength(vectors.meta.registry.styles)
  })

  // MARK: the specific losses this class was built to catch

  it('a divider is a block, and it does not swallow its neighbours', () => {
    // The defect: `divider` was in the walk's SKIPPED list, which returned
    // before pushing, so the shell's `case "divider"` was unreachable code.
    const kinds = required('divider').expectedBlocks.map((block) => block.kind)
    expect(kinds).toEqual(['paragraph', 'divider', 'paragraph'])
  })

  it('a colour mark carries its value, not just its name', () => {
    // The defect: the walk recorded the mark NAME and captured a value only
    // for link/href, so `textColor=red` and `textColor=blue` were identical.
    const run = required('styles: textColor and backgroundColor').expectedBlocks[0].inline[0]
    expect(run.marks).toContain('textColor')
    expect(run.markAttrs.textColor).toBe('red')
    expect(run.markAttrs.backgroundColor).toBe('yellow')
  })

  it('two colours in one paragraph stay two colours', () => {
    const runs = required('styles: two colours in one paragraph').expectedBlocks[0].inline
    const coloured = runs.filter((run) => run.markAttrs.textColor !== undefined)
    expect(coloured.map((run) => run.markAttrs.textColor)).toEqual(['red', 'blue'])
  })

  it('top-level blocks are at depth zero', () => {
    // §12.5.0 makes the fragment's single top-level child a `blockGroup`. A
    // walk that counted it as nesting reported every top-level block at
    // depth 1, and a shell indenting by depth drew the whole note one step
    // in.
    for (const entry of vectors.cases) {
      if (entry.expectedBlocks.length === 0) continue
      expect(
        Math.min(...entry.expectedBlocks.map((block) => block.depth)),
        `${entry.name} has no block at depth 0`
      ).toBe(0)
    }
  })

  it('a nested list item is one level deeper than its parent', () => {
    const depths = required('bulletListItem').expectedBlocks.map((block) => block.depth)
    expect(depths).toEqual([0, 1, 0])
  })

  it('a table keeps its rows, its cells and its column width', () => {
    // The defect: `table` and `tableRow` were containers and only
    // `blockGroup` raised depth, so every cell of every row arrived at one
    // depth with no row boundary and no column count.
    const blocks = required('table').expectedBlocks
    const table = blocks[0]
    expect(table.kind).toBe('table')
    expect(table.depth).toBe(0)
    expect(table.id, 'the table must keep an addressable id').not.toBeNull()

    const rows = blocks.filter((block) => block.kind === 'tableRow')
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.depth === 1)).toBe(true)

    const headers = blocks.filter((block) => block.kind === 'tableHeader')
    expect(headers).toHaveLength(2)
    expect(headers[0].props.find((prop) => prop.name === 'colwidth')?.value).toBe('[180]')

    const coloured = blocks
      .filter((block) => block.kind === 'tableCell')
      .find((cell) =>
        cell.props.some((prop) => prop.name === 'backgroundColor' && prop.value === 'yellow')
      )
    expect(coloured, 'the coloured cell keeps its colour').toBeDefined()
  })

  it('a task block carries its text as a prop, not as inline content', () => {
    // `taskBlock` is `content: none`. A reader that only walks inline content
    // renders an empty row, which is why the case exists.
    const block = required('taskBlock').expectedBlocks[0]
    expect(block.inline).toEqual([])
    expect(block.props.find((prop) => prop.name === 'title')?.value).toBe('A task in a note')
  })

  it('a wiki link keeps its target and its alias', () => {
    const run = required('inline: wikiLink').expectedBlocks[0].inline[1]
    expect(run.marks).toContain('wikiLink')
    expect(run.target).toBe('Dune Messiah')
    expect(run.markAttrs['wikiLink.alias']).toBe('the sequel')
  })

  it('an empty document is an empty list, not one empty paragraph', () => {
    expect(required('an empty document').expectedBlocks).toEqual([])
    expect(required('an empty document').expectedCanonical).toBe('')
  })

  it('an unknown block type crosses rather than being dropped', () => {
    // FR-033, over a type no schema in this build declares. Built here rather
    // than in the corpus because BlockNote cannot author a node its schema
    // does not know.
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment('prosemirror')
    const group = new Y.XmlElement('blockGroup')
    fragment.insert(0, [group])
    const container = new Y.XmlElement('blockContainer')
    group.insert(0, [container])
    const unknown = new Y.XmlElement('someBlockFromTheFuture')
    container.insert(0, [unknown])
    unknown.setAttribute('mood', 'curious')
    unknown.insert(0, [new Y.XmlText('still here')])

    const blocks = extractBlocks(doc)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe('someBlockFromTheFuture')
    expect(blocks[0].depth).toBe(0)
    expect(blocks[0].props).toEqual([{ name: 'mood', value: 'curious' }])
    expect(blocks[0].inline[0].text).toBe('still here')
  })

  it('an unknown mark keeps its run and its value', () => {
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment('prosemirror')
    const group = new Y.XmlElement('blockGroup')
    fragment.insert(0, [group])
    const container = new Y.XmlElement('blockContainer')
    group.insert(0, [container])
    const paragraph = new Y.XmlElement('paragraph')
    container.insert(0, [paragraph])
    const text = new Y.XmlText()
    paragraph.insert(0, [text])
    text.insert(0, 'sparkling', { sparkle: { stringValue: 'bright' } })

    const run = extractBlocks(doc)[0].inline[0]
    expect(run.text).toBe('sparkling')
    expect(run.marks).toEqual(['sparkle'])
    expect(run.markAttrs.sparkle).toBe('bright')
  })
})
