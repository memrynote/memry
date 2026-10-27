import { test, expect } from '../../harness/test'
import type { Page } from '../../harness/pw-compat/page'
import { waitForMainLog } from '../../harness/wait'

const rendererReady = (page: Page) =>
  expect
    .poll(() => page.evaluate(() => typeof window.api?.settings?.setGeneralSettings), {
      timeout: 30_000
    })
    .toBe('function')

// Registering the real login item is a VM-row and by-hand check: under the e2e gate the write is
// kept and the apply is reached, but the OS is not touched.
test('start on boot is saved and the login item is applied once per write', async ({
  app,
  page
}) => {
  await rendererReady(page)
  const written = await page.evaluate(() =>
    window.api.settings.setGeneralSettings({ startOnBoot: true })
  )
  expect(written).toMatchObject({ success: true })
  const read = await page.evaluate(
    async () => (await window.api.settings.getGeneralSettings()).startOnBoot
  )
  expect(read).toBe(true)

  const off = await page.evaluate(() =>
    window.api.settings.setGeneralSettings({ startOnBoot: false })
  )
  expect(off).toMatchObject({ success: true })
  expect(
    await page.evaluate(async () => (await window.api.settings.getGeneralSettings()).startOnBoot)
  ).toBe(false)
  // The gate keeps the OS out of it: a spec must not leave a login item for a test binary.
  expect(await waitForMainLog(app, 'not applied to the OS')).toBe(true)
})
