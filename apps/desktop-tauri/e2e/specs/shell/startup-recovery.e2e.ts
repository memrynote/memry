// A startup that fails before the main window exists used to leave a process with no window
// that held the single-instance lock, so every relaunch did nothing. The startup-error window
// replaces that (inv09#28, port of apps/desktop/tests/e2e/startup-recovery.e2e.ts).
import { test, expect } from '../../harness/test'
import { invokeTest } from '../../harness/invoke-test'

interface E2eWindow {
  label: string
  visible: boolean
}

test.use({ extraEnv: { MEMRY_TEST_FORCE_STARTUP_THROW: '1' }, startupFails: true })

test('a startup that fails before the main window shows the startup-error window', async ({
  app,
  page
}) => {
  await expect(page.locator('body')).toContainText("couldn't finish starting")
  await expect(page.locator('body')).toContainText('forced startup failure')

  const windows = await invokeTest<E2eWindow[]>(app, 'e2e_windows')
  expect(windows.map(({ label, visible }) => ({ label, visible }))).toEqual([
    { label: 'startup-error', visible: true }
  ])
})
