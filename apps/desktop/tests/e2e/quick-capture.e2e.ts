import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { MOD, ready, uniqueLabel } from './utils/desktop-test-helpers'

interface QuickCaptureTestHooks {
  triggerQuickCaptureShortcutForE2E?: () => Promise<number>
  getQuickCaptureShortcutRegistrationForE2E?: () => {
    shortcut: string
    configuredRegistered: boolean
    fallbackAttempted: boolean
    fallbackRegistered: boolean
    registered: boolean
  }
}

async function openQuickCapture(electronApp: ElectronApplication): Promise<Page> {
  const windowPromise = electronApp.waitForEvent('window')
  await electronApp.evaluate(async () => {
    const hooks = (
      globalThis as typeof globalThis & {
        __memryTestHooks?: QuickCaptureTestHooks
      }
    ).__memryTestHooks
    if (!hooks?.triggerQuickCaptureShortcutForE2E) {
      throw new Error('Quick Capture E2E hook is not registered')
    }
    await hooks.triggerQuickCaptureShortcutForE2E()
  })

  const quickCapture = await windowPromise
  await quickCapture.waitForLoadState('domcontentloaded')
  await expect(quickCapture.getByPlaceholder('Capture anything...')).toBeVisible()
  return quickCapture
}

test.describe('Quick Capture E2E', () => {
  test('opens the global-shortcut window and submits text to Inbox', async ({
    electronApp,
    page
  }) => {
    await ready(page)

    await expect
      .poll(() =>
        electronApp.evaluate(() => {
          const hooks = (
            globalThis as typeof globalThis & {
              __memryTestHooks?: QuickCaptureTestHooks
            }
          ).__memryTestHooks
          return hooks?.getQuickCaptureShortcutRegistrationForE2E?.() ?? null
        })
      )
      .toMatchObject({
        shortcut: 'CommandOrControl+Shift+Space',
        fallbackAttempted: true
      })

    const quickCapture = await openQuickCapture(electronApp)
    const content = uniqueLabel('Quick Capture Inbox')
    await quickCapture.getByPlaceholder('Capture anything...').fill(content)
    await quickCapture.keyboard.press(`${MOD}+Enter`)

    await expect
      .poll(
        () =>
          page.evaluate(async (expectedContent) => {
            const result = await window.api.inbox.list({ limit: 20 })
            return result.items.some(
              (item) =>
                item.title.includes(expectedContent) || item.content?.includes(expectedContent)
            )
          }, content),
        { timeout: 20_000 }
      )
      .toBe(true)
  })
})
