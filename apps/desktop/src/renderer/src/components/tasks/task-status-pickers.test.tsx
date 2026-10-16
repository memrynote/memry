/**
 * A task can hold none of its project's statuses: none was set (a task made from
 * a note line, the inbox, the CLI or an agent), its status was deleted, or it came
 * from another project. The board files such a task under the project's first
 * status, so the status pickers name that status too, not "Unknown".
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { InlineStatusPopover } from './inline-status-popover'
import { InteractiveStatusBadge } from './interactive-status-badge'
import type { Status } from '@/data/tasks-data'

const statuses: Status[] = [
  { id: 'review', name: 'Review', color: '#a855f7', type: 'in_progress', order: 1 },
  { id: 'backlog', name: 'Backlog', color: '#6b7280', type: 'todo', order: 0 }
]

const pickers = [
  [
    'status badge',
    (statusId: string) =>
      render(
        <InteractiveStatusBadge statusId={statusId} statuses={statuses} onStatusChange={vi.fn()} />
      )
  ],
  [
    'row status picker',
    (statusId: string) =>
      render(
        <InlineStatusPopover
          statusId={statusId}
          statuses={statuses}
          isCompleted={false}
          onStatusChange={vi.fn()}
          onToggleComplete={vi.fn()}
        />
      )
  ]
] as const

describe.each(pickers)('%s', (_, renderPicker) => {
  it.each([
    ['no status', '', 'Backlog'],
    ['a deleted status', 'status-gone', 'Backlog'],
    ['its own status', 'review', 'Review']
  ])('names the status of a task with %s', (_, statusId, shown) => {
    renderPicker(statusId)

    expect(screen.getByRole('button', { name: `Status: ${shown}. Click to change.` })).toBeTruthy()
  })
})
