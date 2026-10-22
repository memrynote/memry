import { describe, expect, it } from 'vitest'

import type { PortalDefinition } from './portal-block'
import { resolvePortal, type PortalSourceBlock } from './portal-resolve'

const b = (id: string, depth: number, text: string): PortalSourceBlock & { id: string } => ({
  id,
  depth,
  inline: [{ text }]
})
const ids = (blocks: Array<{ id: string }>): string[] => blocks.map((x) => x.id)
const block = (anchor: string, hidden: string[] = []): PortalDefinition => ({
  target: { kind: 'block', note: 'n1', block: anchor },
  hidden
})

const doc = [
  b('a', 0, 'Intro'),
  b('b', 0, 'Parent ^par1'),
  b('c', 1, 'Child one ^ch01'),
  b('d', 2, 'Grandchild'),
  b('e', 1, 'Child two ^ch02'),
  b('f', 0, 'Sibling')
]

describe('resolvePortal', () => {
  it('shows every block for a note target', () => {
    const r = resolvePortal({ target: { kind: 'note', note: 'n1' }, hidden: [] }, doc)
    expect(r.status).toBe('ok')
    expect(ids(r.blocks as typeof doc)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })

  it('shows the anchored block and its descendants', () => {
    expect(ids(resolvePortal(block('par1'), doc).blocks as typeof doc)).toEqual([
      'b',
      'c',
      'd',
      'e'
    ])
  })

  it('drops a hidden child with its subtree', () => {
    expect(ids(resolvePortal(block('par1', ['ch01']), doc).blocks as typeof doc)).toEqual([
      'b',
      'e'
    ])
  })

  it('ignores a hidden root', () => {
    expect(ids(resolvePortal(block('par1', ['par1']), doc).blocks as typeof doc)).toEqual([
      'b',
      'c',
      'd',
      'e'
    ])
  })

  it('reports missing-block for an unknown anchor', () => {
    expect(resolvePortal(block('nope1'), doc)).toEqual({ status: 'missing-block', blocks: [] })
  })

  it('does not match anchor-like text mid-line', () => {
    const r = resolvePortal(block('mid1'), [b('x', 0, 'see ^mid1 later')])
    expect(r.status).toBe('missing-block')
  })

  it('takes the first of duplicate anchors', () => {
    const r = resolvePortal(block('dup1'), [b('x', 0, 'One ^dup1'), b('y', 0, 'Two ^dup1')])
    expect(ids(r.blocks as Array<{ id: string }>)).toEqual(['x'])
  })
})
