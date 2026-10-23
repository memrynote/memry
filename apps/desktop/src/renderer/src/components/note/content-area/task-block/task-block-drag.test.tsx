import { afterEach, describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { BlockNoteEditor, BlockNoteSchema, defaultBlockSpecs } from '@blocknote/core'
import { NodeSelection } from 'prosemirror-state'
import { MEMRY_TASK_DRAG_MIME } from '@/lib/drag-mime'
import { createTaskBlock } from './index'
import { useTaskBlockDragData } from './task-block-drag'

const mounted: HTMLElement[] = []

afterEach(() => {
  for (const el of mounted.splice(0)) el.remove()
})

/** The `blocknote/html` a side-menu drag of block `index` writes: the editor's own clipboard serialization of that block. */
function dragHtml(index: number): string {
  const editor = BlockNoteEditor.create({
    schema: BlockNoteSchema.create({
      blockSpecs: { ...defaultBlockSpecs, taskBlock: createTaskBlock() }
    }),
    initialContent: [
      { type: 'paragraph', content: 'Morning notes' },
      { type: 'taskBlock', props: { taskId: 'task-1', title: 'Write the brief', checked: false } }
    ] as never
  })
  const el = document.createElement('div')
  document.body.appendChild(el)
  mounted.push(el)
  editor.mount(el)
  const view = editor.prosemirrorView!
  const positions: number[] = []
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === 'blockContainer') positions.push(pos)
  })
  const slice = NodeSelection.create(view.state.doc, positions[index]).content()
  return view.serializeForClipboard(slice).dom.innerHTML
}

function dispatchDragStart(html: string): Map<string, string> {
  const data = new Map([['blocknote/html', html]])
  const event = new Event('dragstart', { bubbles: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      getData: (type: string) => data.get(type) ?? '',
      setData: (type: string, value: string) => data.set(type, value)
    }
  })
  document.body.dispatchEvent(event)
  return data
}

describe('dragging a block out of the editor', () => {
  it('carries the task id when the dragged block is a task', () => {
    renderHook(() => useTaskBlockDragData())
    expect(dispatchDragStart(dragHtml(1)).get(MEMRY_TASK_DRAG_MIME)).toBe('task-1')
  })

  it('carries no task id for a paragraph', () => {
    renderHook(() => useTaskBlockDragData())
    expect(dispatchDragStart(dragHtml(0)).has(MEMRY_TASK_DRAG_MIME)).toBe(false)
  })
})
