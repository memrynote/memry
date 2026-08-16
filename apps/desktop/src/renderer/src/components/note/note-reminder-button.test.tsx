/**
 * Covers the note toolbar's reminder path end to end: the note typed into the
 * real `ReminderPicker` has to survive every hop down to the `reminders.create`
 * IPC payload. Nothing between the textarea and `window.api` is stubbed, so a
 * consumer that reads the wrong callback argument fails here instead of
 * silently dropping what the user wrote.
 */

import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderWithProviders, getMockApi, userEvent } from '@tests/utils/render'
import { NoteReminderButton } from './note-reminder-button'

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

// Radix's picker does not open in jsdom; this stand-in keeps the picker's own
// state machine (note textarea, preset selection, onSelect call) real.
vi.mock('@/components/ui/picker', () => {
  const pickerMocks: { onValueChange: ((value: string) => void) | null } = { onValueChange: null }

  const PickerRoot = ({
    children,
    onValueChange
  }: {
    children: React.ReactNode
    onValueChange?: (value: string) => void
  }): React.ReactElement => {
    pickerMocks.onValueChange = onValueChange ?? null
    return <div>{children}</div>
  }

  return {
    Picker: Object.assign(PickerRoot, {
      Trigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      Content: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      List: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      Footer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      Section: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      Separator: () => <hr />,
      Item: ({ value }: { value: string }) => (
        <button
          type="button"
          data-testid={`preset-${value}`}
          onClick={() => pickerMocks.onValueChange?.(value)}
        />
      )
    })
  }
})

describe('NoteReminderButton', () => {
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
    renderWithProviders(<NoteReminderButton noteId="note-1" />)

    await user.type(
      screen.getByPlaceholderText('phaseF.componentsReminderReminderPicker.addANoteOptional'),
      'check the contract clause'
    )
    await user.click(screen.getByTestId('preset-tomorrow'))

    await waitFor(() => {
      const api = getMockApi() as unknown as {
        reminders: { create: ReturnType<typeof vi.fn> }
      }
      expect(api.reminders.create).toHaveBeenCalledWith(
        expect.objectContaining({
          targetType: 'note',
          targetId: 'note-1',
          note: 'check the contract clause'
        })
      )
    })
  })
})
