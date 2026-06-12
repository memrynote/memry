import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TaskReminderButton } from './task-reminder-button'

const mocks = vi.hoisted(() => ({
  reminderState: null as any,
  pickerProps: null as any
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: { clockFormat: '24h' } })
}))

vi.mock('@/hooks/use-task-reminders', () => ({
  useTaskReminders: () => mocks.reminderState
}))

vi.mock('@/components/reminder/reminder-presets', () => ({
  formatReminderDate: () => 'FORMATTED'
}))

vi.mock('@/components/reminder', () => ({
  ReminderPicker: (props: { trigger: React.ReactNode }) => {
    mocks.pickerProps = props
    return <div>{props.trigger}</div>
  }
}))

const baseActions = {
  setReminder: vi.fn(),
  editReminder: vi.fn(),
  deleteReminder: vi.fn()
}

const reminder = (id: string) => ({ id, remindAt: '2026-05-12T09:00:00.000Z', status: 'pending' })

describe('TaskReminderButton', () => {
  beforeEach(() => {
    mocks.pickerProps = null
    mocks.reminderState = {
      reminders: [],
      activeReminders: [],
      hasActiveReminder: false,
      nextReminder: null,
      activeReminderCount: 0,
      isLoading: false,
      actions: baseActions
    }
  })

  it('shows a set-reminder affordance when no reminder is set', () => {
    render(<TaskReminderButton taskId="t1" />)

    expect(screen.getByText('reminders.setReminder')).toBeInTheDocument()
    expect(screen.queryByText('FORMATTED')).not.toBeInTheDocument()
  })

  it('shows the next reminder date when one is set', () => {
    const next = reminder('a')
    mocks.reminderState = {
      ...mocks.reminderState,
      activeReminders: [next],
      hasActiveReminder: true,
      nextReminder: next,
      activeReminderCount: 1
    }

    render(<TaskReminderButton taskId="t1" />)

    expect(screen.getByText('FORMATTED')).toBeInTheDocument()
    expect(screen.queryByText(/^\+/)).not.toBeInTheDocument()
  })

  it('shows a +N pill when more than one reminder is active', () => {
    const active = [reminder('a'), reminder('b'), reminder('c')]
    mocks.reminderState = {
      ...mocks.reminderState,
      activeReminders: active,
      hasActiveReminder: true,
      nextReminder: active[0],
      activeReminderCount: 3
    }

    render(<TaskReminderButton taskId="t1" />)

    expect(screen.getByText('+2')).toBeInTheDocument()
  })

  it('passes active reminders and edit/delete handlers to the picker', () => {
    const active = [reminder('a')]
    mocks.reminderState = {
      ...mocks.reminderState,
      activeReminders: active,
      hasActiveReminder: true,
      nextReminder: active[0],
      activeReminderCount: 1
    }

    render(<TaskReminderButton taskId="t1" />)

    expect(mocks.pickerProps.reminders).toBe(active)
    expect(typeof mocks.pickerProps.onEdit).toBe('function')
    expect(typeof mocks.pickerProps.onDelete).toBe('function')
  })
})
