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

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  unlisten: new Map<string, () => void>()
}))

// The Rust scheduler's events, as the generated bindings deliver them.
vi.mock('../../../generated/bindings', () => {
  const event = (name: string) => ({
    listen: vi.fn(async (handler: (event: { payload: unknown }) => void) => {
      mocks.listeners.set(name, handler)
      const unlisten = vi.fn()
      mocks.unlisten.set(name, unlisten)
      return unlisten
    })
  })
  return {
    commands: {},
    events: {
      inboxReviewDueEvent: event('due'),
      inboxReviewOpenEvent: event('open')
    }
  }
})

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const dueCb = (payload: { count: number }) => mocks.listeners.get('due')?.({ payload })
const openCb = () => mocks.listeners.get('open')?.({ payload: {} })

describe('useInboxReviewNotifications', () => {
  beforeEach(() => {
    toastFn.mockClear()
    openSidebarItem.mockClear()
    mocks.listeners.clear()
    mocks.unlisten.clear()
  })

  it('shows a calm toast with an open-inbox action on review-due', async () => {
    renderHook(() => useInboxReviewNotifications())
    await flush()
    dueCb({ count: 4 })

    expect(toastFn).toHaveBeenCalledTimes(1)
    const [, options] = toastFn.mock.calls[0] as [string, { action: { onClick: () => void } }]
    expect(options.action).toBeDefined()

    // Clicking the toast action opens the inbox the same way the sidebar does.
    options.action.onClick()
    expect(openSidebarItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'inbox', title: 'Inbox', path: '/inbox' })
    )
  })

  it('opens the inbox on review-open', async () => {
    renderHook(() => useInboxReviewNotifications())
    await flush()
    openCb()

    expect(openSidebarItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'inbox', title: 'Inbox', path: '/inbox' })
    )
  })

  it('unsubscribes both listeners on unmount', async () => {
    const { unmount } = renderHook(() => useInboxReviewNotifications())
    await flush()
    unmount()
    await flush()

    expect(mocks.unlisten.get('due')).toHaveBeenCalled()
    expect(mocks.unlisten.get('open')).toHaveBeenCalled()
  })
})
