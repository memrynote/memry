import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  classifyBlocks,
  indentTaskBlock,
  outdentTaskBlock,
  type TaskIndentOutcome,
  type TaskParents
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
  return { document, replaceBlocks, updateBlock: vi.fn() }
}

/** DB parents by task id, as the note's prefetch provider holds them. */
function makeParents(entries: Record<string, string | null>): TaskParents & {
  map: Map<string, string | null>
} {
  const map = new Map(Object.entries(entries))
  return { map, get: (id) => map.get(id), set: (id, parentId) => void map.set(id, parentId) }
}

const row = (id: string, parentTaskId: string): TestBlock => ({
  id,
  type: 'taskBlock',
  props: { taskId: `t${id}`, parentTaskId }
})

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

  it('with nested subtasks on, re-parents a listed subtask under the row above in the DB only', () => {
    const b = row('b', 'ta')
    const c = row('c', 'ta')
    const editor = makeEditor([
      { id: 'a', type: 'taskBlock', props: { taskId: 'ta' }, children: [b, c] }
    ])
    const parents = makeParents({ tb: 'ta', tc: 'ta' })

    const outcome = indentTaskBlock(editor, 'c', { nested: true, title: 'typed', parents })

    expect(outcome).toEqual({ kind: 'indented', id: 'c', newParentTaskId: 'tb' })
    // The note keeps one task level for builds that read no deeper.
    expect(editor.replaceBlocks).not.toHaveBeenCalled()
    expect(editor.updateBlock).toHaveBeenCalledWith(c, { props: { title: 'typed' } })
    expect(parents.map.get('tc')).toBe('tb')
    expect(tasksService.update).toHaveBeenCalledWith({ id: 'tc', parentId: 'tb' })
  })

  it('indents a listed row under the row above at its own depth', () => {
    const editor = makeEditor([
      {
        id: 'a',
        type: 'taskBlock',
        props: { taskId: 'ta' },
        children: [row('b', 'ta'), row('c', 'ta'), row('d', 'ta')]
      }
    ])
    // c sits under b in the DB; d is one level deep, like b.
    const parents = makeParents({ tb: 'ta', tc: 'tb', td: 'ta' })

    const outcome = indentTaskBlock(editor, 'd', { nested: true, parents })

    expect(outcome).toEqual({ kind: 'indented', id: 'd', newParentTaskId: 'tb' })
    expect(tasksService.update).toHaveBeenCalledWith({ id: 'td', parentId: 'tb' })
  })

  it("carries a top-level task's subtasks along as rows of the same list", () => {
    const prev = { id: 'p', type: 'taskBlock', props: { taskId: 'tp' } }
    const sub = row('s', 'tt')
    const task = { id: 't', type: 'taskBlock', props: { taskId: 'tt' }, children: [sub] }
    const editor = makeEditor([prev, task])

    indentTaskBlock(editor, 't', { nested: true, parents: makeParents({ ts: 'tt' }) })

    expect(editor.replaceBlocks).toHaveBeenCalledWith(
      [prev, task],
      [
        {
          ...prev,
          children: [
            { ...task, props: { taskId: 'tt', parentTaskId: 'tp' }, children: [] },
            { ...sub, props: { ...sub.props, parentTaskId: 'tp' }, children: [] }
          ]
        }
      ]
    )
    // The subtask keeps its DB parent; only the moved task changes.
    expect(tasksService.update).toHaveBeenCalledTimes(1)
    expect(tasksService.update).toHaveBeenCalledWith({ id: 'tt', parentId: 'tp' })
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

  it("outdents a row two deep to its grandparent, below the rest of its old parent's rows", () => {
    const [b, c, d, e] = [row('b', 'ta'), row('c', 'ta'), row('d', 'ta'), row('e', 'ta')]
    const a = { id: 'a', type: 'taskBlock', props: { taskId: 'ta' }, children: [b, c, d, e] }
    const editor = makeEditor([a])
    const parents = makeParents({ tb: 'ta', tc: 'tb', td: 'tc', te: 'tb' })

    expect(outdentTaskBlock(editor, 'c', { parents })).toEqual({ kind: 'outdented', id: 'c' })
    expect(editor.replaceBlocks).toHaveBeenCalledWith([a], [{ ...a, children: [b, e, c, d] }])
    expect(parents.map.get('tc')).toBe('ta')
    expect(parents.map.get('td')).toBe('tc')
    expect(tasksService.update).toHaveBeenCalledTimes(1)
    expect(tasksService.update).toHaveBeenCalledWith({ id: 'tc', parentId: 'ta' })
  })

  it('outdents a listed subtask to the top level with the rows under it', () => {
    const [b, c] = [row('b', 'ta'), row('c', 'ta')]
    const a = { id: 'a', type: 'taskBlock', props: { taskId: 'ta' }, children: [b, c] }
    const editor = makeEditor([a])

    outdentTaskBlock(editor, 'b', { parents: makeParents({ tb: 'ta', tc: 'tb' }) })

    expect(editor.replaceBlocks).toHaveBeenCalledWith(
      [a],
      [
        { ...a, children: [] },
        {
          ...b,
          props: { ...b.props, parentTaskId: '' },
          children: [{ ...c, props: { ...c.props, parentTaskId: 'tb' } }]
        }
      ]
    )
    expect(tasksService.update).toHaveBeenCalledTimes(1)
    expect(tasksService.update).toHaveBeenCalledWith({ id: 'tb', parentId: null })
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
