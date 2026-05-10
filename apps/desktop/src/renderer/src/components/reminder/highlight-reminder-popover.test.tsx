import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HighlightReminderPopover,
  useTextSelection,
  type HighlightSelection
} from './highlight-reminder-popover'

const mocks = vi.hoisted(() => ({
  createReminder: {
    mutateAsync: vi.fn(),
    isPending: false
  },
  toast: {
    success: vi.fn(),
    error: vi.fn()
  },
  logger: {
    error: vi.fn()
  }
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => key
  })
}))

vi.mock('sonner', () => ({
  toast: mocks.toast
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => mocks.logger
}))

vi.mock('@/hooks/use-reminders', () => ({
  useCreateReminder: () => mocks.createReminder
}))

vi.mock('./reminder-picker', () => ({
  ReminderPicker: ({
    onSelect,
    isLoading
  }: {
    onSelect: (date: Date, title?: string, note?: string) => void
    isLoading: boolean
  }) => (
    <button
      disabled={isLoading}
      onClick={() => onSelect(new Date('2026-05-12T09:30:00.000Z'), 'Read this later', 'Follow up')}
    >
      pick reminder
    </button>
  )
}))

function selectionFixture(overrides: Partial<HighlightSelection> = {}): HighlightSelection {
  return {
    text: 'Important highlighted text',
    startOffset: 5,
    endOffset: 31,
    rect: {
      top: 80,
      left: 120,
      width: 60,
      height: 20,
      bottom: 100,
      right: 180,
      x: 120,
      y: 80,
      toJSON: () => ({})
    } as DOMRect,
    ...overrides
  }
}

describe('HighlightReminderPopover', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mocks.createReminder.mutateAsync.mockResolvedValue({ success: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not render without a positioned selection', () => {
    const { rerender } = render(
      <HighlightReminderPopover noteId="note-1" selection={null} onClose={vi.fn()} />
    )

    expect(
      screen.queryByTitle(
        'phaseF.componentsReminderHighlightReminderPopover.setReminderForThisText'
      )
    ).not.toBeInTheDocument()

    rerender(
      <HighlightReminderPopover
        noteId="note-1"
        selection={selectionFixture({ rect: null })}
        onClose={vi.fn()}
      />
    )
    expect(
      screen.queryByTitle(
        'phaseF.componentsReminderHighlightReminderPopover.setReminderForThisText'
      )
    ).not.toBeInTheDocument()
  })

  it('creates a highlight reminder and closes on success, then reports failures', async () => {
    const onClose = vi.fn()
    const onReminderCreated = vi.fn()
    const { rerender } = render(
      <HighlightReminderPopover
        noteId="note-1"
        selection={selectionFixture()}
        onClose={onClose}
        onReminderCreated={onReminderCreated}
      />
    )

    fireEvent.click(
      screen.getByTitle('phaseF.componentsReminderHighlightReminderPopover.setReminderForThisText')
    )
    expect(screen.getByRole('dialog')).toHaveTextContent('Important highlighted text')

    fireEvent.click(screen.getByText('pick reminder'))
    await waitFor(() =>
      expect(mocks.createReminder.mutateAsync).toHaveBeenCalledWith({
        targetType: 'highlight',
        targetId: 'note-1',
        remindAt: '2026-05-12T09:30:00.000Z',
        title: 'Read this later',
        note: 'Follow up',
        highlightText: 'Important highlighted text',
        highlightStart: 5,
        highlightEnd: 31
      })
    )
    expect(mocks.toast.success).toHaveBeenCalledWith('reminders.toast.setForHighlight')
    expect(onClose).toHaveBeenCalled()
    expect(onReminderCreated).toHaveBeenCalled()

    mocks.createReminder.mutateAsync.mockRejectedValueOnce(new Error('nope'))
    rerender(
      <HighlightReminderPopover noteId="note-1" selection={selectionFixture()} onClose={onClose} />
    )
    fireEvent.click(
      screen.getByTitle('phaseF.componentsReminderHighlightReminderPopover.setReminderForThisText')
    )
    fireEvent.click(screen.getByText('pick reminder'))
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('reminders.toast.setFailed'))
  })

  it('tracks valid text selection and clears short, outside, collapsed, and disabled selections', async () => {
    const onSelectionChange = vi.fn()
    const container = document.createElement('div')
    const textNode = document.createTextNode('prefix selected text suffix')
    container.appendChild(textNode)
    document.body.appendChild(container)
    const containerRef = { current: container }
    const range = document.createRange()
    range.setStart(textNode, 7)
    range.setEnd(textNode, 20)
    ;(range as Range & { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = vi.fn(
      () => selectionFixture().rect as DOMRect
    )

    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      toString: () => 'selected text',
      getRangeAt: () => range
    } as Selection)

    const { result, rerender } = renderHook(
      ({ enabled = true, minLength = 3 }: { enabled?: boolean; minLength?: number }) =>
        useTextSelection({ containerRef, onSelectionChange, enabled, minLength }),
      { initialProps: { enabled: true, minLength: 3 } }
    )

    fireEvent(document, new Event('selectionchange'))
    await act(async () => {
      vi.advanceTimersByTime(150)
    })
    expect(result.current).toMatchObject({
      text: 'selected text',
      startOffset: 7,
      endOffset: 20
    })
    expect(onSelectionChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: 'selected text' })
    )

    fireEvent.mouseDown(document.body)
    expect(result.current).toBeNull()
    expect(onSelectionChange).toHaveBeenLastCalledWith(null)

    vi.mocked(window.getSelection).mockReturnValue({
      isCollapsed: true,
      toString: () => '',
      getRangeAt: () => range
    } as Selection)
    fireEvent(document, new Event('selectionchange'))
    await act(async () => {
      vi.advanceTimersByTime(150)
    })
    expect(result.current).toBeNull()

    vi.mocked(window.getSelection).mockReturnValue({
      isCollapsed: false,
      toString: () => 'ok',
      getRangeAt: () => range
    } as Selection)
    fireEvent(document, new Event('selectionchange'))
    await act(async () => {
      vi.advanceTimersByTime(150)
    })
    expect(result.current).toBeNull()

    rerender({ enabled: false, minLength: 3 })
    expect(result.current).toBeNull()
  })
})
