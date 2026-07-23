import { describe, expect, it } from 'vitest'
import type { Block } from '@blocknote/core'

import { normalizeNoteBlocks } from './normalize-note-blocks'

function checkListItem(text: string, checked = false): Block {
  return {
    id: 'b1',
    type: 'checkListItem',
    props: { checked },
    content: [{ type: 'text', text, styles: {} }],
    children: []
  } as unknown as Block
}

describe('normalizeNoteBlocks', () => {
  it('turns a {task:id} checkbox into the taskBlock renderer', () => {
    const [block] = normalizeNoteBlocks([checkListItem('Sync v1 {task:PBmDWa-vpELwPFvP85kD2}')])

    expect(block.type).toBe('taskBlock')
    expect((block.props as Record<string, unknown>).taskId).toBe('PBmDWa-vpELwPFvP85kD2')
  })

  it('carries the checked state onto the task block', () => {
    const [block] = normalizeNoteBlocks([checkListItem('Done {task:abc123}', true)])

    expect(block.type).toBe('taskBlock')
    expect((block.props as Record<string, unknown>).taskId).toBe('abc123')
  })

  it('leaves a plain checkbox alone', () => {
    const [block] = normalizeNoteBlocks([checkListItem('Just a checkbox')])

    expect(block.type).toBe('checkListItem')
  })

  it('normalizes nested task markers under a task block', () => {
    const parent = {
      id: 'p1',
      type: 'checkListItem',
      props: { checked: false },
      content: [{ type: 'text', text: 'Parent {task:parent1}', styles: {} }],
      children: [checkListItem('Child {task:child1}')]
    } as unknown as Block

    const [block] = normalizeNoteBlocks([parent])

    expect(block.type).toBe('taskBlock')
    expect(block.children[0]?.type).toBe('taskBlock')
  })
})
