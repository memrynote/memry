import { describe, expect, it } from 'vitest'
import { buildTaskTree } from './tree.ts'

const t = (id: string, parentId: string | null = null) => ({ id, parentId })

describe('buildTaskTree', () => {
  it('walks any depth: descendants depth first, ancestors nearest first', () => {
    const tree = buildTaskTree([t('a'), t('b', 'a'), t('c', 'b'), t('d', 'a'), t('e', 'c')])

    expect(tree.roots.map((x) => x.id)).toEqual(['a'])
    expect(tree.descendantIds('a')).toEqual(['b', 'c', 'e', 'd'])
    expect(tree.ancestorIds('e')).toEqual(['c', 'b', 'a'])
    expect(tree.depth('e')).toBe(3)
    expect(tree.childrenOf('a').map((x) => x.id)).toEqual(['b', 'd'])
  })

  // Two devices re-parenting at once can leave A under B and B under A.
  it('breaks a parent loop at its smallest id, whatever the input order', () => {
    for (const rows of [
      [t('y', 'x'), t('x', 'z'), t('z', 'y'), t('w', 'z')],
      [t('w', 'z'), t('z', 'y'), t('x', 'z'), t('y', 'x')]
    ]) {
      const tree = buildTaskTree(rows)
      expect(tree.roots.map((x) => x.id)).toEqual(['x'])
      expect(tree.descendantIds('x').sort()).toEqual(['w', 'y', 'z'])
      expect(tree.ancestorIds('w')).toEqual(['z', 'y', 'x'])
    }
  })

  it('treats a task that names itself as its parent as top level', () => {
    expect(buildTaskTree([t('a', 'a')]).roots.map((x) => x.id)).toEqual(['a'])
  })

  // Older builds deleted a parent without its subtasks; those rows never showed.
  it('leaves a task with a missing parent out of the tree', () => {
    const tree = buildTaskTree([t('a'), t('orphan', 'gone'), t('under-orphan', 'orphan')])

    expect(tree.roots.map((x) => x.id)).toEqual(['a'])
    expect(tree.descendantIds('a')).toEqual([])
    expect(tree.ancestorIds('under-orphan')).toEqual(['orphan'])
  })
})
