import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { renderWithProviders, userEvent } from '@tests/utils/render'
import { trackTelemetry } from '@/lib/telemetry'
import { ReminderPicker } from './reminder-picker'

vi.mock('@/lib/telemetry', () => ({ trackTelemetry: vi.fn() }))

const pickerMocks = vi.hoisted(() => ({
  onValueChange: null as null | ((value: string) => void),
  onOpenChange: null as null | ((open: boolean) => void)
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: { clockFormat: '24h' } })
}))

vi.mock('@/components/tasks/date-picker-calendar', () => ({
  DatePickerCalendar: ({ onSelect }: { onSelect: (date: Date) => void }) => (
    <button type="button" onClick={() => onSelect(new Date(2026, 4, 12, 0, 0, 0, 0))}>
      Select May 12
    </button>
  )
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    type = 'button',
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={type} {...props}>
      {children}
    </button>
  )
}))

vi.mock('@/components/ui/picker', () => {
  const PickerRoot = ({
    children,
    onValueChange,
    onOpenChange
  }: {
    children: React.ReactNode
    onValueChange?: (value: string) => void
    onOpenChange?: (open: boolean) => void
  }) => {
    pickerMocks.onValueChange = onValueChange ?? null
    pickerMocks.onOpenChange = onOpenChange ?? null
    return <div>{children}</div>
  }

  return {
    Picker: Object.assign(PickerRoot, {
      Trigger: ({ children }: { children: React.ReactNode }) => (
        <div onClick={() => pickerMocks.onOpenChange?.(true)}>{children}</div>
      ),
      Content: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      List: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      Footer: ({ children, className }: { children: React.ReactNode; className?: string }) => (
        <div data-slot="picker-footer" className={className}>
          {children}
        </div>
      ),
      Section: ({ label, children }: { label: string; children: React.ReactNode }) => (
        <section aria-label={label}>
          <h3>{label}</h3>
          {children}
        </section>
      ),
      Separator: () => <hr />,
      Item: ({
        label,
        value,
        icon,
        trailing
      }: {
        label: string
        value: string
        icon?: React.ReactNode
        trailing?: React.ReactNode
      }) => (
        <button type="button" onClick={() => pickerMocks.onValueChange?.(value)}>
          {icon}
          <span>{label}</span>
          {trailing}
        </button>
      )
    })
  }
})

describe('ReminderPicker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 4, 10, 10, 0, 0, 0))
    pickerMocks.onValueChange = null
    pickerMocks.onOpenChange = null
    vi.mocked(trackTelemetry).mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('selects a standard preset with an optional note', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const onSelect = vi.fn()

    renderWithProviders(<ReminderPicker onSelect={onSelect} showNote size="lg" />)

    await user.click(screen.getByRole('button', { name: /remind/ }))
    fireEvent.change(
      screen.getByPlaceholderText('phaseF.componentsReminderReminderPicker.addANoteOptional'),
      { target: { value: 'bring account notes' } }
    )
    await user.click(screen.getByRole('button', { name: /Later Today/ }))

    expect(onSelect).toHaveBeenCalledWith(new Date(2026, 4, 10, 14, 0, 0, 0), 'bring account notes')
  })

  it('moves into custom mode, formats the selected time, and submits a custom reminder', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const onSelect = vi.fn()

    renderWithProviders(
      <ReminderPicker
        onSelect={onSelect}
        presetType="journal"
        trigger={<button type="button">Journal reminder</button>}
        showNoteField
      />
    )

    await user.click(screen.getByRole('button', { name: 'Journal reminder' }))
    await user.click(
      screen.getByRole('button', {
        name: /phaseF.componentsReminderReminderPicker.pickDateTime/
      })
    )

    expect(
      screen.getByRole('button', { name: /phaseF.componentsReminderReminderPicker.setReminder/ })
    ).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Select May 12' }))
    fireEvent.change(screen.getByLabelText(/phaseF.componentsReminderReminderPicker.time/), {
      target: { value: '15:45' }
    })
    fireEvent.change(
      screen.getByPlaceholderText(
        'phaseF.componentsReminderReminderPicker.whyAreYouSettingThisReminder'
      ),
      { target: { value: 'custom note' } }
    )

    expect(screen.getByText('Tuesday at 15:45')).toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: /phaseF.componentsReminderReminderPicker.setReminder/ })
    )

    expect(onSelect).toHaveBeenCalledWith(new Date(2026, 4, 12, 15, 45, 0, 0), 'custom note')
  })

  it('pins the confirm button in the footer and scrolls the body above it', async () => {
    // The custom panel is taller than the room Radix leaves under a trigger low
    // in the window, and `Picker.Content` clips its overflow. Anything below the
    // fold in an unscrollable body is unreachable, so the confirm action has to
    // sit outside the part that shrinks.
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })

    renderWithProviders(<ReminderPicker onSelect={vi.fn()} showNoteField />)

    await user.click(
      screen.getByRole('button', {
        name: /phaseF.componentsReminderReminderPicker.pickDateTime/
      })
    )
    await user.click(screen.getByRole('button', { name: 'Select May 12' }))

    const footer = document.querySelector('[data-slot="picker-footer"]')
    const confirm = screen.getByRole('button', {
      name: /phaseF.componentsReminderReminderPicker.setReminder/
    })
    const body = document.querySelector('.overflow-y-auto')

    expect(footer).not.toBeNull()
    expect(body).not.toBeNull()
    expect(footer?.contains(confirm)).toBe(true)
    // The preview travels with the button: confirming without seeing what you
    // are confirming is its own bug.
    expect(footer?.contains(screen.getByText('Tuesday at 09:00'))).toBe(true)
    expect(body?.contains(confirm)).toBe(false)
    expect(
      body?.contains(screen.getByLabelText(/phaseF.componentsReminderReminderPicker.time/))
    ).toBe(true)
  })

  const MANAGED = [
    { id: 'r1', remindAt: '2026-05-12T09:00:00.000Z', status: 'pending', note: 'orig note' },
    { id: 'r2', remindAt: '2026-05-20T08:00:00.000Z', status: 'pending', note: undefined }
  ]

  it('lists existing reminders with edit and delete actions', () => {
    renderWithProviders(
      <ReminderPicker onSelect={vi.fn()} reminders={MANAGED} onEdit={vi.fn()} onDelete={vi.fn()} />
    )

    expect(screen.getByText(/\(2\)/)).toBeInTheDocument()
    expect(screen.getByText('orig note')).toBeInTheDocument()
    expect(
      screen.getAllByRole('button', {
        name: /phaseF.componentsReminderReminderPicker.deleteReminder/
      })
    ).toHaveLength(2)
    expect(
      screen.getAllByRole('button', {
        name: /phaseF.componentsReminderReminderPicker.editReminder/
      })
    ).toHaveLength(2)
  })

  it('omits the management list when no reminders are passed', () => {
    renderWithProviders(<ReminderPicker onSelect={vi.fn()} />)

    expect(
      screen.queryByRole('button', {
        name: /phaseF.componentsReminderReminderPicker.deleteReminder/
      })
    ).not.toBeInTheDocument()
  })

  it('deletes a reminder by id', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const onDelete = vi.fn()

    renderWithProviders(
      <ReminderPicker onSelect={vi.fn()} reminders={MANAGED} onEdit={vi.fn()} onDelete={onDelete} />
    )

    await user.click(
      screen.getAllByRole('button', {
        name: /phaseF.componentsReminderReminderPicker.deleteReminder/
      })[0]
    )

    expect(onDelete).toHaveBeenCalledWith('r1')
  })

  it('edits a reminder through a prefilled date, time, and note', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const onEdit = vi.fn()

    renderWithProviders(
      <ReminderPicker
        onSelect={vi.fn()}
        showNote
        reminders={MANAGED}
        onEdit={onEdit}
        onDelete={vi.fn()}
      />
    )

    await user.click(
      screen.getAllByRole('button', {
        name: /phaseF.componentsReminderReminderPicker.editReminder/
      })[0]
    )

    await user.click(screen.getByRole('button', { name: 'Select May 12' }))
    fireEvent.change(screen.getByLabelText(/phaseF.componentsReminderReminderPicker.time/), {
      target: { value: '10:15' }
    })

    await user.click(
      screen.getByRole('button', { name: /phaseF.componentsReminderReminderPicker.save/ })
    )

    expect(onEdit).toHaveBeenCalledWith('r1', new Date(2026, 4, 12, 10, 15, 0, 0), 'orig note')
  })

  it('resets custom state when returning to presets and shows loading state', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })

    renderWithProviders(<ReminderPicker onSelect={vi.fn()} isLoading showNoteField />)

    await user.click(
      screen.getByRole('button', {
        name: /phaseF.componentsReminderReminderPicker.pickDateTime/
      })
    )
    await user.click(screen.getByRole('button', { name: 'Select May 12' }))

    expect(
      screen.getByRole('button', { name: 'phaseF.componentsReminderReminderPicker.setting' })
    ).toBeDisabled()

    await user.click(
      screen.getByRole('button', {
        name: /phaseF.componentsReminderReminderPicker.backToPresets/
      })
    )

    expect(
      screen.getByRole('button', {
        name: /phaseF.componentsReminderReminderPicker.pickDateTime/
      })
    ).toBeInTheDocument()
  })

  describe('telemetry', () => {
    it('reports a preset reminder as created, tagged with the preset id', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })

      renderWithProviders(
        <ReminderPicker onSelect={vi.fn()} showNote telemetrySurface="notes" size="lg" />
      )

      await user.click(screen.getByRole('button', { name: /remind/ }))
      fireEvent.change(
        screen.getByPlaceholderText('phaseF.componentsReminderReminderPicker.addANoteOptional'),
        { target: { value: 'bring account notes' } }
      )
      await user.click(screen.getByRole('button', { name: /Later Today/ }))

      expect(trackTelemetry).toHaveBeenCalledWith('reminder_created', {
        surface: 'notes',
        action: 'created',
        source: 'preset',
        dimensions: { value: 'later-today' }
      })
    })

    it('reports a custom date & time reminder as created, with no preset dimension', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })

      renderWithProviders(<ReminderPicker onSelect={vi.fn()} telemetrySurface="journal" />)

      await user.click(
        screen.getByRole('button', {
          name: /phaseF.componentsReminderReminderPicker.pickDateTime/
        })
      )
      await user.click(screen.getByRole('button', { name: 'Select May 12' }))
      await user.click(
        screen.getByRole('button', {
          name: /phaseF.componentsReminderReminderPicker.setReminder/
        })
      )

      expect(trackTelemetry).toHaveBeenCalledWith('reminder_created', {
        surface: 'journal',
        action: 'created',
        source: 'custom',
        dimensions: undefined
      })
    })

    it('reports a deleted reminder', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })

      renderWithProviders(
        <ReminderPicker
          onSelect={vi.fn()}
          reminders={MANAGED}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          telemetrySurface="tasks"
        />
      )

      await user.click(
        screen.getAllByRole('button', {
          name: /phaseF.componentsReminderReminderPicker.deleteReminder/
        })[0]
      )

      expect(trackTelemetry).toHaveBeenCalledWith('reminder_deleted', {
        surface: 'tasks',
        action: 'deleted'
      })
    })

    it('stays silent when no surface is supplied', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })

      renderWithProviders(
        <ReminderPicker
          onSelect={vi.fn()}
          reminders={MANAGED}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
        />
      )

      await user.click(screen.getByRole('button', { name: /Later Today/ }))
      await user.click(
        screen.getAllByRole('button', {
          name: /phaseF.componentsReminderReminderPicker.deleteReminder/
        })[0]
      )

      expect(trackTelemetry).not.toHaveBeenCalled()
    })
  })
})
