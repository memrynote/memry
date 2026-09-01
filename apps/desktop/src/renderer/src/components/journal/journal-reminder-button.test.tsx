/**
 * Covers the journal toolbar's reminder path end to end: the note typed into
 * the real `ReminderPicker` has to survive every hop down to the
 * `reminders.create` IPC payload. Nothing between the textarea and `window.api`
 * is stubbed, so a consumer that reads the wrong callback argument fails here
 * instead of silently dropping what the user wrote.
 */

import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderWithProviders, getMockApi, userEvent } from '@tests/utils/render'
import { JournalReminderButton } from './journal-reminder-button'

vi.mock('@/lib/telemetry', () => ({ trackTelemetry: vi.fn() }))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: { clockFormat: '24h' } })
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() }
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

// Radix's picker does not open in jsdom; the shared stand-in keeps the picker's
// own state machine (note textarea, preset selection, onSelect call) real.
vi.mock('@/components/ui/picker', async () => {
  const { createPickerStub } = await import('@tests/utils/picker-stub')
  return createPickerStub()
})

function reminderApi(): Record<string, ReturnType<typeof vi.fn>> {
  return (getMockApi() as unknown as { reminders: Record<string, ReturnType<typeof vi.fn>> })
    .reminders
}

/**
 * `useNoteReminders` asks for both the note's own reminders and its highlight
 * reminders, so the seed has to answer per target type. Returning the same row
 * to both queries would list it twice and make the remove button ambiguous.
 */
function seedActiveReminder(targetType: 'journal' | 'note', targetId: string): void {
  reminderApi().getForTarget.mockImplementation((input: { targetType: string }) =>
    Promise.resolve(
      input.targetType === targetType
        ? [
            {
              id: `rem-${targetType}-1`,
              targetType,
              targetId,
              remindAt: '2026-05-17T09:00:00.000Z',
              status: 'pending',
              note: null
            }
          ]
        : []
    )
  )
}

describe('JournalReminderButton', () => {
  beforeEach(() => {
    const api = reminderApi()
    api.getForTarget = vi.fn().mockResolvedValue([])
    api.create.mockClear()
    api.create.mockResolvedValue({ success: true })
    api.update.mockClear()
    api.update.mockResolvedValue({ success: true, reminder: null })
    api.delete.mockClear()
    api.delete.mockResolvedValue({ success: true })
  })

  it('sends the note typed in the picker to reminders.create', async () => {
    const user = userEvent.setup()
    renderWithProviders(<JournalReminderButton journalDate="2026-05-10" />)

    await user.type(
      screen.getByPlaceholderText('phaseF.componentsReminderReminderPicker.addANoteOptional'),
      'revisit after the offsite'
    )
    await user.click(screen.getByTestId('preset-in-one-week'))

    await waitFor(() => {
      const api = getMockApi() as unknown as {
        reminders: { create: ReturnType<typeof vi.fn> }
      }
      expect(api.reminders.create).toHaveBeenCalledWith(
        expect.objectContaining({
          targetType: 'journal',
          targetId: '2026-05-10',
          note: 'revisit after the offsite'
        })
      )
    })
  })

  it('moves the reminder the entry already has instead of creating a second', async () => {
    const user = userEvent.setup()
    seedActiveReminder('journal', '2026-05-10')
    renderWithProviders(<JournalReminderButton journalDate="2026-05-10" />)

    await screen.findByRole('button', {
      name: /phaseF.componentsReminderReminderPicker.deleteReminder/
    })
    await user.click(screen.getByTestId('preset-in-one-week'))

    await waitFor(() => {
      expect(reminderApi().update).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'rem-journal-1' })
      )
    })
    expect(reminderApi().create).not.toHaveBeenCalled()
  })

  it('removes the reminder from the picker list', async () => {
    const user = userEvent.setup()
    seedActiveReminder('journal', '2026-05-10')
    renderWithProviders(<JournalReminderButton journalDate="2026-05-10" />)

    await user.click(
      await screen.findByRole('button', {
        name: /phaseF.componentsReminderReminderPicker.deleteReminder/
      })
    )

    await waitFor(() => {
      expect(reminderApi().delete).toHaveBeenCalledWith('rem-journal-1')
    })
  })
})
