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

const { toastInfo, notificationShow, notificationPermission } = vi.hoisted(() => ({
  toastInfo: vi.fn(),
  notificationShow: vi.fn(),
  notificationPermission: vi.fn()
}))

vi.mock('../../../generated/bindings', () => ({
  commands: { notificationShow, notificationPermission }
}))

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
  snoozeDue = null
  toastInfo.mockClear()
  notificationShow.mockReset()
  notificationShow.mockResolvedValue(null)
  notificationPermission.mockReset()
  notificationPermission.mockResolvedValue('granted')
  unsubscribe.mockClear()
  window.api.onInboxSnoozeDue = vi.fn((callback: (event: InboxSnoozeDueEvent) => void) => {
    snoozeDue = callback
    return unsubscribe
  }) as never
})

/** The banner request the hook sent, once the permission answer has come back. */
async function shown(): Promise<{ key: string; title: string; body: string; route: unknown }> {
  await vi.waitFor(() => expect(notificationShow).toHaveBeenCalled())
  const [request] = notificationShow.mock.lastCall ?? []
  return request
}

describe('useInboxNotifications', () => {
  it('names the single resurfaced item and pluralizes its body from the catalogue', async () => {
    mountWith(i18nEn)
    snoozeDue?.({ items: [item('a', 'Quarterly review')] })

    const request = await shown()
    expect(notificationShow).toHaveBeenCalledTimes(1)
    expect(request.title).toBe('Quarterly review')
    expect(request.body).toBe('Your snoozed item is ready for review')
    expect(request.route).toEqual({ kind: 'focus' })
    expect(toastInfo).toHaveBeenCalledWith('"Quarterly review" is back from snooze')
  })

  it('summarizes several resurfaced items through the ICU plural forms', async () => {
    mountWith(i18nEn)
    snoozeDue?.({ items: [item('a', 'One'), item('b', 'Two'), item('c', 'Three')] })

    const request = await shown()
    expect(request.title).toBe('3 snoozed items')
    expect(request.body).toBe('Your snoozed items are ready')
    expect(toastInfo).toHaveBeenCalledWith('3 snoozed items are back')
  })

  it('renders the active locale, not English, when the catalogue has a translation', async () => {
    mountWith(i18nDe)
    snoozeDue?.({ items: [item('a', 'Quartalsbericht')] })

    let request = await shown()
    expect(request.title).toBe('Quartalsbericht')
    expect(request.body).toBe('Dein zurückgestellter Eintrag ist bereit')
    expect(toastInfo).toHaveBeenCalledWith('„Quartalsbericht“ ist zurück aus dem Schlummer')

    toastInfo.mockClear()
    notificationShow.mockClear()
    snoozeDue?.({ items: [item('a', 'Eins'), item('b', 'Zwei')] })

    request = await shown()
    expect(request.title).toBe('2 zurückgestellte Einträge')
    expect(request.body).toBe('Deine zurückgestellten Einträge sind bereit')
    expect(toastInfo).toHaveBeenCalledWith('2 zurückgestellte Einträge sind zurück')
  })

  it('still collapses duplicate banners by resurfaced-id key', async () => {
    mountWith(i18nEn)
    snoozeDue?.({ items: [item('b', 'Two'), item('a', 'One')] })

    expect((await shown()).key).toBe('inbox-snooze-due:a,b')
  })

  it('raises no banner when the platform denies notifications, but still toasts', async () => {
    notificationPermission.mockResolvedValue('denied')
    mountWith(i18nEn)
    snoozeDue?.({ items: [item('a', 'Quarterly review')] })

    await vi.waitFor(() => expect(notificationPermission).toHaveBeenCalled())
    await Promise.resolve()
    expect(notificationShow).not.toHaveBeenCalled()
    expect(toastInfo).toHaveBeenCalledTimes(1)
  })

  it('shows the banner while macOS has not asked yet, since the show asks', async () => {
    notificationPermission.mockResolvedValue('prompt')
    mountWith(i18nEn)
    snoozeDue?.({ items: [item('a', 'Quarterly review')] })

    expect((await shown()).title).toBe('Quarterly review')
  })

  it('resubscribes on a language change', async () => {
    const i18n = await createRendererI18n({ locale: 'en' })
    mountWith(i18n)

    expect(window.api.onInboxSnoozeDue).toHaveBeenCalledTimes(1)

    await act(async () => {
      await i18n.changeLanguage('de')
    })

    // The listener re-registers so the copy follows the new language.
    expect(window.api.onInboxSnoozeDue).toHaveBeenCalledTimes(2)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
