import { fireEvent, screen } from '@testing-library/react'
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

  // Rows carry no visible labels (same rail as the task drawer); each row is
  // named by its tooltip instead.
  it('renders the task form with the task-detail property rows and an add-task action', () => {
    renderWithProviders(<ConvertActions item={item} type="task" onConverted={vi.fn()} />)
    expect(screen.getByTitle('priority')).toBeInTheDocument()
    expect(screen.getByTitle('dueDate')).toBeInTheDocument()
    expect(screen.getByTitle('reminder')).toBeInTheDocument()
    expect(screen.getByTitle('project')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /addTask/i })).toBeEnabled()
  })

  it('renders the event form with date, time and location rows, disabling add-event until a date is set', () => {
    renderWithProviders(<ConvertActions item={item} type="event" onConverted={vi.fn()} />)
    expect(screen.getByTitle('date')).toBeInTheDocument()
    expect(screen.getByLabelText('start')).toHaveValue('09:00')
    expect(screen.getByLabelText('end')).toHaveValue('10:00')
    expect(screen.getByPlaceholderText('location')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /addEvent/i })).toBeDisabled()
  })

  it('renders the reminder form, disabling set-reminder until a preset is picked', async () => {
    renderWithProviders(<ConvertActions item={item} type="reminder" onConverted={vi.fn()} />)
    expect(screen.getByText('remindAt')).toBeInTheDocument()
    const submit = screen.getByRole('button', { name: /setReminder/i })
    expect(submit).toBeDisabled()

    const presets = screen.getAllByRole('button', { pressed: false })
    fireEvent.click(presets[0])
    expect(await screen.findByRole('button', { pressed: true })).toBeInTheDocument()
    expect(submit).toBeEnabled()
  })

  it('portals the submit into the footer slot the panel provides', () => {
    const slot = document.createElement('div')
    document.body.appendChild(slot)
    renderWithProviders(
      <ConvertActions item={item} type="task" onConverted={vi.fn()} primaryActionSlot={slot} />
    )
    const submit = screen.getByRole('button', { name: /addTask/i })
    expect(slot).toContainElement(submit)
    // Submitting from outside the form still targets it.
    expect(submit).toHaveAttribute('form', document.querySelector('form')?.id)
    slot.remove()
  })
})
