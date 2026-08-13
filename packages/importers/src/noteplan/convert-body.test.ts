import { describe, it, expect } from 'vitest'
import { convertBody, taskPlaceholder } from './convert-body.ts'

describe('convertBody — markers', () => {
  it('turns `*` into a task checkbox with a placeholder', () => {
    const result = convertBody('* Buy milk')
    expect(result.markdown).toBe(`- [ ] Buy milk ${taskPlaceholder('t0')}`)
    expect(result.tasks).toEqual([
      {
        tempId: 't0',
        title: 'Buy milk',
        state: 'open',
        dueDate: null,
        completedAt: null,
        parentTempId: null
      }
    ])
  })

  it('reads done, cancelled and scheduled task states', () => {
    const result = convertBody('* [x] Done thing\n* [-] Dropped thing\n* [>] Moved thing')
    expect(result.tasks.map((t) => t.state)).toEqual(['done', 'cancelled', 'open'])
    // Cancelled renders checked so the checkbox reads as "not outstanding".
    expect(result.markdown.split('\n')[1]).toBe(`- [x] Dropped thing ${taskPlaceholder('t1')}`)
  })

  it('turns `+` into a plain checkbox with no task row', () => {
    const result = convertBody('+ 08:00 - 09:00 Reply to emails\n+ [x] Stakeholders confirmed')
    expect(result.markdown).toBe(
      '- [ ] 08:00 - 09:00 Reply to emails\n- [x] Stakeholders confirmed'
    )
    expect(result.tasks).toEqual([])
  })

  it('leaves `-` bullets alone', () => {
    const result = convertBody('- just a bullet')
    expect(result.markdown).toBe('- just a bullet')
    expect(result.tasks).toEqual([])
  })
})

describe('convertBody — dates', () => {
  it('lifts `>YYYY-MM-DD` out of the title into dueDate', () => {
    const result = convertBody('* Project kickoff >2025-11-03')
    expect(result.tasks[0].title).toBe('Project kickoff')
    expect(result.tasks[0].dueDate).toBe('2025-11-03')
    expect(result.markdown).toBe(`- [ ] Project kickoff ${taskPlaceholder('t0')}`)
  })

  it('lifts `@done(...)` out of the title into completedAt', () => {
    const result = convertBody('* [x] Ship it @done(2025-11-04 14:30)')
    expect(result.tasks[0].title).toBe('Ship it')
    expect(result.tasks[0].completedAt).toBe('2025-11-04')
    expect(result.tasks[0].state).toBe('done')
  })

  it('ignores a `>date` on a non-task line', () => {
    const result = convertBody('- see you >2025-11-03')
    expect(result.markdown).toBe('- see you >2025-11-03')
    expect(result.tasks).toEqual([])
  })
})

describe('convertBody — nesting', () => {
  it('converts tab indentation to two spaces per level', () => {
    const result = convertBody('* Parent\n\t* Child\n\t\t* Grandchild')
    expect(result.markdown.split('\n')).toEqual([
      `- [ ] Parent ${taskPlaceholder('t0')}`,
      `  - [ ] Child ${taskPlaceholder('t1')}`,
      `    - [ ] Grandchild ${taskPlaceholder('t2')}`
    ])
  })

  it('links nested tasks to the nearest shallower task', () => {
    const result = convertBody('* Parent\n\t* Child\n\t\t* Grandchild\n* Sibling')
    expect(result.tasks.map((t) => [t.tempId, t.parentTempId])).toEqual([
      ['t0', null],
      ['t1', 't0'],
      ['t2', 't1'],
      ['t3', null]
    ])
  })

  it('links a task nested under a checklist to the nearest shallower task', () => {
    const result = convertBody('* Parent\n\t+ a checklist step\n\t\t* Deep task')
    expect(result.tasks.map((t) => [t.tempId, t.parentTempId])).toEqual([
      ['t0', null],
      ['t1', 't0']
    ])
  })
})

describe('convertBody — pass-through', () => {
  it('leaves headings, tables, quotes and paragraphs untouched', () => {
    const source = '# Title\n\n> a quote\n\n| a | b |\n| - | - |\n\nplain text'
    expect(convertBody(source).markdown).toBe(source)
  })

  it('does not convert list markers inside a fenced code block', () => {
    const source = '```js\n* not a task\n+ not a checklist\n```'
    const result = convertBody(source)
    expect(result.markdown).toBe(source)
    expect(result.tasks).toEqual([])
  })

  it('leaves a `---` horizontal rule alone', () => {
    expect(convertBody('---').markdown).toBe('---')
  })

  it('preserves a trailing newline', () => {
    expect(convertBody('* Task\n').markdown).toBe(`- [ ] Task ${taskPlaceholder('t0')}\n`)
  })
})
