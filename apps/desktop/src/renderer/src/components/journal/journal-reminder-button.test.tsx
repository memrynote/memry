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

describe('JournalReminderButton', () => {
  beforeEach(() => {
    const api = getMockApi() as unknown as {
      reminders: Record<string, ReturnType<typeof vi.fn>>
    }
    api.reminders.getForTarget = vi.fn().mockResolvedValue([])
    api.reminders.create.mockClear()
    api.reminders.create.mockResolvedValue({ success: true })
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
})
