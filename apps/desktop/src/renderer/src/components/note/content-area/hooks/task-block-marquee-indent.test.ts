import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  classifyBlocks,
  indentTaskBlock,
  outdentTaskBlock,
  type TaskIndentOutcome
} from './task-block-marquee-indent'
import { tasksService } from '@/services/tasks-service'

vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    update: vi.fn()
  }
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn()
  })
}))

interface TestBlock {
  id: string
  type: string
  props?: Record<string, unknown>
  children?: TestBlock[]
}

function makeEditor(document: TestBlock[], replaceBlocks = vi.fn()) {
  return { document, replaceBlocks }
}

function expectSkipped(outcome: TaskIndentOutcome, reason: TaskIndentOutcome['reason']) {
  expect(outcome).toMatchObject({ kind: 'skipped', reason })
}

describe('task-block marquee indent helpers', () => {
  beforeEach(() => {
    vi.mocked(tasksService.update).mockReset()
    vi.mocked(tasksService.update).mockResolvedValue({ success: true } as never)
  })

  it('classifies selected ids from the ProseMirror document', () => {
    const nodes = [
      {
        type: { name: 'blockContainer' },
        attrs: { id: 'text-1' },
        firstChild: { type: { isTextblock: true, name: 'paragraph' } }
      },
      {
        type: { name: 'blockContainer' },
        attrs: { id: 'task-1' },
        firstChild: { type: { isTextblock: false, name: 'taskBlock' } }
      },
      {
        type: { name: 'blockContainer' },
        attrs: { id: 'file-1' },
        firstChild: { type: { isTextblock: false, name: 'fileBlock' } }
      }
    ]
    const editor = {
      prosemirrorView: {
        state: {
          doc: {
            descendants: (visitor: (node: unknown) => boolean) => {
              for (const node of nodes) visitor(node)
            }
          }
        }
      }
    }

    expect(classifyBlocks(editor, ['task-1', 'missing', 'text-1', 'file-1'])).toEqual({
      textblocks: ['text-1'],
      taskBlocks: ['task-1'],
      other: ['missing', 'file-1']
    })
  })

  it('indents a top-level task under its previous task sibling', () => {
    const previous = {
      id: 'block-1',
      type: 'taskBlock',
      props: { taskId: 'task-parent' },
      children: [{ id: 'existing-child', type: 'taskBlock' }]
    }
    const block = { id: 'block-2', type: 'taskBlock', props: { taskId: 'task-child' } }
    const replaceBlocks = vi.fn()
    const editor = makeEditor([previous, block], replaceBlocks)

    const outcome = indentTaskBlock(editor, 'block-2', { nested: false })

    expect(outcome).toEqual({
      kind: 'indented',
      id: 'block-2',
      newParentTaskId: 'task-parent'
    })
    expect(replaceBlocks).toHaveBeenCalledWith(
      [previous, block],
      [
        {
          ...previous,
          children: [
            previous.children[0],
            { ...block, props: { taskId: 'task-child', parentTaskId: 'task-parent' } }
          ]
        }
      ]
    )
    expect(tasksService.update).toHaveBeenCalledWith({
      id: 'task-child',
      parentId: 'task-parent'
    })
  })

  it('skips indent when the block cannot become a child', () => {
    const flat = { nested: false }
    expectSkipped(indentTaskBlock(makeEditor([], vi.fn()), 'missing', flat), 'block-not-found')
    expectSkipped(
      indentTaskBlock(
        makeEditor([
          { id: 'parent', type: 'taskBlock', children: [{ id: 'child', type: 'taskBlock' }] }
        ]),
        'child',
        flat
      ),
      'already-nested'
    )
    expectSkipped(
      indentTaskBlock(
        makeEditor([{ id: 'first', type: 'taskBlock', props: { taskId: 't1' } }]),
        'first',
        flat
      ),
      'no-prev-task-sibling'
    )
    expectSkipped(
      indentTaskBlock(
        makeEditor([
          { id: 'prev', type: 'paragraph' },
          { id: 'task', type: 'taskBlock', props: { taskId: 't2' } }
        ]),
        'task',
        flat
      ),
      'no-prev-task-sibling'
    )
    // A task with subtasks of its own would land two levels deep.
    expectSkipped(
      indentTaskBlock(
        makeEditor([
          { id: 'prev', type: 'taskBlock', props: { taskId: 't1' } },
          {
            id: 'task',
            type: 'taskBlock',
            props: { taskId: 't2' },
            children: [{ id: 'sub', type: 'taskBlock', props: { taskId: 't3' } }]
          }
        ]),
        'task',
        flat
      ),
      'already-nested'
    )
  })

  it('with nested subtasks off, leaves a subtask where it is', () => {
    const editor = makeEditor([
      {
        id: 'a',
        type: 'taskBlock',
        props: { taskId: 'ta' },
        children: [
          { id: 'b', type: 'taskBlock', props: { taskId: 'tb', parentTaskId: 'ta' } },
          { id: 'c', type: 'taskBlock', props: { taskId: 'tc', parentTaskId: 'ta' } }
        ]
      }
    ])

    expectSkipped(indentTaskBlock(editor, 'c', { nested: false }), 'already-nested')
    expect(editor.replaceBlocks).not.toHaveBeenCalled()
    expect(tasksService.update).not.toHaveBeenCalled()
  })

  it('with nested subtasks on, indents a subtask under its previous subtask sibling', () => {
    const b = { id: 'b', type: 'taskBlock', props: { taskId: 'tb', parentTaskId: 'ta' } }
    const c = {
      id: 'c',
      type: 'taskBlock',
      props: { taskId: 'tc', parentTaskId: 'ta', title: 'old' }
    }
    const replaceBlocks = vi.fn()
    const editor = makeEditor(
      [{ id: 'a', type: 'taskBlock', props: { taskId: 'ta' }, children: [b, c] }],
      replaceBlocks
    )

    const outcome = indentTaskBlock(editor, 'c', { nested: true, title: 'typed' })

    expect(outcome).toEqual({ kind: 'indented', id: 'c', newParentTaskId: 'tb' })
    expect(replaceBlocks).toHaveBeenCalledWith(
      [b, c],
      [{ ...b, children: [{ ...c, props: { taskId: 'tc', parentTaskId: 'tb', title: 'typed' } }] }]
    )
    expect(tasksService.update).toHaveBeenCalledWith({ id: 'tc', parentId: 'tb' })
  })

  it('moves a draft block without writing a row it does not have yet', () => {
    const prev = { id: 'prev', type: 'taskBlock', props: { taskId: 't1' } }
    const draft = { id: 'draft', type: 'taskBlock', props: { taskId: '' } }
    const replaceBlocks = vi.fn()

    const outcome = indentTaskBlock(makeEditor([prev, draft], replaceBlocks), 'draft', {
      nested: false
    })

    expect(outcome).toMatchObject({ kind: 'indented', newParentTaskId: 't1' })
    expect(replaceBlocks).toHaveBeenCalled()
    expect(tasksService.update).not.toHaveBeenCalled()
  })

  it('outdents a grandchild to sit under its grandparent task', () => {
    const c = { id: 'c', type: 'taskBlock', props: { taskId: 'tc', parentTaskId: 'tb' } }
    const b = {
      id: 'b',
      type: 'taskBlock',
      props: { taskId: 'tb', parentTaskId: 'ta' },
      children: [c]
    }
    const replaceBlocks = vi.fn()
    const editor = makeEditor(
      [{ id: 'a', type: 'taskBlock', props: { taskId: 'ta' }, children: [b] }],
      replaceBlocks
    )

    expect(outdentTaskBlock(editor, 'c')).toEqual({ kind: 'outdented', id: 'c' })
    expect(replaceBlocks).toHaveBeenCalledWith(
      [b],
      [
        { ...b, children: [] },
        { ...c, props: { taskId: 'tc', parentTaskId: 'ta' } }
      ]
    )
    expect(tasksService.update).toHaveBeenCalledWith({ id: 'tc', parentId: 'ta' })
  })

  it('outdents a nested task to the top level after its parent', () => {
    const parent = {
      id: 'parent-block',
      type: 'taskBlock',
      props: { taskId: 'parent-task' },
      children: [
        {
          id: 'child-block',
          type: 'taskBlock',
          props: { taskId: 'child-task', parentTaskId: 'parent-task' }
        },
        {
          id: 'sibling-block',
          type: 'taskBlock',
          props: { taskId: 'sibling-task', parentTaskId: 'parent-task' }
        }
      ]
    }
    const replaceBlocks = vi.fn()

    const outcome = outdentTaskBlock(makeEditor([parent], replaceBlocks), 'child-block')

    expect(outcome).toEqual({ kind: 'outdented', id: 'child-block' })
    expect(replaceBlocks).toHaveBeenCalledWith(
      [parent],
      [
        { ...parent, children: [parent.children[1]] },
        {
          ...parent.children[0],
          props: { taskId: 'child-task', parentTaskId: '' }
        }
      ]
    )
    expect(tasksService.update).toHaveBeenCalledWith({ id: 'child-task', parentId: null })
  })

  it('skips outdent when the block is not nested or cannot be rewritten', () => {
    expectSkipped(
      outdentTaskBlock(
        makeEditor([{ id: 'top', type: 'taskBlock', props: { taskId: 't1' } }]),
        'top'
      ),
      'not-nested'
    )
    expectSkipped(outdentTaskBlock(makeEditor([], vi.fn()), 'missing'), 'parent-not-found')
    expectSkipped(
      outdentTaskBlock(
        makeEditor([
          {
            id: 'parent',
            type: 'taskBlock',
            props: {},
            children: [{ id: 'child', type: 'taskBlock' }]
          }
        ]),
        'child'
      ),
      'parent-not-found'
    )
    expectSkipped(
      outdentTaskBlock(
        makeEditor(
          [
            {
              id: 'parent',
              type: 'taskBlock',
              props: { taskId: 'parent-task' },
              children: [{ id: 'child', type: 'taskBlock', props: { taskId: 'child-task' } }]
            }
          ],
          () => {
            throw new Error('replace failed')
          }
        ),
        'child'
      ),
      'parent-not-found'
    )
  })
})
