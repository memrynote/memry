import { test, expect } from '../../harness/test'
import { invokeTest } from '../../harness/invoke-test'
import type { Page } from '../../harness/pw-compat/page'

interface ShortcutState {
  configured: string | null
  fallback: boolean
  presses: number
}

interface CaptureResult {
  status: 'unbound' | 'registered' | 'in_use' | 'unsupported'
  fallbackRegistered: boolean
}

const rendererReady = (page: Page) =>
  expect
    .poll(() => page.evaluate(() => typeof window.api?.settings?.setGlobalCapture), {
      timeout: 30_000
    })
    .toBe('function')

// Parallel runs share one keyboard: a chord no other spec or app binds. F9 is in every
// keymap (the F19 grab was refused under the Linux CI Xvfb) and Windows reserves only F12.
const BINDING = { key: 'F9', modifiers: { ctrl: true, alt: true, shift: true } }
const ACCELERATOR = 'Control+Alt+Shift+F9'

// Wayland has no global hotkeys; the unit tests cover that path.
test.skip(process.env.XDG_SESSION_TYPE === 'wayland', 'global hotkeys do not work on Wayland')

test('a saved binding is registered, replaces the fallback, and survives a read', async ({
  app,
  page
}) => {
  await rendererReady(page)
  const saved = await page.evaluate(
    (binding) => window.api.settings.setGlobalCapture(binding),
    BINDING
  )
  expect(saved as CaptureResult).toEqual({ status: 'registered', fallbackRegistered: false })

  const state = await invokeTest<ShortcutState>(app, 'e2e_global_shortcut_state')
  expect(state.configured).toBe(ACCELERATOR)
  expect(state.fallback).toBe(false)

  const stored = await page.evaluate(
    async () => (await window.api.settings.getKeyboardSettings()).globalCapture
  )
  expect(stored).toMatchObject({ key: 'F9' })

  const cleared = await page.evaluate(() => window.api.settings.setGlobalCapture(null))
  expect((cleared as CaptureResult).status).toBe('unbound')
  expect((await invokeTest<ShortcutState>(app, 'e2e_global_shortcut_state')).configured).toBeNull()
})

test('a binding the OS cannot parse is refused and not saved', async ({ app, page }) => {
  await rendererReady(page)
  await page.evaluate((binding) => window.api.settings.setGlobalCapture(binding), BINDING)

  // The non-ASCII key macOS reports for an Option combination.
  const refused = await page.evaluate(() =>
    window.api.settings.setGlobalCapture({ key: 'å', modifiers: { alt: true } })
  )
  expect((refused as CaptureResult).status).toBe('unsupported')

  const stored = await page.evaluate(
    async () => (await window.api.settings.getKeyboardSettings()).globalCapture
  )
  expect(stored).toMatchObject({ key: 'F9' })
  expect((await invokeTest<ShortcutState>(app, 'e2e_global_shortcut_state')).configured).toBe(
    ACCELERATOR
  )
})

test('a press reaches the registered open handler', async ({ app }) => {
  const before = (await invokeTest<ShortcutState>(app, 'e2e_global_shortcut_state')).presses
  await invokeTest(app, 'e2e_fire_global_capture')
  const after = (await invokeTest<ShortcutState>(app, 'e2e_global_shortcut_state')).presses
  expect(after).toBe(before + 1)
})
