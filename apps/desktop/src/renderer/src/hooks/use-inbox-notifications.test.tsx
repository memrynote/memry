/**
 * useInboxNotifications tests
 *
 * These drive the REAL i18n instance (no `t: (key) => key` stub), because the
 * bug being guarded here is precisely that the copy never reached the
 * catalogue: a stubbed `t` would happily "pass" against hard-coded English.
 * The German case is the one that actually discriminates — before the fix the
 * hook emitted English no matter what locale was mounted.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import type { InboxItemListItem, InboxSnoozeDueEvent } from '@memry/rpc/inbox'
import { useInboxNotifications } from './use-inbox-notifications'

const { toastInfo } = vi.hoisted(() => ({ toastInfo: vi.fn() }))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    info: toastInfo,
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
    promise: vi.fn(),
    custom: vi.fn()
  }),
  Toaster: () => null
}))

// German copy for the same three keys. It only exists in this test: the repo
// convention is to land new keys in `en` and bulk-translate later, so shipping
// a hand-rolled `de` string would jump that queue.
const GERMAN_SNOOZE_DUE = {
  snoozeDue: {
    notificationTitle:
      '{count, plural, one {# zurückgestellter Eintrag} other {# zurückgestellte Einträge}}',
    notificationBody:
      '{count, plural, one {Dein zurückgestellter Eintrag ist bereit} other {Deine zurückgestellten Einträge sind bereit}}',
    toast:
      '{count, plural, =1 {„{itemTitle}“ ist zurück aus dem Schlummer} other {# zurückgestellte Einträge sind zurück}}'
  }
}

let i18nEn: I18nInstance
let i18nDe: I18nInstance

type RaisedNotification = { title: string; options: NotificationOptions }

const raised: RaisedNotification[] = []
const requestPermission = vi.fn(() => Promise.resolve<NotificationPermission>('granted'))

class NotificationStub {
  static permission: NotificationPermission = 'granted'
  static requestPermission = requestPermission

  constructor(title: string, options: NotificationOptions = {}) {
    raised.push({ title, options })
  }
}

let snoozeDue: ((event: InboxSnoozeDueEvent) => void) | null = null
const unsubscribe = vi.fn()

function item(id: string, title: string): InboxItemListItem {
  return { id, title } as InboxItemListItem
}

function mountWith(i18n: I18nInstance): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  renderHook(() => useInboxNotifications(), {
    wrapper: ({ children }) => (
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </I18nextProvider>
    )
  })
}

beforeAll(async () => {
  i18nEn = await createRendererI18n({ locale: 'en' })
  i18nDe = await createRendererI18n({ locale: 'de' })
  i18nDe.addResourceBundle('de', 'inbox', GERMAN_SNOOZE_DUE, true, true)
})

beforeEach(() => {
  raised.length = 0
  snoozeDue = null
  toastInfo.mockClear()
  requestPermission.mockClear()
  unsubscribe.mockClear()
  NotificationStub.permission = 'granted'
  ;(window as unknown as { Notification: unknown }).Notification = NotificationStub
  window.api.onInboxSnoozeDue = vi.fn((callback: (event: InboxSnoozeDueEvent) => void) => {
    snoozeDue = callback
    return unsubscribe
  }) as never
})

describe('useInboxNotifications', () => {
  it('names the single resurfaced item and pluralizes its body from the catalogue', () => {
    mountWith(i18nEn)
    snoozeDue?.({ items: [item('a', 'Quarterly review')] })

    expect(raised).toHaveLength(1)
    expect(raised[0].title).toBe('Quarterly review')
    expect(raised[0].options.body).toBe('Your snoozed item is ready for review')
    expect(toastInfo).toHaveBeenCalledWith('"Quarterly review" is back from snooze')
  })

  it('summarizes several resurfaced items through the ICU plural forms', () => {
    mountWith(i18nEn)
    snoozeDue?.({ items: [item('a', 'One'), item('b', 'Two'), item('c', 'Three')] })

    expect(raised).toHaveLength(1)
    expect(raised[0].title).toBe('3 snoozed items')
    expect(raised[0].options.body).toBe('Your snoozed items are ready')
    expect(toastInfo).toHaveBeenCalledWith('3 snoozed items are back')
  })

  it('renders the active locale, not English, when the catalogue has a translation', () => {
    mountWith(i18nDe)
    snoozeDue?.({ items: [item('a', 'Quartalsbericht')] })

    expect(raised[0].title).toBe('Quartalsbericht')
    expect(raised[0].options.body).toBe('Dein zurückgestellter Eintrag ist bereit')
    expect(toastInfo).toHaveBeenCalledWith('„Quartalsbericht“ ist zurück aus dem Schlummer')

    toastInfo.mockClear()
    raised.length = 0
    snoozeDue?.({ items: [item('a', 'Eins'), item('b', 'Zwei')] })

    expect(raised[0].title).toBe('2 zurückgestellte Einträge')
    expect(raised[0].options.body).toBe('Deine zurückgestellten Einträge sind bereit')
    expect(toastInfo).toHaveBeenCalledWith('2 zurückgestellte Einträge sind zurück')
  })

  it('still collapses duplicate banners by resurfaced-id tag', () => {
    mountWith(i18nEn)
    snoozeDue?.({ items: [item('b', 'Two'), item('a', 'One')] })

    expect(raised[0].options.tag).toBe('inbox-snooze-due:a,b')
  })

  it('resubscribes on a language change without re-asking for permission', async () => {
    NotificationStub.permission = 'default'
    const i18n = await createRendererI18n({ locale: 'en' })
    mountWith(i18n)

    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(window.api.onInboxSnoozeDue).toHaveBeenCalledTimes(1)

    await act(async () => {
      await i18n.changeLanguage('de')
    })

    // The listener re-registers so the copy follows the new language, but the
    // permission prompt lives in its own effect and does not fire again.
    expect(window.api.onInboxSnoozeDue).toHaveBeenCalledTimes(2)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(requestPermission).toHaveBeenCalledTimes(1)
  })
})
