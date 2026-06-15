import { describe, it, expect } from 'vitest'
import { todoistPriorityToMemry } from './priority.ts'

describe('todoistPriorityToMemry', () => {
  it('maps Todoist 4/3/2/1 to Memry 4/3/2/0', () => {
    expect(todoistPriorityToMemry(4)).toBe(4)
    expect(todoistPriorityToMemry(3)).toBe(3)
    expect(todoistPriorityToMemry(2)).toBe(2)
    expect(todoistPriorityToMemry(1)).toBe(0)
  })
  it('maps out-of-range to 0', () => {
    expect(todoistPriorityToMemry(0)).toBe(0)
    expect(todoistPriorityToMemry(9)).toBe(0)
  })
})
