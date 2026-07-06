import { describe, expect, it } from 'vitest'
import {
  collectTaskLinks,
  matchTaskCandidates,
  normalizeTaskBlocks,
  parseTaskAnchor,
  parseTaskBlockSuffix,
  serializeTaskBlock,
  type TaskCandidate,
  type TaskNormalizableBlock
} from './task-block'

function checkbox(
  text: string,
  checked = false,
  children: TaskNormalizableBlock[] = []
): TaskNormalizableBlock {
  return {
    id: `b-${text}`,
    type: 'checkListItem',
    props: { checked },
    content: [{ type: 'text', text }],
    children
  }
}

function candidate(overrides: Partial<TaskCandidate> & { taskId: string }): TaskCandidate {
  return { title: 'Task', checked: false, anchor: null, ...overrides }
}

describe('serializeTaskBlock', () => {
  it('emits a plain checkbox line without the task id', () => {
    expect(serializeTaskBlock({ taskId: 't1', title: 'Buy milk', checked: false })).toBe(
      '- [ ] Buy milk'
    )
  })

  it('emits x when checked', () => {
    expect(serializeTaskBlock({ taskId: 't1', title: 'Buy milk', checked: true })).toBe(
      '- [x] Buy milk'
    )
  })

  it('indents subtasks two spaces', () => {
    expect(
      serializeTaskBlock({ taskId: 't2', title: 'Sub', checked: false, parentTaskId: 't1' })
    ).toBe('  - [ ] Sub')
  })

  it('appends the anchor when set', () => {
    expect(
      serializeTaskBlock({ taskId: 't1', title: 'Buy milk', checked: false, anchor: 'k3f9q2' })
    ).toBe('- [ ] Buy milk ^k3f9q2')
  })
})

describe('parseTaskAnchor', () => {
  it('parses a trailing anchor', () => {
    expect(parseTaskAnchor('Buy milk ^k3f9q2')).toEqual({ anchor: 'k3f9q2', title: 'Buy milk' })
  })

  it('accepts letters, digits and dashes only', () => {
    expect(parseTaskAnchor('Quote ^quote-of-the-day')).toEqual({
      anchor: 'quote-of-the-day',
      title: 'Quote'
    })
    expect(parseTaskAnchor('Math a^2')).toBeNull()
    expect(parseTaskAnchor('Emoji ^k3f9é')).toBeNull()
  })

  it('requires a space before the caret and a non-empty id', () => {
    expect(parseTaskAnchor('NoSpace^abc')).toBeNull()
    expect(parseTaskAnchor('Empty ^')).toBeNull()
    expect(parseTaskAnchor('^only-anchor')).toBeNull()
  })
})

describe('matchTaskCandidates', () => {
  it('rule 1: binds by anchor first, even when titles moved', () => {
    const result = matchTaskCandidates(
      [{ title: 'Renamed completely ^k3f9q2', checked: false }],
      [candidate({ taskId: 't1', title: 'Old title', anchor: 'k3f9q2' })]
    )
    expect(result.bindings[0]).toMatchObject({
      taskId: 't1',
      title: 'Renamed completely',
      anchor: 'k3f9q2',
      rule: 'anchor'
    })
    expect(result.orphans).toEqual([])
  })

  it('rule 2: binds and strips a legacy {task:id} suffix without needing a candidate', () => {
    const result = matchTaskCandidates([{ title: 'Buy milk {task:t9}', checked: true }], [])
    expect(result.bindings[0]).toMatchObject({ taskId: 't9', title: 'Buy milk', rule: 'legacy' })
  })

  it('rule 2 consumes the matching candidate so it cannot double-bind', () => {
    const result = matchTaskCandidates(
      [
        { title: 'Buy milk {task:t9}', checked: false },
        { title: 'Buy milk', checked: false }
      ],
      [candidate({ taskId: 't9', title: 'Buy milk' })]
    )
    expect(result.bindings[0]).toMatchObject({ taskId: 't9', rule: 'legacy' })
    expect(result.bindings[1]).toBeNull()
  })

  it('rule 3: binds by exact title independent of order', () => {
    const result = matchTaskCandidates(
      [
        { title: 'Beta', checked: false },
        { title: 'Alpha', checked: true }
      ],
      [candidate({ taskId: 'a', title: 'Alpha' }), candidate({ taskId: 'b', title: 'Beta' })]
    )
    expect(result.bindings[0]).toMatchObject({ taskId: 'b', rule: 'title' })
    expect(result.bindings[1]).toMatchObject({ taskId: 'a', rule: 'title', checked: true })
  })

  it('carries the matched candidate checked state so callers can detect external toggles', () => {
    const result = matchTaskCandidates(
      [
        { title: 'Anchored ^k1', checked: true },
        { title: 'Exact', checked: false },
        { title: 'Legacy {task:t3}', checked: true },
        { title: 'Edited elsewhere', checked: true }
      ],
      [
        candidate({ taskId: 't1', title: 'Anchored', anchor: 'k1', checked: false }),
        candidate({ taskId: 't2', title: 'Exact', checked: false }),
        candidate({ taskId: 't3', title: 'Legacy', checked: true }),
        candidate({ taskId: 't4', title: 'Old fuzzy title', checked: false })
      ]
    )
    expect(result.bindings[0]).toMatchObject({ rule: 'anchor', candidateChecked: false })
    expect(result.bindings[1]).toMatchObject({ rule: 'title', candidateChecked: false })
    expect(result.bindings[2]).toMatchObject({ rule: 'legacy', candidateChecked: true })
    expect(result.bindings[3]).toMatchObject({ rule: 'fuzzy', candidateChecked: false })
  })

  it('leaves candidateChecked undefined for legacy lines with no snapshot row', () => {
    const result = matchTaskCandidates([{ title: 'Buy milk {task:t9}', checked: false }], [])
    expect(result.bindings[0]).toMatchObject({ taskId: 't9', rule: 'legacy' })
    expect(result.bindings[0]?.candidateChecked).toBeUndefined()
  })

  it('rule 3: pairs duplicate titles by occurrence index', () => {
    const result = matchTaskCandidates(
      [
        { title: 'Same', checked: false },
        { title: 'Same', checked: true }
      ],
      [
        candidate({ taskId: 'first', title: 'Same' }),
        candidate({ taskId: 'second', title: 'Same' })
      ]
    )
    expect(result.bindings[0]?.taskId).toBe('first')
    expect(result.bindings[1]?.taskId).toBe('second')
  })

  it('rule 4: single leftover on both sides binds as an external title edit', () => {
    const result = matchTaskCandidates(
      [
        { title: 'Kept task', checked: false },
        { title: 'Buy oat milk', checked: false }
      ],
      [
        candidate({ taskId: 'kept', title: 'Kept task' }),
        candidate({ taskId: 'milk', title: 'Buy milk' })
      ]
    )
    expect(result.bindings[1]).toMatchObject({
      taskId: 'milk',
      title: 'Buy oat milk',
      rule: 'fuzzy'
    })
  })

  it('rule 4: more than one leftover on either side does not guess', () => {
    const result = matchTaskCandidates(
      [
        { title: 'Edited one', checked: false },
        { title: 'Edited two', checked: false }
      ],
      [
        candidate({ taskId: 'a', title: 'Original one' }),
        candidate({ taskId: 'b', title: 'Original two' })
      ]
    )
    expect(result.bindings).toEqual([null, null])
    expect(result.orphans.map((o) => o.taskId).sort()).toEqual(['a', 'b'])
  })

  it('rule 5: a plain checkbox with no candidate stays plain', () => {
    const result = matchTaskCandidates([{ title: 'Obsidian checkbox', checked: false }], [])
    expect(result.bindings).toEqual([null])
  })

  it('rule 6: an externally deleted line leaves the candidate as an orphan', () => {
    const result = matchTaskCandidates(
      [{ title: 'Kept', checked: false }],
      [
        candidate({ taskId: 'kept', title: 'Kept' }),
        candidate({ taskId: 'gone', title: 'Deleted line' })
      ]
    )
    expect(result.orphans.map((o) => o.taskId)).toEqual(['gone'])
  })

  it('documented limitation: one external delete + one add in the same edit mis-binds', () => {
    // Accepted risk from the spec's resolved question #1: rule 4 cannot tell a
    // title edit apart from deleting one task line and adding a new checkbox.
    const result = matchTaskCandidates(
      [{ title: 'Brand new checkbox', checked: false }],
      [candidate({ taskId: 'deleted', title: 'Removed task' })]
    )
    expect(result.bindings[0]).toMatchObject({ taskId: 'deleted', rule: 'fuzzy' })
  })
})

describe('normalizeTaskBlocks', () => {
  it('upgrades legacy suffix checkboxes without candidates (unchanged behavior)', () => {
    const { blocks, didChange } = normalizeTaskBlocks([checkbox('Buy milk {task:t1}', true)])
    expect(didChange).toBe(true)
    expect(blocks[0]).toMatchObject({
      type: 'taskBlock',
      props: { taskId: 't1', title: 'Buy milk', checked: true, parentTaskId: '' }
    })
  })

  it('binds plain lines against candidates and keeps foreign checkboxes plain', () => {
    const { blocks, didChange, orphans } = normalizeTaskBlocks(
      [checkbox('Buy milk'), checkbox('Not a task')],
      [candidate({ taskId: 't1', title: 'Buy milk' })]
    )
    expect(didChange).toBe(true)
    expect(blocks[0]).toMatchObject({ type: 'taskBlock', props: { taskId: 't1' } })
    expect(blocks[1].type).toBe('checkListItem')
    expect(orphans).toEqual([])
  })

  it('binds nested subtask lines with parentTaskId from the bound parent', () => {
    const { blocks } = normalizeTaskBlocks(
      [checkbox('Parent', false, [checkbox('Child', true)])],
      [candidate({ taskId: 'p', title: 'Parent' }), candidate({ taskId: 'c', title: 'Child' })]
    )
    expect(blocks[0]).toMatchObject({ type: 'taskBlock', props: { taskId: 'p' } })
    expect(blocks[0].children?.[0]).toMatchObject({
      type: 'taskBlock',
      props: { taskId: 'c', parentTaskId: 'p', checked: true }
    })
  })

  it('carries the anchor onto the upgraded block props', () => {
    const { blocks } = normalizeTaskBlocks(
      [checkbox('Buy milk ^k3f9q2')],
      [candidate({ taskId: 't1', title: 'Old', anchor: 'k3f9q2' })]
    )
    expect(blocks[0]).toMatchObject({
      type: 'taskBlock',
      props: { taskId: 't1', title: 'Buy milk', anchor: 'k3f9q2' }
    })
  })

  it('returns blocks untouched when nothing matches', () => {
    const input = [checkbox('Just a checkbox')]
    const { blocks, didChange } = normalizeTaskBlocks(input)
    expect(didChange).toBe(false)
    expect(blocks).toBe(input)
  })

  it('reports bindings so callers can reconcile external checked/title changes', () => {
    const { bindings } = normalizeTaskBlocks(
      [checkbox('Buy milk', true)],
      [candidate({ taskId: 't1', title: 'Buy milk', checked: false })]
    )
    expect(bindings).toEqual([
      expect.objectContaining({ taskId: 't1', checked: true, rule: 'title' })
    ])
  })
})

describe('collectTaskLinks', () => {
  it('collects task blocks in document order with positions', () => {
    const { blocks } = normalizeTaskBlocks(
      [
        checkbox('Parent {task:p}', false, [checkbox('Child {task:c}', true)]),
        checkbox('Second ^anc {task:s}')
      ],
      []
    )
    const links = collectTaskLinks(blocks)
    expect(links).toEqual([
      { taskId: 'p', title: 'Parent', checked: false, position: 0, anchor: null },
      { taskId: 'c', title: 'Child', checked: true, position: 1, anchor: null },
      { taskId: 's', title: 'Second ^anc', checked: false, position: 2, anchor: null }
    ])
  })

  it('reads the anchor from props', () => {
    const links = collectTaskLinks([
      {
        type: 'taskBlock',
        props: { taskId: 't1', title: 'Buy milk', checked: false, anchor: 'k3f9q2' }
      }
    ])
    expect(links[0]).toMatchObject({ taskId: 't1', anchor: 'k3f9q2' })
  })
})

describe('parseTaskBlockSuffix (legacy)', () => {
  it('still parses the legacy suffix', () => {
    expect(parseTaskBlockSuffix('Buy milk {task:t1}')).toEqual({ taskId: 't1', title: 'Buy milk' })
    expect(parseTaskBlockSuffix('No suffix')).toBeNull()
  })
})
