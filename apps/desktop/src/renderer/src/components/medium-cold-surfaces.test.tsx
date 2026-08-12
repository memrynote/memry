import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LinkingPending } from '@/components/sync/linking-pending'
import { NaturalDateInput, type NaturalDateInputRef } from '@/components/tasks/natural-date-input'
import { EmojiPicker } from '@/components/note/note-title/EmojiPicker'
import { useReminderNotifications } from '@/hooks/use-reminder-notifications'

const parseNaturalDate = vi.hoisted(() => vi.fn())
const toastMock = vi.hoisted(() => ({
  base: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn()
}))
const openTab = vi.hoisted(() => vi.fn())
const dismissMutate = vi.hoisted(() => vi.fn())
const clipboardWrite = vi.fn()

vi.mock('@memry/i18n/renderer', () => ({
  // Keyless calls still render as the bare key; interpolated ones append their
  // values so a test can prove the caller actually passed them through.
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key
  })
}))

vi.mock('@/lib/natural-date-parser', () => ({
  parseNaturalDate
}))

vi.mock('sonner', () => ({
  toast: Object.assign(toastMock.base, {
    success: toastMock.success,
    error: toastMock.error,
    info: toastMock.info
  })
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn()
  })
}))

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({ openTab })
}))

vi.mock('@/hooks/use-reminders', () => ({
  useDismissReminder: () => ({ mutate: dismissMutate })
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({
    open,
    onOpenChange,
    children
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    children: React.ReactNode
  }) => (
    <div>
      <button onClick={() => onOpenChange(true)}>open recovery dialog</button>
      <button onClick={() => onOpenChange(false)}>close recovery dialog</button>
      {open ? <div role="dialog">{children}</div> : null}
    </div>
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>
}))

let pickerOpenChange = vi.fn()

vi.mock('@/components/ui/picker', () => {
  const PickerRoot = ({
    value,
    onValueChange,
    children
  }: {
    value: string | null
    onValueChange: (value: string) => void
    children: React.ReactNode
  }) => (
    <div data-value={value ?? ''} data-testid="picker-root">
      <button onClick={() => onValueChange('work')}>select work from picker</button>
      {children}
    </div>
  )

  return {
    Picker: Object.assign(PickerRoot, {
      Trigger: ({ children }: { children: React.ReactNode }) => (
        <button type="button">{children}</button>
      ),
      Content: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      List: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      Empty: ({ message, action }: { message: string; action?: React.ReactNode }) => (
        <div>
          <p>{message}</p>
          {action}
        </div>
      ),
      Item: ({
        value,
        label,
        trailing
      }: {
        value: string
        label: string
        trailing?: React.ReactNode
      }) => (
        <div>
          <button type="button" onClick={() => pickerOpenChange(value)}>
            {label}
          </button>
          {trailing}
        </div>
      )
    }),
    usePickerContext: () => ({ onOpenChange: pickerOpenChange })
  }
})

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick
  }: {
    children: React.ReactNode
    onClick?: () => void
  }) => <button onClick={onClick}>{children}</button>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@emoji-mart/data', () => ({ default: {} }))
vi.mock('@emoji-mart/react', () => ({
  default: ({
    onEmojiSelect,
    theme
  }: {
    onEmojiSelect: (emoji: unknown) => void
    theme: string
  }) => (
    <button data-theme={theme} onClick={() => onEmojiSelect({ native: 'rocket' })}>
      emoji mart picker
    </button>
  )
}))
vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'dark' })
}))
vi.mock('@/components/note/note-title/use-click-outside', () => ({
  useClickOutside: vi.fn()
}))
vi.mock('@/components/note/note-title/HugeIconGrid', () => ({
  HugeIconGrid: ({ onSelect }: { onSelect: (icon: string) => void }) => (
    <button onClick={() => onSelect('calendar')}>huge icon grid</button>
  )
}))

function installWindowApi(overrides: Partial<typeof window.api> = {}) {
  ;(window as Window & { api: unknown }).api = {
    syncLinking: {
      completeLinkingQr: vi.fn()
    },
    onReminderDue: vi.fn(),
    onReminderClicked: vi.fn(),
    ...overrides
  }
}

describe('medium cold renderer surfaces', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    pickerOpenChange = vi.fn()
    clipboardWrite.mockReset()
    clipboardWrite.mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: clipboardWrite
      }
    })
    class ResizeObserverStub {
      observe = vi.fn()
      disconnect = vi.fn()
    }
    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      value: ResizeObserverStub
    })
    installWindowApi()
  })

  it('polls linking sessions, formats verification code, completes, and handles failures', async () => {
    vi.useFakeTimers()
    const onComplete = vi.fn()
    const onError = vi.fn()
    const onCancel = vi.fn()
    window.api.syncLinking.completeLinkingQr = vi.fn().mockResolvedValueOnce({
      success: false,
      error: 'Session not yet approved'
    })

    render(
      <LinkingPending
        sessionId="session-1"
        verificationCode="123456"
        onComplete={onComplete}
        onError={onError}
        onCancel={onCancel}
      />
    )

    expect(screen.getByText('123 456')).toBeInTheDocument()
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    expect(window.api.syncLinking.completeLinkingQr).toHaveBeenCalledWith({
      sessionId: 'session-1'
    })

    window.api.syncLinking.completeLinkingQr = vi.fn().mockResolvedValueOnce({ success: true })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(onComplete).toHaveBeenCalled()
    expect(screen.getByText('setup.linking.pendingSuccess')).toBeInTheDocument()

    vi.useRealTimers()

    const failing = render(
      <LinkingPending sessionId="bad" onComplete={vi.fn()} onError={onError} onCancel={onCancel} />
    )
    window.api.syncLinking.completeLinkingQr = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'Expired session' })
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Expired session'))
    await userEvent.click(screen.getByRole('button', { name: 'setup.linking.goBack' }))
    expect(onCancel).toHaveBeenCalled()
    failing.unmount()
  })

  it('parses natural dates, exposes imperative methods, selects valid dates, and shows errors', async () => {
    vi.useFakeTimers()
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const onSelect = vi.fn()
    const onInputChange = vi.fn()
    const inputRef = { current: null as NaturalDateInputRef | null }

    parseNaturalDate.mockReturnValueOnce({
      success: true,
      result: { date: '2026-05-15', label: 'next friday' },
      displayText: 'Fri, May 15'
    })

    render(
      <NaturalDateInput
        ref={inputRef}
        onSelect={onSelect}
        onInputChange={onInputChange}
        className="date-shell"
      />
    )

    await user.type(screen.getByRole('textbox'), 'next friday')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    expect(parseNaturalDate).toHaveBeenCalledWith('next friday')
    expect(screen.getByText('Fri, May 15')).toBeInTheDocument()
    await user.click(
      screen.getByRole('button', { name: 'phaseF.componentsTasksNaturalDateInput.select' })
    )
    expect(onSelect).toHaveBeenCalledWith({ date: '2026-05-15', label: 'next friday' })
    expect(inputRef.current?.isEmpty()).toBe(true)

    parseNaturalDate.mockReturnValueOnce({ success: false, error: 'No date found' })
    await act(async () => {
      inputRef.current?.setValue('nonsense')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    expect(await screen.findByText('No date found')).toBeInTheDocument()
    expect(inputRef.current?.getValue()).toBe('nonsense')
    expect(onInputChange).toHaveBeenCalledWith(expect.stringContaining('next friday'))
  })

  it('selects emoji and icons, removes an existing emoji, handles escape, and renders closed state', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onSelect = vi.fn()
    const onRemove = vi.fn()

    const { rerender, container } = render(
      <EmojiPicker
        isOpen={false}
        onClose={onClose}
        onSelect={onSelect}
        onRemove={onRemove}
        hasEmoji={false}
      />
    )
    expect(container.firstChild).toBeNull()

    rerender(
      <EmojiPicker isOpen onClose={onClose} onSelect={onSelect} onRemove={onRemove} hasEmoji />
    )
    await user.click(screen.getByRole('button', { name: 'emoji mart picker' }))
    expect(onSelect).toHaveBeenCalledWith('rocket')
    expect(onClose).toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'menus.emoji.iconsTab' }))
    await user.click(screen.getByRole('button', { name: 'huge icon grid' }))
    expect(onSelect).toHaveBeenCalledWith('icon:calendar')

    await user.click(screen.getByRole('button', { name: 'button.remove' }))
    expect(onRemove).toHaveBeenCalled()

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })

  it('shows due reminder toasts, summary toasts, dismisses, and navigates clicks', () => {
    const unsubDue = vi.fn()
    const unsubClicked = vi.fn()
    const dueCallbacks: Array<(event: unknown) => void> = []
    const clickCallbacks: Array<(event: unknown) => void> = []
    window.api.onReminderDue = vi.fn((callback) => {
      dueCallbacks.push(callback)
      return unsubDue
    })
    window.api.onReminderClicked = vi.fn((callback) => {
      clickCallbacks.push(callback)
      return unsubClicked
    })

    const { unmount } = renderHook(() => useReminderNotifications())

    const reminders = [
      {
        id: 'rem-1',
        title: '',
        targetType: 'highlight',
        targetTitle: 'Important Note',
        targetId: 'note-1',
        highlightText: 'x'.repeat(90)
      },
      {
        id: 'rem-2',
        title: 'Journal prompt',
        targetType: 'journal',
        targetId: '2026-05-10',
        note: 'write now'
      },
      {
        id: 'rem-3',
        title: '',
        targetType: 'note',
        targetId: 'note-3'
      },
      { id: 'rem-4', title: 'R4', targetType: 'note', targetId: 'note-4' },
      { id: 'rem-5', title: 'R5', targetType: 'note', targetId: 'note-5' },
      { id: 'rem-6', title: 'R6', targetType: 'note', targetId: 'note-6' }
    ]

    act(() => {
      dueCallbacks[0]({ reminders, count: 6 })
    })

    expect(toastMock.base).toHaveBeenCalledTimes(5)
    expect(toastMock.info).toHaveBeenCalledWith('toast.moreRemindersDue:{"count":1}', {
      description: 'toast.moreRemindersDueHint'
    })

    const firstToastOptions = toastMock.base.mock.calls[0][1]
    firstToastOptions.action.onClick()
    firstToastOptions.cancel.onClick()
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'note',
        title: 'Important Note',
        entityId: 'note-1'
      })
    )
    expect(dismissMutate).toHaveBeenCalledWith('rem-1')

    act(() => {
      clickCallbacks[0]({ reminder: reminders[1] })
    })
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'journal',
        path: '/journal?date=2026-05-10'
      })
    )

    unmount()
    expect(unsubDue).toHaveBeenCalled()
    expect(unsubClicked).toHaveBeenCalled()
  })
})
