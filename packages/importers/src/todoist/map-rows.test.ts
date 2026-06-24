import { describe, it, expect } from 'vitest'
import { mapRows } from './map-rows.ts'
import type { TodoistRow } from './types.ts'

const now = new Date(2026, 5, 15, 9, 0, 0)

function task(partial: Partial<TodoistRow>): TodoistRow {
  return {
    type: 'task',
    content: '',
    description: '',
    priority: 1,
    indent: 1,
    date: '',
    dateLang: '',
    timezone: '',
    deadline: '',
    rowNumber: 0,
    ...partial
  }
}

describe('mapRows', () => {
  it('maps the reference export (3 tasks + image note)', () => {
    const rows: TodoistRow[] = [
      task({ content: 'go home', priority: 4, indent: 1, rowNumber: 4 }),
      task({ content: 'repair', priority: 4, date: 'in 2 days', dateLang: 'en', rowNumber: 5 }),
      task({
        content: 'repair home',
        priority: 2,
        date: 'in 7 days',
        dateLang: 'en',
        rowNumber: 6
      }),
      {
        type: 'note',
        content:
          '[[file {"file_name":"Screenshot.png","file_url":"https://files.todoist.com/x/file.png"}]]',
        description: '',
        priority: 0,
        indent: 1,
        date: '',
        dateLang: '',
        timezone: '',
        deadline: '',
        rowNumber: 7
      }
    ]
    const plan = mapRows(rows, 'Kişisel', { now })
    expect(plan.project.name).toBe('Kişisel')
    expect(plan.tasks).toHaveLength(3)
    expect(plan.tasks[0]).toMatchObject({ title: 'go home', priority: 4, dueDate: null })
    expect(plan.tasks[1]).toMatchObject({ title: 'repair', priority: 4, dueDate: '2026-06-17' })
    expect(plan.tasks[2]).toMatchObject({
      title: 'repair home',
      priority: 2,
      dueDate: '2026-06-22'
    })
    // image note folded into the preceding task's description
    expect(plan.tasks[2].description).toContain(
      '[Screenshot.png](https://files.todoist.com/x/file.png)'
    )
    expect(plan.stats).toMatchObject({ tasks: 3, subtasks: 0, withDueDate: 2, comments: 1 })
    expect(plan.sampleTitles).toEqual(['go home', 'repair', 'repair home'])
  })

  it('resolves INDENT nesting into parentTempId', () => {
    const rows = [
      task({ content: 'parent', indent: 1 }),
      task({ content: 'child', indent: 2 }),
      task({ content: 'grandchild', indent: 3 }),
      task({ content: 'sibling', indent: 1 })
    ]
    const plan = mapRows(rows, 'P', { now })
    const [p, c, g, s] = plan.tasks
    expect(c.parentTempId).toBe(p.tempId)
    expect(g.parentTempId).toBe(c.tempId)
    expect(s.parentTempId).toBeNull()
    expect(plan.stats.subtasks).toBe(2)
  })

  it('demotes an orphan child to top-level with a warning', () => {
    const rows = [task({ content: 'deep', indent: 3 })]
    const plan = mapRows(rows, 'P', { now })
    expect(plan.tasks[0].parentTempId).toBeNull()
    expect(plan.warnings.some((w) => /parent/i.test(w.message))).toBe(true)
  })

  it('flattens sections with a warning and orphans following notes', () => {
    const rows: TodoistRow[] = [
      { ...task({ content: 'Section A', indent: 1, rowNumber: 2 }), type: 'section' },
      task({ content: 'under section', indent: 1, rowNumber: 3 })
    ]
    const plan = mapRows(rows, 'P', { now })
    expect(plan.tasks).toHaveLength(1)
    expect(plan.tasks[0].title).toBe('under section')
    expect(plan.stats.sectionsFlattened).toBe(1)
  })

  it('uses DEADLINE when DATE is empty', () => {
    const rows = [task({ content: 'x', date: '', deadline: '2026-12-31' })]
    const plan = mapRows(rows, 'P', { now })
    expect(plan.tasks[0].dueDate).toBe('2026-12-31')
  })

  it('marks an empty title as (untitled) with a warning', () => {
    const rows = [task({ content: '   ' })]
    const plan = mapRows(rows, 'P', { now })
    expect(plan.tasks[0].title).toBe('(untitled)')
    expect(plan.warnings.length).toBeGreaterThan(0)
  })
})
