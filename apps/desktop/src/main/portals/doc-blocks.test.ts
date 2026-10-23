import * as Y from 'yjs'
import { describe, expect, it, vi } from 'vitest'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'

vi.mock('../sync/crdt-provider', () => ({ ORIGIN_LOCAL: 'local' }))

import { listDocBlocks, stampAnchorInDoc } from './doc-blocks'

interface BlockSpec {
  id: string
  type?: string
  runs?: { text: string; marks?: Record<string, unknown> }[]
  children?: BlockSpec[]
}

function build(specs: BlockSpec[]): Y.Doc {
  const doc = new Y.Doc()
  const make = (spec: BlockSpec): Y.XmlElement => {
    const container = new Y.XmlElement('blockContainer')
    container.setAttribute('id', spec.id)
    const content = new Y.XmlElement(spec.type ?? 'paragraph')
    container.insert(0, [content])
    const text = new Y.XmlText()
    content.insert(0, [text])
    let at = 0
    for (const run of spec.runs ?? []) {
      text.insert(at, run.text, run.marks ?? {})
      at += run.text.length
    }
    if (spec.children?.length) {
      const group = new Y.XmlElement('blockGroup')
      container.insert(1, [group])
      group.insert(0, spec.children.map(make))
    }
    return container
  }
  const root = new Y.XmlElement('blockGroup')
  doc.getXmlFragment(CRDT_FRAGMENT_NAME).insert(0, [root])
  root.insert(0, specs.map(make))
  return doc
}

const fixed = () => 'fix123'

describe('stampAnchorInDoc', () => {
  it('appends " ^anchor" to the block text', () => {
    const doc = build([{ id: 'b1', runs: [{ text: 'Chloroplast notes' }] }])
    expect(stampAnchorInDoc(doc, 'b1', fixed)).toEqual({ kind: 'stamped', anchor: 'fix123' })
    expect(listDocBlocks(doc)[0].text).toBe('Chloroplast notes ^fix123')
  })

  it('returns the existing anchor and writes nothing', () => {
    const doc = build([{ id: 'b1', runs: [{ text: 'Done ^abc123' }] }])
    const before = Y.encodeStateAsUpdate(doc)
    expect(stampAnchorInDoc(doc, 'b1', fixed)).toEqual({ kind: 'existing', anchor: 'abc123' })
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })

  it('does not let the suffix inherit the last run marks', () => {
    const doc = build([
      { id: 'b1', runs: [{ text: 'plain ' }, { text: 'bold', marks: { bold: true } }] }
    ])
    stampAnchorInDoc(doc, 'b1', fixed)
    const block = listDocBlocks(doc)[0]
    const delta = (block.content?.toArray().at(-1) as Y.XmlText).toDelta()
    expect(delta.at(-1)).toEqual({ insert: ' ^fix123' })
  })

  it('hands the generator the anchors already in the note', () => {
    const doc = build([
      { id: 'b1', runs: [{ text: 'one ^taken1' }] },
      {
        id: 'b2',
        children: [{ id: 'b3', runs: [{ text: 'nested ^taken2' }] }],
        runs: [{ text: 'two' }]
      }
    ])
    const seen: string[][] = []
    stampAnchorInDoc(doc, 'b2', (taken) => {
      seen.push([...taken].sort())
      return 'fix123'
    })
    expect(seen).toEqual([['taken1', 'taken2']])
  })

  it('finds a nested block', () => {
    const doc = build([
      { id: 'b1', runs: [{ text: 'p' }], children: [{ id: 'b2', runs: [{ text: 'child' }] }] }
    ])
    expect(stampAnchorInDoc(doc, 'b2', fixed)).toEqual({ kind: 'stamped', anchor: 'fix123' })
  })

  it('reports a missing block and a block that cannot carry text', () => {
    const doc = build([{ id: 'b1', type: 'codeBlock', runs: [{ text: 'let x = 1' }] }])
    expect(stampAnchorInDoc(doc, 'nope', fixed)).toEqual({ kind: 'missing-block' })
    expect(stampAnchorInDoc(doc, 'b1', fixed)).toEqual({ kind: 'missing-block' })
    expect(listDocBlocks(doc)[0].text).toBe('')
  })
})
