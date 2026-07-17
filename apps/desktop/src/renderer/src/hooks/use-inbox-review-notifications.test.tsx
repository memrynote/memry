import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useInboxReviewNotifications } from './use-inbox-review-notifications'

const toastFn = vi.fn()
vi.mock('sonner', () => ({ toast: (...a: unknown[]) => toastFn(...a) }))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

const openSidebarItem = vi.fn()
vi.mock('@/hooks/use-sidebar-navigation', () => ({
  useSidebarNavigation: () => ({ openSidebarItem })
}))

let dueCb: ((e: { count: number }) => void) | null = null
let openCb: (() => void) | null = null
const unsubscribeDue = vi.fn()
const unsubscribeOpen = vi.fn()

describe('useInboxReviewNotifications', () => {
  beforeEach(() => {
    toastFn.mockClear()
    openSidebarItem.mockClear()
    unsubscribeDue.mockClear()
    unsubscribeOpen.mockClear()
    window.api = {
      onInboxReviewDue: vi.fn((cb) => {
        dueCb = cb
        return unsubscribeDue
      }),
      onInboxReviewOpen: vi.fn((cb) => {
        openCb = cb
        return unsubscribeOpen
      })
    } as never
  })

  it('shows a calm toast with an open-inbox action on review-due', () => {
    renderHook(() => useInboxReviewNotifications())
    dueCb?.({ count: 4 })

    expect(toastFn).toHaveBeenCalledTimes(1)
    const [, options] = toastFn.mock.calls[0] as [string, { action: { onClick: () => void } }]
    expect(options.action).toBeDefined()

    // Clicking the toast action opens the inbox the same way the sidebar does.
    options.action.onClick()
    expect(openSidebarItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'inbox', title: 'Inbox', path: '/inbox' })
    )
  })

  it('opens the inbox on review-open', () => {
    renderHook(() => useInboxReviewNotifications())
    openCb?.()

    expect(openSidebarItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'inbox', title: 'Inbox', path: '/inbox' })
    )
  })

  it('unsubscribes both listeners on unmount', () => {
    const { unmount } = renderHook(() => useInboxReviewNotifications())
    unmount()

    expect(unsubscribeDue).toHaveBeenCalled()
    expect(unsubscribeOpen).toHaveBeenCalled()
  })
})
