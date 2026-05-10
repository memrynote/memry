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

    const outcome = indentTaskBlock(editor, 'block-2')

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
    expectSkipped(indentTaskBlock(makeEditor([], vi.fn()), 'missing'), 'block-not-found')
    expectSkipped(
      indentTaskBlock(
        makeEditor([
          { id: 'parent', type: 'taskBlock', children: [{ id: 'child', type: 'taskBlock' }] }
        ]),
        'child'
      ),
      'already-nested'
    )
    expectSkipped(
      indentTaskBlock(
        makeEditor([{ id: 'first', type: 'taskBlock', props: { taskId: 't1' } }]),
        'first'
      ),
      'no-prev-task-sibling'
    )
    expectSkipped(
      indentTaskBlock(
        makeEditor([
          { id: 'prev', type: 'paragraph' },
          { id: 'task', type: 'taskBlock', props: { taskId: 't2' } }
        ]),
        'task'
      ),
      'no-prev-task-sibling'
    )
    expectSkipped(
      indentTaskBlock(
        makeEditor([
          { id: 'prev', type: 'taskBlock', props: { taskId: 't1' } },
          { id: 'task', type: 'taskBlock', props: {} }
        ]),
        'task'
      ),
      'no-task-id'
    )
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
