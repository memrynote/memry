import { describe, expect, it } from 'vitest'

import { sortByApplyOrder } from './pull-coordinator'

describe('sortByApplyOrder', () => {
  it('applies FK parents before children regardless of cursor order', () => {
    const sorted = sortByApplyOrder([
      { id: 't1', type: 'task' },
      { id: 'n1', type: 'note' },
      { id: 'p1', type: 'project' },
      { id: 'm1', type: 'agent_message' },
      { id: 'c1', type: 'agent_conversation' }
    ])

    expect(sorted.map((i) => i.type)).toEqual([
      'project',
      'agent_conversation',
      'note',
      'task',
      'agent_message'
    ])
  })

  it('keeps unknown types in the middle rank without reordering among themselves', () => {
    const sorted = sortByApplyOrder([
      { id: '1', type: 'task' },
      { id: '2', type: 'mystery' },
      { id: '3', type: 'journal' },
      { id: '4', type: 'project' }
    ])

    expect(sorted.map((i) => i.id)).toEqual(['4', '2', '3', '1'])
  })
})
