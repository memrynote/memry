import { describe, it, expect, vi, beforeEach } from 'vitest'

const { show, on, NotificationMock, supportedRef, windowsRef } = vi.hoisted(() => {
  const showFn = vi.fn()
  const onFn = vi.fn()
  const supportedState = { value: true }
  const windowsState: { value: unknown[] } = { value: [] }
  const NotificationCtor = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.on = onFn
    this.show = showFn
  })
  return {
    show: showFn,
    on: onFn,
    NotificationMock: NotificationCtor,
    supportedRef: supportedState,
    windowsRef: windowsState
  }
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
import type { BrowserWindow } from 'electron'
import { sendTestReviewNotification, showReviewNotification } from './review-notification'
import { setMainWindow } from '../main-window'

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

  it('routes the click to the app window, not another window listed before it', () => {
    const sticky = makeLiveWindow()
    const app = makeLiveWindow()
    windowsRef.value = [sticky.win, app.win]
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fake covers every member the click handler touches
    setMainWindow(app.win as BrowserWindow)
    showReviewNotification(1)

    const clickHandler = on.mock.calls.find(([event]) => event === 'click')?.[1] as () => void
    clickHandler()

    expect(sticky.send).not.toHaveBeenCalled()
    expect(app.focus).toHaveBeenCalled()
    expect(app.send).toHaveBeenCalledWith(InboxChannels.events.REVIEW_OPEN, {})
  })
})
