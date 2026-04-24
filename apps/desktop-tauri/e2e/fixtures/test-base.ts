import { test as base, expect } from '@playwright/test'

/**
 * Shared base fixture: captures console errors per-test into an array the
 * test can assert against. Tests call `await page.goto('/')` themselves to
 * control when errors start being captured — the fixture only wires up the
 * listeners.
 */
type Fixtures = {
  consoleErrors: string[]
}

export const test = base.extend<Fixtures>({
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = []
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text())
      })
      page.on('pageerror', (err) => {
        errors.push(`pageerror: ${err.message}`)
      })
      await use(errors)
    },
    { auto: true }
  ]
})

export { expect }
