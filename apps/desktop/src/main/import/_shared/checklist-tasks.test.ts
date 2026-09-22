import { describe, it, expect } from 'vitest'
import { planChecklistTasks } from './checklist-tasks'

const NOW = new Date('2026-03-04T09:30:00.000Z')

const plan = (markdown: string) => planChecklistTasks(markdown, NOW)
const titles = (markdown: string) => plan(markdown).map((item) => item.title)

describe('planChecklistTasks', () => {
  it('plans an unchecked checkbox as an open task and a checked one as done', () => {
    const planned = plan('- [ ] Buy milk\n- [x] Call Ana')

    expect(planned).toHaveLength(2)
    expect(planned[0]).toMatchObject({ lineIndex: 0, title: 'Buy milk', checked: false })
    expect(planned[1]).toMatchObject({ lineIndex: 1, title: 'Call Ana', checked: true })
    expect(planned.every((item) => item.parentIndex === null)).toBe(true)
  })

  it('accepts an upper-case X and the * and + list markers', () => {
    const planned = plan('* [X] Ship it\n+ [ ] Then rest')

    expect(planned.map((item) => [item.listMarker, item.checked])).toEqual([
      ['*', true],
      ['+', false]
    ])
  })

  it('nests a checkbox directly under a checkbox as its subtask', () => {
    const planned = plan('- [ ] Groceries\n  - [ ] Milk\n  - [x] Bread')

    expect(planned.map((item) => item.parentIndex)).toEqual([null, 0, 0])
  })

  it('stops at one level: a third-level checkbox becomes a standalone task', () => {
    const planned = plan('- [ ] A\n  - [ ] B\n    - [ ] C')

    expect(planned.map((item) => item.parentIndex)).toEqual([null, 0, null])
  })

  it('does not treat a checkbox under a plain bullet as a subtask', () => {
    const planned = plan('- Groceries\n  - [ ] Milk')

    expect(planned).toHaveLength(1)
    expect(planned[0]).toMatchObject({ parentIndex: null, indent: '  ', title: 'Milk' })
  })

  it('does not treat a checkbox under an ordered item as a subtask, and skips the ordered line', () => {
    const planned = plan('1. [ ] Ordered\n   - [ ] Nested')

    expect(planned).toHaveLength(1)
    expect(planned[0]).toMatchObject({ title: 'Nested', parentIndex: null })
  })

  it('keeps a checkbox under a blocked parent at top level', () => {
    // The parent carries an Obsidian block link, so it is left alone — and a
    // subtask of a task that was never created is not a subtask.
    const planned = plan('- [ ] Parent ^block-id\n  - [ ] Child')

    expect(planned).toHaveLength(1)
    expect(planned[0]).toMatchObject({ title: 'Child', parentIndex: null })
  })

  it('skips a line that already carries a task suffix', () => {
    expect(plan('- [ ] Buy milk {task:abc123}')).toEqual([])
  })

  it('still plans the sibling of a line that already carries a task suffix', () => {
    expect(titles('- [x] Done {task:abc123}\n- [ ] Buy milk')).toEqual(['Buy milk'])
  })

  it('skips the three Obsidian constructs Memry must not rewrite', () => {
    expect(plan('- [ ] Blocked ^abcd')).toEqual([])
    expect(plan('- [ ] Blocked 🆔 task1')).toEqual([])
    expect(plan('- [ ] Blocked ⛔ task1')).toEqual([])
  })

  it('skips a checkbox with an empty title', () => {
    expect(plan('- [ ]\n- [ ]   \n- [x] Real')).toEqual([
      expect.objectContaining({ title: 'Real' })
    ])
  })

  it('skips checkboxes inside a fenced code block', () => {
    expect(titles('```md\n- [ ] Example\n```\n- [ ] Real')).toEqual(['Real'])
  })

  it('skips checkboxes inside a tilde fence and a nested backtick fence', () => {
    expect(titles('~~~\n- [ ] A\n~~~\n````\n```\n- [ ] B\n```\n````\n- [ ] C')).toEqual(['C'])
  })

  it('lifts Obsidian Tasks fields off the title', () => {
    const [item] = plan('- [ ] Buy milk 📅 2026-01-01 ⏫')

    expect(item.title).toBe('Buy milk')
    expect(item.obsidian).toMatchObject({
      priority: 3,
      dueDate: '2026-01-01',
      description: 'Buy milk 📅 2026-01-01 ⏫'
    })
  })

  it('carries the plugin done date so a finished line imports as finished', () => {
    const [item] = plan('- [ ] Buy milk ✅ 2026-01-02')

    expect(item.checked).toBe(false)
    expect(item.obsidian?.completedAt).not.toBeNull()
  })

  it('preserves the original indentation and marker for the rewrite', () => {
    const planned = plan('- [ ] Top\n\t- [ ] Tabbed child')

    expect(planned[0]).toMatchObject({ indent: '', listMarker: '-' })
    expect(planned[1]).toMatchObject({ indent: '\t', listMarker: '-', parentIndex: 0 })
  })

  it('closes the list at an unindented paragraph', () => {
    const planned = plan('- [ ] Before\n\nSome prose\n\n  - [ ] After')

    expect(planned.map((item) => item.parentIndex)).toEqual([null, null])
  })

  it('keeps a list open across a blank line', () => {
    const planned = plan('- [ ] Parent\n\n  - [ ] Child')

    expect(planned.map((item) => item.parentIndex)).toEqual([null, 0])
  })

  it('plans nothing for a note with no checkboxes', () => {
    expect(plan('# Title\n\nJust prose and a - bullet.')).toEqual([])
  })

  describe('create-contract limits', () => {
    it('leaves a line whose title exceeds 500 characters as plain markdown', () => {
      expect(plan(`- [ ] ${'a'.repeat(501)}`)).toEqual([])
      expect(titles(`- [ ] ${'a'.repeat(500)}`)).toEqual(['a'.repeat(500)])
    })

    it('drops an over-long tag and keeps the first casing of a repeated one', () => {
      const [item] = plan(`- [ ] Buy milk #Errand #errand #${'x'.repeat(51)} \u23eb`)

      expect(item.tags).toEqual(['Errand'])
    })

    it('caps the tag list at 20', () => {
      const tags = Array.from({ length: 25 }, (_, index) => `#tag${index}`).join(' ')
      const [item] = plan(`- [ ] Buy milk ${tags} \u23eb`)

      expect(item.tags).toHaveLength(20)
    })

    it('reports no tags for a line with no plugin syntax', () => {
      expect(plan('- [ ] Buy milk')[0].tags).toEqual([])
    })
  })

  describe('an already-persisted parent line', () => {
    it('hands back the enclosing line\u2019s existing task id as the parent', () => {
      const planned = plan('- [ ] Groceries {task:abc123}\n  - [ ] Milk')

      expect(planned).toHaveLength(1)
      expect(planned[0]).toMatchObject({
        title: 'Milk',
        parentIndex: null,
        parentTaskId: 'abc123'
      })
    })

    it('does not parent a checkbox two levels under an existing task', () => {
      const planned = plan('- [ ] A {task:abc123}\n  - [ ] B\n    - [ ] C')

      // B is a subtask of the existing task, so C is standalone — the same
      // 1-level cut-off the analyzer applies to a run-created parent.
      expect(planned.map((item) => [item.title, item.parentIndex, item.parentTaskId])).toEqual([
        ['B', null, 'abc123'],
        ['C', null, null]
      ])
    })

    it('reports no parent task id for a line this run creates the parent of', () => {
      const planned = plan('- [ ] Groceries\n  - [ ] Milk')

      expect(planned[1]).toMatchObject({ parentIndex: 0, parentTaskId: null })
    })
  })

  describe('CRLF', () => {
    it('plans a Windows-authored checklist the same as a LF one', () => {
      const planned = plan('- [ ] Pack bags\r\n  - [x] Charger\r\n')

      expect(planned.map((item) => [item.title, item.checked, item.parentIndex])).toEqual([
        ['Pack bags', false, null],
        ['Charger', true, 0]
      ])
    })

    it('keeps the carriage return out of the title', () => {
      expect(titles('- [ ] Buy milk\r')).toEqual(['Buy milk'])
    })
  })
})
