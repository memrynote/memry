// A startup that fails before the main window exists used to leave a process with no window
// that held the single-instance lock, so every relaunch did nothing. The startup-error window
// replaces that (inv09#28, port of apps/desktop/tests/e2e/startup-recovery.e2e.ts).
import { test, expect } from '../../harness/test'
import { invokeTest } from '../../harness/invoke-test'
import { readMainLog } from '../../harness/wait'

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

// The quit steps the started stages registered still run (here: the shutdown service exists, the
// vault stage never ran), and the exit code tells a launcher the start failed. A second launch
// raising this window is not covered here: the e2e gate registers no single-instance plugin.
test('closing the startup-error window quits through the quit steps with code 2', async ({
  app,
  page
}) => {
  await expect(page.locator('body')).toContainText("couldn't finish starting")

  // The reply may not arrive: the page goes with its window.
  await invokeTest(app, 'e2e_close_window', { label: 'startup-error' }).catch(() => undefined)

  const code = await Promise.race([
    app.exited,
    new Promise<'alive'>((resolve) => setTimeout(() => resolve('alive'), 15_000))
  ])
  expect(code).toBe(2)
  const log = readMainLog(app.dirs.logDir)
  expect(log).toContain('starting graceful shutdown')
  expect(log).toContain('no vault session to close')
  expect(log).toContain('cleanup complete')
})
