import { describe, it, expect, vi, beforeEach } from 'vitest'

const { show, on, NotificationMock, supportedRef } = vi.hoisted(() => {
  const show = vi.fn()
  const on = vi.fn()
  const supportedRef = { value: true }
  const NotificationMock = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.on = on
    this.show = show
  })
  return { show, on, NotificationMock, supportedRef }
})

vi.mock('electron', () => ({
  Notification: Object.assign(NotificationMock, { isSupported: () => supportedRef.value }),
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('../lib/main-i18n', () => ({
  getMainI18n: () => ({
    getFixedT: () => (k: string, o?: { count?: number }) => `${k}:${o?.count ?? ''}`
  })
}))

import { sendTestReviewNotification, showReviewNotification } from './review-notification'

describe('review-notification', () => {
  beforeEach(() => {
    show.mockClear()
    on.mockClear()
    NotificationMock.mockClear()
    supportedRef.value = true
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
})
