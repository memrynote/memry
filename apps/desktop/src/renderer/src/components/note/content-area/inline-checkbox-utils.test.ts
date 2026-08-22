/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Promoting `| [ ] task |` back into a real checkbox on open.
 *
 * The pass is deliberately narrow, and these are mostly the cases where it must
 * do NOTHING: it runs over every note on every open, and a promotion that
 * over-reaches rewrites text somebody typed. The one it must catch is the whole
 * reason it exists — a checkbox written by hand, by another editor, or by this
 * app's own last save, all of which reach the renderer as literal text because
 * GFM's task-list syntax is list-item only.
 */

import type { Block } from '@blocknote/core'
import { describe, expect, it } from 'vitest'
import { matchLeadingCheckbox, normalizeInlineCheckboxes } from './inline-checkbox-utils'

const BOX = (checked: boolean) => ({ type: 'inlineCheckbox', props: { checked } })

/** A one-cell table whose only cell holds `content`. */
function tableWith(content: unknown): Block[] {
  return [
    {
      id: 'tbl',
      type: 'table',
      props: {},
      children: [],
      content: {
        type: 'tableContent',
        columnWidths: [null],
        rows: [{ cells: [{ type: 'tableCell', content, props: {} }] }]
      }
    }
  ] as unknown as Block[]
}

const cellOf = (blocks: Block[]): unknown => (blocks[0] as any).content.rows[0].cells[0].content

const textRun = (text: string, styles: Record<string, unknown> = {}) => ({
  type: 'text',
  text,
  styles
})

describe('matchLeadingCheckbox', () => {
  it('splits the token off the label', () => {
    expect(matchLeadingCheckbox('[ ] task')).toEqual({ checked: false, rest: 'task' })
    expect(matchLeadingCheckbox('[x] done')).toEqual({ checked: true, rest: 'done' })
    expect(matchLeadingCheckbox('[X] done')).toEqual({ checked: true, rest: 'done' })
  })

  it('claims a bare token with no label', () => {
    // #given the form a ticked box with nothing typed after it serializes to —
    // remark trims the node's trailing space at the cell edge
    expect(matchLeadingCheckbox('[ ]')).toEqual({ checked: false, rest: '' })
    expect(matchLeadingCheckbox('[x]')).toEqual({ checked: true, rest: '' })
  })

  it('declines a token that is not at the head', () => {
    expect(matchLeadingCheckbox('text [ ] more')).toBeNull()
    expect(matchLeadingCheckbox(' [ ] leading space')).toBeNull()
  })

  it('declines a token not followed by a space', () => {
    // #given `[ ]x` is somebody's notation, not a checkbox with a label
    expect(matchLeadingCheckbox('[ ]x')).toBeNull()
  })

  it('declines anything that is not the token', () => {
    expect(matchLeadingCheckbox('[y] task')).toBeNull()
    expect(matchLeadingCheckbox('[] task')).toBeNull()
    expect(matchLeadingCheckbox('[  ] task')).toBeNull()
    expect(matchLeadingCheckbox('')).toBeNull()
  })
})

describe('normalizeInlineCheckboxes', () => {
  it('promotes a cell reading `[x] done`', () => {
    // #given the cell as BlockNote parses it out of the vault file
    const blocks = tableWith([textRun('[x] done')])

    // #when
    const result = normalizeInlineCheckboxes(blocks)

    // #then the token becomes the node and the single separating space is
    // CONSUMED — the node re-emits one of its own, and keeping both would add a
    // space to the cell on every save
    expect(result.didChange).toBe(true)
    expect(cellOf(result.blocks)).toEqual([BOX(true), textRun('done')])
  })

  it('promotes an unticked cell', () => {
    const result = normalizeInlineCheckboxes(tableWith([textRun('[ ] task')]))
    expect(cellOf(result.blocks)).toEqual([BOX(false), textRun('task')])
  })

  it('promotes a cell that is nothing but the token', () => {
    const result = normalizeInlineCheckboxes(tableWith([textRun('[x]')]))
    expect(cellOf(result.blocks)).toEqual([BOX(true)])
  })

  it('leaves `text [ ] more` alone', () => {
    // #given the false positive the head-only rule exists to avoid
    const blocks = tableWith([textRun('text [ ] more')])

    // #when / #then untouched, and the same object — the editor re-renders on
    // identity, so a no-op pass must not manufacture a change
    const result = normalizeInlineCheckboxes(blocks)
    expect(result.didChange).toBe(false)
    expect(result.blocks).toBe(blocks)
  })

  it('leaves a paragraph that starts `[ ] ` alone', () => {
    // #given that gesture is BlockNote's `checkListItem`, and promoting here
    // would replace a checklist block with a node that behaves worse
    const blocks = [
      { id: 'p', type: 'paragraph', props: {}, children: [], content: [textRun('[ ] task')] }
    ] as unknown as Block[]

    // #when / #then
    expect(normalizeInlineCheckboxes(blocks).didChange).toBe(false)
  })

  it('keeps the label’s styles when it promotes', () => {
    const result = normalizeInlineCheckboxes(tableWith([textRun('[ ] task', { bold: true })]))
    expect(cellOf(result.blocks)).toEqual([BOX(false), textRun('task', { bold: true })])
  })

  it('keeps everything after the leading run', () => {
    // #given a cell whose label carries a wiki link, already promoted by the
    // pass that runs before this one
    const link = { type: 'wikiLink', props: { target: 'Roadmap', alias: '' } }
    const result = normalizeInlineCheckboxes(tableWith([textRun('[ ] see '), link]))
    expect(cellOf(result.blocks)).toEqual([BOX(false), textRun('see '), link])
  })

  it('does not touch a cell whose first item is not text', () => {
    // #given a cell that already opens with a node — whatever `[ ]` follows is
    // part of what that node's line says, not a marker for the cell
    const link = { type: 'wikiLink', props: { target: 'A', alias: '' } }
    const blocks = tableWith([link, textRun(' [ ] task')])
    expect(normalizeInlineCheckboxes(blocks).didChange).toBe(false)
  })

  it('handles a cell stored as a bare array', () => {
    // #given the other cell shape BlockNote writes, before a cell has props
    const blocks = [
      {
        id: 'tbl',
        type: 'table',
        props: {},
        children: [],
        content: {
          type: 'tableContent',
          columnWidths: [null],
          rows: [{ cells: [[textRun('[ ] task')]] }]
        }
      }
    ] as unknown as Block[]

    // #when
    const result = normalizeInlineCheckboxes(blocks)

    // #then
    expect(result.didChange).toBe(true)
    expect((result.blocks[0] as any).content.rows[0].cells[0]).toEqual([
      BOX(false),
      textRun('task')
    ])
  })

  it('handles a cell whose content is a plain string', () => {
    const result = normalizeInlineCheckboxes(tableWith('[x] done'))
    expect(cellOf(result.blocks)).toEqual([BOX(true), textRun('done')])
  })

  it('promotes a table nested under another block', () => {
    // #given tables can sit inside a column or a list item's children
    const blocks = [
      {
        id: 'outer',
        type: 'paragraph',
        props: {},
        children: tableWith([textRun('[ ] task')]),
        content: []
      }
    ] as unknown as Block[]

    // #when
    const result = normalizeInlineCheckboxes(blocks)

    // #then
    expect(result.didChange).toBe(true)
    expect(cellOf((result.blocks[0] as any).children)).toEqual([BOX(false), textRun('task')])
  })

  it('is a no-op for a table with no token in it', () => {
    const blocks = tableWith([textRun('plain')])
    const result = normalizeInlineCheckboxes(blocks)
    expect(result.didChange).toBe(false)
    expect(result.blocks).toBe(blocks)
  })

  it('bails before walking a note with no table at all', () => {
    // #given the overwhelmingly common case, on a pass that runs on every open.
    // The guard is a real `type === 'table'` test rather than a
    // `JSON.stringify(blocks).includes('[')` sniff — that string ALWAYS starts
    // with `[`, so the sniff spelled that way never bails at all.
    const blocks = [
      { id: 'p', type: 'paragraph', props: {}, children: [], content: [textRun('[ ] task')] }
    ] as unknown as Block[]

    // #when / #then
    const result = normalizeInlineCheckboxes(blocks)
    expect(result.didChange).toBe(false)
    expect(result.blocks).toBe(blocks)
  })

  it('leaves an already-promoted cell alone, so re-opening is idempotent', () => {
    // #given a note the editor has already normalized once this session
    const blocks = tableWith([BOX(false), textRun('task')])

    // #when / #then a second pass must not eat the label or double the box
    const result = normalizeInlineCheckboxes(blocks)
    expect(result.didChange).toBe(false)
    expect(cellOf(result.blocks)).toEqual([BOX(false), textRun('task')])
  })
})
