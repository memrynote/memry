import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CalendarInboxSnoozePopover } from './calendar-inbox-snooze-popover'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => key
  })
}))

vi.mock('@/components/snooze/snooze-picker', () => ({
  SnoozePicker: ({
    onSnooze,
    trigger
  }: {
    onSnooze: (snoozeUntil: string) => void
    trigger: React.ReactNode
  }) => (
    <div>
      {trigger}
      <button type="button" onClick={() => onSnooze('2026-05-15T09:00:00.000Z')}>
        pick snooze
      </button>
    </div>
  )
}))

describe('CalendarInboxSnoozePopover', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('routes actions and only dismisses for outside interactions', async () => {
    const user = userEvent.setup()
    const onOpenInInbox = vi.fn()
    const onUnsnooze = vi.fn()
    const onReschedule = vi.fn()
    const onDismiss = vi.fn()

    render(
      <CalendarInboxSnoozePopover
        item={
          {
            sourceId: 'inbox-1',
            title: 'Read launch notes',
            descriptionPreview: 'Follow up next week'
          } as never
        }
        anchorRect={{ x: 20, y: 30, width: 40, height: 50 }}
        onOpenInInbox={onOpenInInbox}
        onUnsnooze={onUnsnooze}
        onReschedule={onReschedule}
        onDismiss={onDismiss}
      />
    )

    expect(screen.getByText('Read launch notes')).toBeInTheDocument()
    expect(screen.getByText('Follow up next week')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /openInInbox/ }))
    await user.click(screen.getByRole('button', { name: /unsnoozeNow/ }))
    await user.click(screen.getByRole('button', { name: 'pick snooze' }))
    expect(onOpenInInbox).toHaveBeenCalledWith('inbox-1')
    expect(onUnsnooze).toHaveBeenCalledWith('inbox-1')
    expect(onReschedule).toHaveBeenCalledWith('inbox-1', '2026-05-15T09:00:00.000Z')

    fireEvent.pointerDown(screen.getByTestId('calendar-inbox-snooze-popover'))
    expect(onDismiss).not.toHaveBeenCalled()

    const portalTarget = document.createElement('div')
    portalTarget.setAttribute('role', 'dialog')
    document.body.appendChild(portalTarget)
    fireEvent.pointerDown(portalTarget)
    expect(onDismiss).not.toHaveBeenCalled()
    portalTarget.remove()

    fireEvent.pointerDown(document)
    fireEvent.pointerDown(document.body)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalledTimes(3)
  })
})
