import { describe, expect, it } from 'vitest'

import type { PortalTarget } from './portal-block'
import { resolvePortal, type ResolverBlock } from './portal-resolve'

type B = ResolverBlock & { id: string }
const b = (id: string, depth: number, text: string): B => ({ id, depth, inline: [{ text }] })
const ids = (blocks: Array<{ id: string }>): string[] => blocks.map((x) => x.id)
const blocksTarget = (
  roots: string[],
  open: Extract<PortalTarget, { kind: 'blocks' }>['open'] = {}
): PortalTarget => ({ kind: 'blocks', note: 'n1', blocks: roots, open })

const doc: B[] = [
  b('a', 0, 'Intro'),
  b('b', 0, 'Parent ^par1'),
  b('c', 1, 'Child one ^ch01'),
  b('d', 2, 'Grandchild'),
  b('e', 1, 'Child two ^ch02'),
  b('f', 0, 'Sibling ^sib1'),
  b('g', 1, 'Sibling child')
]

describe('resolvePortal', () => {
  it('shows every block of a note target with nothing hidden', () => {
    const r = resolvePortal(doc, { kind: 'note', note: 'n1' })
    expect(r.status).toBe('ok')
    expect(ids(r.blocks)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
    expect(r.hidden).toEqual({ siblings: [], children: {} })
  })

  it('shows a collapsed root alone and reports what is hidden', () => {
    const r = resolvePortal(doc, blocksTarget(['par1']))
    expect(ids(r.blocks)).toEqual(['b'])
    expect(ids(r.hidden.siblings)).toEqual(['a', 'f'])
    expect(ids(r.hidden.children.par1)).toEqual(['c', 'e'])
  })

  it('hide-mode shows all children except the listed ones, with their subtrees gone', () => {
    const r = resolvePortal(doc, blocksTarget(['par1'], { par1: { mode: 'hide', ids: ['ch01'] } }))
    expect(ids(r.blocks)).toEqual(['b', 'e'])
    expect(ids(r.hidden.children.par1)).toEqual(['c'])
  })

  it('hide-mode with an empty list shows children but not collapsed grandchildren', () => {
    const r = resolvePortal(doc, blocksTarget(['par1'], { par1: { mode: 'hide', ids: [] } }))
    expect(ids(r.blocks)).toEqual(['b', 'c', 'e'])
    expect(ids(r.hidden.children.ch01)).toEqual(['d'])
  })

  it('show-mode shows only the listed children', () => {
    const r = resolvePortal(doc, blocksTarget(['par1'], { par1: { mode: 'show', ids: ['ch02'] } }))
    expect(ids(r.blocks)).toEqual(['b', 'e'])
    expect(ids(r.hidden.children.par1)).toEqual(['c'])
  })

  it('nested open: a grandchild shows only when its parent is visible and open', () => {
    const open = {
      par1: { mode: 'hide' as const, ids: [] },
      ch01: { mode: 'hide' as const, ids: [] }
    }
    expect(ids(resolvePortal(doc, blocksTarget(['par1'], open)).blocks)).toEqual([
      'b',
      'c',
      'd',
      'e'
    ])
    // ch01 is open but its parent is collapsed: nothing below the root shows.
    expect(ids(resolvePortal(doc, blocksTarget(['par1'], { ch01: open.ch01 })).blocks)).toEqual([
      'b'
    ])
  })

  it('multi-root keeps document order, not roots order', () => {
    const r = resolvePortal(doc, blocksTarget(['sib1', 'ch02']))
    expect(ids(r.blocks)).toEqual(['e', 'f'])
    expect(ids(r.hidden.siblings)).toEqual(['a', 'b', 'c'])
  })

  it('a root listed as a sibling-parent child counts hidden siblings by shared parent', () => {
    const r = resolvePortal(doc, blocksTarget(['ch01']))
    expect(ids(r.hidden.siblings)).toEqual(['e'])
  })

  it('include-parent shape: parent root with the previous root in show-mode', () => {
    const r = resolvePortal(doc, blocksTarget(['par1'], { par1: { mode: 'show', ids: ['ch01'] } }))
    expect(ids(r.blocks)).toEqual(['b', 'c'])
    expect(ids(r.hidden.children.par1)).toEqual(['e'])
    expect(ids(r.hidden.children.ch01)).toEqual(['d'])
  })

  it('create-child shape: a new show-listed child under a collapsed parent appears', () => {
    const withNew = [...doc.slice(0, 5), b('n', 1, 'New ^new01'), ...doc.slice(5)]
    const r = resolvePortal(
      withNew,
      blocksTarget(['par1'], { par1: { mode: 'show', ids: ['new01'] } })
    )
    expect(ids(r.blocks)).toEqual(['b', 'n'])
  })

  it('root-sibling shape: an appended root shows next to the first', () => {
    const r = resolvePortal(doc, blocksTarget(['sib1', 'par1']))
    expect(ids(r.blocks)).toEqual(['b', 'f'])
    expect(ids(r.hidden.siblings)).toEqual(['a'])
  })

  it('whole-note children of an unanchored visible block are not keyed', () => {
    const r = resolvePortal(doc, blocksTarget(['par1'], { par1: { mode: 'hide', ids: [] } }))
    expect(Object.keys(r.hidden.children)).toEqual(['ch01'])
  })

  it('reports missing-block when no root matches, and ignores a partly missing set', () => {
    const missing = resolvePortal(doc, blocksTarget(['nope1']))
    expect(missing).toEqual({
      status: 'missing-block',
      blocks: [],
      hidden: { siblings: [], children: {} }
    })
    expect(ids(resolvePortal(doc, blocksTarget(['nope1', 'sib1'])).blocks)).toEqual(['f'])
  })

  it('reports invalid for a search target', () => {
    expect(resolvePortal(doc, { kind: 'search', text: 'x', limit: 5 }).status).toBe('invalid')
  })

  it('does not match anchor-like text mid-line, and the first duplicate wins', () => {
    expect(resolvePortal([b('x', 0, 'see ^mid1 later')], blocksTarget(['mid1'])).status).toBe(
      'missing-block'
    )
    const r = resolvePortal(
      [b('x', 0, 'One ^dup1'), b('y', 0, 'Two ^dup1')],
      blocksTarget(['dup1'])
    )
    expect(ids(r.blocks)).toEqual(['x'])
  })

  it('joins inline runs to find an anchor', () => {
    const block: B = { id: 'r', depth: 0, inline: [{ text: 'Bold ^ru' }, { text: 'n01' }] }
    expect(ids(resolvePortal([block], blocksTarget(['run01'])).blocks)).toEqual(['r'])
  })
})
