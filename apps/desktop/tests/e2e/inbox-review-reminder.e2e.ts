import type { ElectronApplication } from '@playwright/test'
import { test, expect } from './fixtures'
import { ready } from './utils/desktop-test-helpers'

interface InboxReviewTestHooks {
  seedInboxItemForE2E(input: { title: string }): Promise<string>
  setInboxReviewSettingsForE2E(input: { enabled: boolean; time: string }): Promise<void>
  forceInboxReviewTickForE2E(input: {
    nowIso: string
  }): Promise<{ notified: boolean; count: number }>
}

async function invokeHook<K extends keyof InboxReviewTestHooks>(
  electronApp: ElectronApplication,
  name: K,
  arg: Parameters<InboxReviewTestHooks[K]>[0]
): Promise<Awaited<ReturnType<InboxReviewTestHooks[K]>>> {
  return electronApp.evaluate(
    async (_context, { name, arg }) => {
      const hooks = (
        globalThis as typeof globalThis & {
          __memryTestHooks?: InboxReviewTestHooks
        }
      ).__memryTestHooks

      if (!hooks) {
        throw new Error('Memry test hooks are not registered')
      }

      return hooks[name](arg as never)
    },
    { name, arg }
  )
}

test.describe('inbox scheduled review', () => {
  test('fires once when inbox has items at the target time', async ({ electronApp, page }) => {
    await ready(page)

    // 1) Enable the reminder for 18:00 and seed one inbox item.
    await invokeHook(electronApp, 'setInboxReviewSettingsForE2E', { enabled: true, time: '18:00' })
    await invokeHook(electronApp, 'seedInboxItemForE2E', { title: 'Read later' })

    // 2) Before target → silent.
    const before = await invokeHook(electronApp, 'forceInboxReviewTickForE2E', {
      nowIso: '2026-07-17T17:00:00'
    })
    expect(before.notified).toBe(false)

    // 3) At target → fires once, count 1.
    const atTarget = await invokeHook(electronApp, 'forceInboxReviewTickForE2E', {
      nowIso: '2026-07-17T18:00:00'
    })
    expect(atTarget).toMatchObject({ notified: true, count: 1 })

    // 4) In-app toast appears (OS-notification proxy). packages/i18n/src/locales/en/inbox.json
    // reviewNudge.title renders "Time to review 1 item" — match on the stable prefix.
    await expect(page.getByText(/time to review/i)).toBeVisible()

    // 5) Second tick same day → no re-fire (once/day).
    const again = await invokeHook(electronApp, 'forceInboxReviewTickForE2E', {
      nowIso: '2026-07-17T18:30:00'
    })
    expect(again.notified).toBe(false)
  })

  test('stays silent when the inbox is empty', async ({ electronApp, page }) => {
    await ready(page)

    await invokeHook(electronApp, 'setInboxReviewSettingsForE2E', { enabled: true, time: '18:00' })
    const result = await invokeHook(electronApp, 'forceInboxReviewTickForE2E', {
      nowIso: '2026-07-17T18:00:00'
    })
    expect(result.notified).toBe(false)
  })
})
