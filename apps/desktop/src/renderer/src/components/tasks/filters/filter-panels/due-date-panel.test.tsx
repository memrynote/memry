import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import type { ReactNode } from 'react'
import { createRendererI18n } from '@memry/i18n/renderer'

import { DueDatePanel } from './due-date-panel'
import type { DueDateFilter } from '@/data/tasks-data'

// The real one reads general settings over IPC and renders a month grid;
// neither is what this panel's own rows are about.
vi.mock('@/components/tasks/date-picker-content', () => ({
  DatePickerContent: () => <div data-testid="date-picker" />
}))

let i18nEn: I18nInstance

beforeAll(async () => {
  i18nEn = await createRendererI18n({ locale: 'en' })
})

const renderPanel = (dueDate: DueDateFilter) => {
  const onSelectDueDate = vi.fn()
  const onClearDueDate = vi.fn()

  render(
    <DueDatePanel
      dueDate={dueDate}
      onSelectDueDate={onSelectDueDate}
      onSelectCalendarDate={vi.fn()}
      onClearDueDate={onClearDueDate}
      onGoBack={vi.fn()}
    />,
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <I18nextProvider i18n={i18nEn}>{children}</I18nextProvider>
      )
    }
  )

  return {
    onSelectDueDate,
    onClearDueDate,
    row: screen.getByRole('button', { name: 'No due date' })
  }
}

describe('DueDatePanel — no due date', () => {
  it('filters down to undated tasks when the row is picked', () => {
    const { onSelectDueDate, row } = renderPanel({
      type: 'any',
      customStart: null,
      customEnd: null
    })

    expect(row).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(row)
    expect(onSelectDueDate).toHaveBeenCalledWith('none')
  })

  it('clears back to any due date when the active row is picked again', () => {
    const { onSelectDueDate, onClearDueDate, row } = renderPanel({
      type: 'none',
      customStart: null,
      customEnd: null
    })

    expect(row).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(row)
    expect(onClearDueDate).toHaveBeenCalledTimes(1)
    expect(onSelectDueDate).not.toHaveBeenCalled()
  })
})
