import { Schema } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { describe, expect, it } from 'vitest'
import {
  PORTAL_USAGE_CHIP_KEY,
  createPortalUsageChipPlugin,
  scanAnchoredBlocks,
  usageCountsMeta
} from './portal-usage-chip-plugin'

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*', group: 'block' },
    text: {}
  }
})
const doc = (...lines: string[]) =>
  schema.node(
    'doc',
    null,
    lines.map((line) => schema.node('paragraph', null, line ? schema.text(line) : []))
  )

const options = { label: (count: number) => `${count}`, onOpen: () => {} }

describe('scanAnchoredBlocks', () => {
  it('finds blocks ending with an anchor and where their text ends', () => {
    const found = scanAnchoredBlocks(doc('Chloroplast ^chl-7f2a', 'plain', '2^10'))
    expect(found).toEqual([{ anchor: 'chl-7f2a', endPos: 1 + 'Chloroplast ^chl-7f2a'.length }])
  })
})

describe('usage chip plugin state', () => {
  it('draws a chip only for anchors with a count, and drops it when the count goes', () => {
    const state = EditorState.create({
      doc: doc('A ^aaaa', 'B ^bbbb'),
      plugins: [createPortalUsageChipPlugin(options)]
    })
    expect(PORTAL_USAGE_CHIP_KEY.getState(state)?.anchors).toEqual(['aaaa', 'bbbb'])

    const counted = state.apply(state.tr.setMeta(...usageCountsMeta(new Map([['aaaa', 3]]))))
    const chips = PORTAL_USAGE_CHIP_KEY.getState(counted)?.decorations.find()
    expect(chips).toHaveLength(1)

    const cleared = counted.apply(counted.tr.setMeta(...usageCountsMeta(new Map())))
    expect(PORTAL_USAGE_CHIP_KEY.getState(cleared)?.decorations.find()).toHaveLength(0)
  })

  it('rescans anchors when the document changes', () => {
    const state = EditorState.create({
      doc: doc('plain'),
      plugins: [createPortalUsageChipPlugin(options)]
    })
    const next = state.apply(state.tr.insertText(' ^new1', 6))
    expect(PORTAL_USAGE_CHIP_KEY.getState(next)?.anchors).toEqual(['new1'])
  })
})
