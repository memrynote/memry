import { describe, it, expect, vi, beforeEach } from 'vitest'

const { show, on, NotificationMock, supportedRef, windowsRef } = vi.hoisted(() => {
  const show = vi.fn()
  const on = vi.fn()
  const supportedRef = { value: true }
  const windowsRef: { value: unknown[] } = { value: [] }
  const NotificationMock = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.on = on
    this.show = show
  })
  return { show, on, NotificationMock, supportedRef, windowsRef }
})

vi.mock('electron', () => ({
  Notification: Object.assign(NotificationMock, { isSupported: () => supportedRef.value }),
  BrowserWindow: { getAllWindows: () => windowsRef.value }
}))

vi.mock('../lib/main-i18n', () => ({
  getMainI18n: () => ({
    getFixedT: () => (k: string, o?: { count?: number }) => `${k}:${o?.count ?? ''}`
  })
}))

import { InboxChannels } from '@memry/contracts/inbox-channels'
import { sendTestReviewNotification, showReviewNotification } from './review-notification'

/**
 * Real Electron throws 'Object has been destroyed' on any access to a destroyed
 * window, and getAllWindows() can still list one (splash, quick capture,
 * print/export).
 */
function makeDestroyedWindow(): unknown {
  return {
    isDestroyed: () => true,
    isMinimized(): never {
      throw new Error('Object has been destroyed')
    },
    focus(): never {
      throw new Error('Object has been destroyed')
    },
    get webContents(): never {
      throw new Error('Object has been destroyed')
    }
  }
}

function makeLiveWindow(): {
  win: unknown
  send: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
} {
  const send = vi.fn()
  const focus = vi.fn()
  return {
    win: {
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: vi.fn(),
      focus,
      webContents: { send }
    },
    send,
    focus
  }
}

describe('review-notification', () => {
  beforeEach(() => {
    show.mockClear()
    on.mockClear()
    NotificationMock.mockClear()
    supportedRef.value = true
    windowsRef.value = []
  })

  it('sendTestReviewNotification shows the real title with the test body', () => {
    const result = sendTestReviewNotification()

    expect(result).toEqual({ supported: true })
    expect(show).toHaveBeenCalledTimes(1)
    expect(on).toHaveBeenCalledWith('click', expect.any(Function))
    expect(NotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'notification.inboxReview.title:',
        body: 'notification.inboxReview.testBody:',
        silent: false
      })
    )
  })

  it('sendTestReviewNotification reports unsupported without showing', () => {
    supportedRef.value = false
    const result = sendTestReviewNotification()

    expect(result).toEqual({ supported: false })
    expect(show).not.toHaveBeenCalled()
  })

  it('showReviewNotification uses the pluralized body with the count', () => {
    showReviewNotification(4)

    expect(show).toHaveBeenCalledTimes(1)
    expect(NotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'notification.inboxReview.body:4' })
    )
  })

  it('routes the click past a destroyed window to the first live one', () => {
    const live = makeLiveWindow()
    showReviewNotification(1)

    const clickHandler = on.mock.calls.find(([event]) => event === 'click')?.[1] as () => void
    expect(clickHandler).toBeTypeOf('function')

    // The window dies between the banner being shown and the user clicking it.
    windowsRef.value = [makeDestroyedWindow(), live.win]

    expect(() => clickHandler()).not.toThrow()
    expect(live.focus).toHaveBeenCalled()
    expect(live.send).toHaveBeenCalledWith(InboxChannels.events.REVIEW_OPEN, {})
  })
})
