import { describe, expect, it } from 'vitest'
import { selectCarriedTaskIds, type CarriedTaskDeps } from './note-carried-tasks'

function deps(overrides: Partial<CarriedTaskDeps> = {}): CarriedTaskDeps {
  return {
    taskExists: () => true,
    linkedNoteIds: () => [],
    noteExists: () => true,
    ...overrides
  }
}

describe('selectCarriedTaskIds', () => {
  it('collects the task lines of every note, once each, in document order', () => {
    const notes = [
      { id: 'n1', markdown: '# Plan\n- [ ] Buy milk {task:t1}\n- [x] Call Anna {task:t2}' },
      { id: 'n2', markdown: '- [ ] Buy milk {task:t1}\n  - [ ] Sub {task:t3}' }
    ]
    expect(selectCarriedTaskIds(notes, deps())).toEqual(['t1', 't2', 't3'])
  })

  it('ignores plain checkboxes, prose mentions and unreadable notes', () => {
    const notes = [
      { id: 'n1', markdown: '- [ ] Just a checkbox\nSee {task:t9} in text' },
      { id: 'n2', markdown: null }
    ]
    expect(selectCarriedTaskIds(notes, deps())).toEqual([])
  })

  it('drops ids with no task row', () => {
    const notes = [{ id: 'n1', markdown: '- [ ] Gone {task:t1}\n- [ ] Here {task:t2}' }]
    expect(selectCarriedTaskIds(notes, deps({ taskExists: (id) => id === 't2' }))).toEqual(['t2'])
  })

  it('keeps a task that is still linked to a note surviving the delete', () => {
    const notes = [{ id: 'n1', markdown: '- [ ] Shared {task:t1}\n- [ ] Mine {task:t2}' }]
    const linked: Record<string, string[]> = { t1: ['n1', 'other'], t2: ['n1'] }
    expect(selectCarriedTaskIds(notes, deps({ linkedNoteIds: (id) => linked[id] ?? [] }))).toEqual([
      't2'
    ])
  })

  it('does not count a link to a note that no longer exists, or to one deleted alongside', () => {
    const notes = [
      { id: 'n1', markdown: '- [ ] A {task:t1}' },
      { id: 'n2', markdown: '' }
    ]
    const linked: Record<string, string[]> = { t1: ['n1', 'n2', 'long-gone'] }
    expect(
      selectCarriedTaskIds(
        notes,
        deps({
          linkedNoteIds: (id) => linked[id] ?? [],
          noteExists: (id) => id !== 'long-gone'
        })
      )
    ).toEqual(['t1'])
  })
})
