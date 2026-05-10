import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { renderWithProviders, userEvent } from '@tests/utils/render'
import { ReminderPicker } from './reminder-picker'

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

    expect(onSelect).toHaveBeenCalledWith(
      new Date(2026, 4, 10, 14, 0, 0, 0),
      undefined,
      'bring account notes'
    )
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

    expect(screen.getByRole('button', { name: /Set Reminder/ })).toBeDisabled()

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

    await user.click(screen.getByRole('button', { name: /Set Reminder/ }))

    expect(onSelect).toHaveBeenCalledWith(
      new Date(2026, 4, 12, 15, 45, 0, 0),
      undefined,
      'custom note'
    )
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

    expect(screen.getByRole('button', { name: 'Setting...' })).toBeDisabled()

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
})
