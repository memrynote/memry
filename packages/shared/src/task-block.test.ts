import { describe, expect, it } from 'vitest'
import { scanTaskCheckboxStates, serializeTaskBlock } from './task-block'

describe('scanTaskCheckboxStates', () => {
  it('returns an empty map when the note has no task lines', () => {
    expect(scanTaskCheckboxStates('# Title\n\nJust prose.\n- [x] plain checkbox').size).toBe(0)
  })

  it('reads unchecked and checked task lines', () => {
    const md = ['- [ ] Buy milk {task:a1}', '- [x] Ship release {task:b2}'].join('\n')
    expect(scanTaskCheckboxStates(md)).toEqual(
      new Map([
        ['a1', false],
        ['b2', true]
      ])
    )
  })

  it('round-trips what serializeTaskBlock writes, including subtask indentation', () => {
    const md = [
      serializeTaskBlock({ taskId: 'parent', title: 'Parent', checked: false }),
      serializeTaskBlock({
        taskId: 'child',
        title: 'Child',
        checked: true,
        parentTaskId: 'parent'
      })
    ].join('\n')

    expect(scanTaskCheckboxStates(md)).toEqual(
      new Map([
        ['parent', false],
        ['child', true]
      ])
    )
  })

  it('tolerates other editors: any list marker, deep indent, uppercase X', () => {
    const md = ['* [X] Star {task:s1}', '+ [x] Plus {task:p1}', '      - [ ] Deep {task:d1}'].join(
      '\n'
    )
    expect(scanTaskCheckboxStates(md)).toEqual(
      new Map([
        ['s1', true],
        ['p1', true],
        ['d1', false]
      ])
    )
  })

  it('ignores non-checkbox lines that merely mention a task suffix', () => {
    const md = ['Some prose about {task:x9}', '- Bullet {task:y8}', '> [x] Quote {task:z7}'].join(
      '\n'
    )
    expect(scanTaskCheckboxStates(md).size).toBe(0)
  })

  it('ignores checkbox states other than space and x', () => {
    expect(scanTaskCheckboxStates('- [-] Half done {task:h1}').size).toBe(0)
  })
})
