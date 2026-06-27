import { screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders, resetMockApi } from '@tests/utils/render'

import { ConvertActions } from './convert-actions'
import type { InboxItem } from '@/types'

// i18n: return the last key segment so labels are predictable.
vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => key.split('.').at(-1) || key
  })
}))

const item = { id: 'item-1', type: 'note' } as unknown as InboxItem

describe('ConvertActions', () => {
  beforeEach(() => resetMockApi())

  it('renders the task form with the task-detail property rows and an add-task action', () => {
    renderWithProviders(<ConvertActions item={item} type="task" onConverted={vi.fn()} />)
    expect(screen.getByText('priority')).toBeInTheDocument()
    expect(screen.getByText('dueDate')).toBeInTheDocument()
    expect(screen.getByText('reminder')).toBeInTheDocument()
    expect(screen.getByText('project')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /addTask/i })).toBeEnabled()
  })

  it('renders the event form with a calendar + time pickers, disabling add-event until a date is set', () => {
    renderWithProviders(<ConvertActions item={item} type="event" onConverted={vi.fn()} />)
    expect(screen.getByText('date')).toBeInTheDocument()
    expect(screen.getByText('start')).toBeInTheDocument()
    expect(screen.getByText('location')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /addEvent/i })).toBeDisabled()
  })

  it('renders the reminder form, disabling set-reminder until a date is picked', () => {
    renderWithProviders(<ConvertActions item={item} type="reminder" onConverted={vi.fn()} />)
    expect(screen.getByText('remindAt')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /setReminder/i })).toBeDisabled()
  })
})
