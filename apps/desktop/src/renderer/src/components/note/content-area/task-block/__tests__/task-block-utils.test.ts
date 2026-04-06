import { describe, it, expect } from 'vitest'
import {
  isLikelyTask,
  serializeTaskBlock,
  parseTaskBlockSuffix,
  normalizeTaskBlocks
} from '../task-block-utils'

describe('isLikelyTask', () => {
  it('returns true for text starting with action verbs', () => {
    expect(isLikelyTask('Buy groceries')).toBe(true)
    expect(isLikelyTask('fix the login bug')).toBe(true)
    expect(isLikelyTask('Send email to team')).toBe(true)
    expect(isLikelyTask('Review PR #123')).toBe(true)
    expect(isLikelyTask('Schedule meeting with design')).toBe(true)
    expect(isLikelyTask('Deploy to staging')).toBe(true)
  })

  it('returns false for non-action text', () => {
    expect(isLikelyTask('Milk')).toBe(false)
    expect(isLikelyTask('Item 1')).toBe(false)
    expect(isLikelyTask('Notes from standup')).toBe(false)
    expect(isLikelyTask('a')).toBe(false)
    expect(isLikelyTask('')).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(isLikelyTask('BUY groceries')).toBe(true)
    expect(isLikelyTask('Fix Bug')).toBe(true)
  })

  it('handles leading whitespace', () => {
    expect(isLikelyTask('  Buy groceries')).toBe(true)
  })

  it('rejects very short or very long text', () => {
    expect(isLikelyTask('Go')).toBe(false)
    expect(isLikelyTask('x'.repeat(300))).toBe(false)
  })
})

describe('serializeTaskBlock', () => {
  it('serializes unchecked task', () => {
    expect(serializeTaskBlock({ taskId: 'abc-123', title: 'Buy groceries', checked: false })).toBe(
      '- [ ] Buy groceries {task:abc-123}'
    )
  })

  it('serializes checked task', () => {
    expect(serializeTaskBlock({ taskId: 'def-456', title: 'Send email', checked: true })).toBe(
      '- [x] Send email {task:def-456}'
    )
  })
})

describe('parseTaskBlockSuffix', () => {
  it('parses task reference from text', () => {
    expect(parseTaskBlockSuffix('Buy groceries {task:abc-123}')).toEqual({
      taskId: 'abc-123',
      title: 'Buy groceries'
    })
  })

  it('returns null for text without task ref', () => {
    expect(parseTaskBlockSuffix('Just a regular item')).toBeNull()
  })

  it('handles task ref at end of longer text', () => {
    expect(parseTaskBlockSuffix('Send email {task:def-456}')).toEqual({
      taskId: 'def-456',
      title: 'Send email'
    })
  })
})

describe('normalizeTaskBlocks', () => {
  it('converts checkListItem with {task:id} to taskBlock', () => {
    const blocks = [
      {
        id: 'b1',
        type: 'checkListItem',
        props: { isChecked: false },
        content: [{ type: 'text', text: 'Buy groceries {task:abc-123}', styles: {} }],
        children: []
      }
    ] as any[]

    const { blocks: result, didChange } = normalizeTaskBlocks(blocks)
    expect(didChange).toBe(true)
    expect(result[0].type).toBe('taskBlock')
    expect((result[0].props as any).taskId).toBe('abc-123')
    expect((result[0].props as any).title).toBe('Buy groceries')
    expect((result[0].props as any).checked).toBe(false)
  })

  it('preserves checked state from checkListItem', () => {
    const blocks = [
      {
        id: 'b2',
        type: 'checkListItem',
        props: { isChecked: true },
        content: [{ type: 'text', text: 'Done task {task:def-456}', styles: {} }],
        children: []
      }
    ] as any[]

    const { blocks: result } = normalizeTaskBlocks(blocks)
    expect((result[0].props as any).checked).toBe(true)
  })

  it('leaves regular checkListItem untouched', () => {
    const blocks = [
      {
        id: 'b3',
        type: 'checkListItem',
        props: { isChecked: false },
        content: [{ type: 'text', text: 'Just a checkbox', styles: {} }],
        children: []
      }
    ] as any[]

    const { blocks: result, didChange } = normalizeTaskBlocks(blocks)
    expect(didChange).toBe(false)
    expect(result).toBe(blocks)
  })

  it('leaves non-checkListItem blocks unchanged', () => {
    const blocks = [
      {
        id: 'b4',
        type: 'paragraph',
        props: {},
        content: [{ type: 'text', text: 'Some text {task:xyz}', styles: {} }],
        children: []
      }
    ] as any[]

    const { didChange } = normalizeTaskBlocks(blocks)
    expect(didChange).toBe(false)
  })

  it('returns same reference when no {task: found', () => {
    const blocks = [
      {
        id: 'b5',
        type: 'checkListItem',
        props: { isChecked: false },
        content: [{ type: 'text', text: 'No task here', styles: {} }],
        children: []
      }
    ] as any[]

    const { blocks: result } = normalizeTaskBlocks(blocks)
    expect(result).toBe(blocks)
  })
})

describe('serializeTaskBlock with parentTaskId', () => {
  it('serializes subtask with 2-space indent', () => {
    expect(
      serializeTaskBlock({
        taskId: 'sub-1',
        title: 'Buy milk',
        checked: false,
        parentTaskId: 'parent-1'
      })
    ).toBe('  - [ ] Buy milk {task:sub-1}')
  })

  it('serializes checked subtask with indent', () => {
    expect(
      serializeTaskBlock({
        taskId: 'sub-2',
        title: 'Get bread',
        checked: true,
        parentTaskId: 'parent-1'
      })
    ).toBe('  - [x] Get bread {task:sub-2}')
  })

  it('serializes top-level task without indent', () => {
    expect(
      serializeTaskBlock({ taskId: 'top-1', title: 'Groceries', checked: false, parentTaskId: '' })
    ).toBe('- [ ] Groceries {task:top-1}')
  })
})

describe('normalizeTaskBlocks with nested children', () => {
  it('converts nested checkListItem with {task:id} to taskBlock with parentTaskId', () => {
    const blocks = [
      {
        id: 'parent-block',
        type: 'taskBlock',
        props: { taskId: 'task-parent', title: 'Groceries', checked: false, parentTaskId: '' },
        content: undefined,
        children: [
          {
            id: 'child-block',
            type: 'checkListItem',
            props: { isChecked: false },
            content: [{ type: 'text', text: 'Buy milk {task:sub-1}', styles: {} }],
            children: []
          }
        ]
      }
    ] as any[]

    const { blocks: result, didChange } = normalizeTaskBlocks(blocks)
    expect(didChange).toBe(true)
    const parent = result[0]
    expect(parent.children).toHaveLength(1)
    const child = parent.children![0]
    expect(child.type).toBe('taskBlock')
    expect((child.props as any).taskId).toBe('sub-1')
    expect((child.props as any).title).toBe('Buy milk')
    expect((child.props as any).parentTaskId).toBe('task-parent')
  })

  it('leaves non-task children untouched', () => {
    const blocks = [
      {
        id: 'parent-block',
        type: 'taskBlock',
        props: { taskId: 'task-parent', title: 'Groceries', checked: false, parentTaskId: '' },
        content: undefined,
        children: [
          {
            id: 'child-block',
            type: 'checkListItem',
            props: { isChecked: false },
            content: [{ type: 'text', text: 'Just a note', styles: {} }],
            children: []
          }
        ]
      }
    ] as any[]

    const { blocks: result, didChange } = normalizeTaskBlocks(blocks)
    expect(didChange).toBe(false)
    expect(result).toBe(blocks)
  })
})

describe('subtask round-trip: serialize → parse → normalize', () => {
  it('serializes parent with subtask, then normalizes back', () => {
    const parentProps = { taskId: 'p1', title: 'Groceries', checked: false, parentTaskId: '' }
    const subtaskProps = { taskId: 's1', title: 'Buy milk', checked: true, parentTaskId: 'p1' }

    const parentMd = serializeTaskBlock(parentProps)
    const subtaskMd = serializeTaskBlock(subtaskProps)

    expect(parentMd).toBe('- [ ] Groceries {task:p1}')
    expect(subtaskMd).toBe('  - [x] Buy milk {task:s1}')

    // Parse suffix extracts correctly
    const parsedParent = parseTaskBlockSuffix('Groceries {task:p1}')
    expect(parsedParent).toEqual({ taskId: 'p1', title: 'Groceries' })

    const parsedSubtask = parseTaskBlockSuffix('Buy milk {task:s1}')
    expect(parsedSubtask).toEqual({ taskId: 's1', title: 'Buy milk' })
  })

  it('normalizes a block tree with nested children correctly', () => {
    const blocks = [
      {
        id: 'b-parent',
        type: 'taskBlock',
        props: { taskId: 'p1', title: 'Groceries', checked: false, parentTaskId: '' },
        content: undefined,
        children: [
          {
            id: 'b-sub1',
            type: 'checkListItem',
            props: { isChecked: true },
            content: [{ type: 'text', text: 'Buy milk {task:s1}', styles: {} }],
            children: []
          },
          {
            id: 'b-sub2',
            type: 'checkListItem',
            props: { isChecked: false },
            content: [{ type: 'text', text: 'Get bread {task:s2}', styles: {} }],
            children: []
          }
        ]
      }
    ] as any[]

    const { blocks: result, didChange } = normalizeTaskBlocks(blocks)
    expect(didChange).toBe(true)
    expect(result[0].children).toHaveLength(2)

    const sub1 = result[0].children![0]
    expect(sub1.type).toBe('taskBlock')
    expect((sub1.props as any).taskId).toBe('s1')
    expect((sub1.props as any).parentTaskId).toBe('p1')
    expect((sub1.props as any).checked).toBe(true)

    const sub2 = result[0].children![1]
    expect(sub2.type).toBe('taskBlock')
    expect((sub2.props as any).taskId).toBe('s2')
    expect((sub2.props as any).parentTaskId).toBe('p1')
    expect((sub2.props as any).checked).toBe(false)
  })
})
