import { test, expect } from '../../harness/test'
import { invokeTest } from '../../harness/invoke-test'

interface TrayProbe {
  visibleBefore: boolean
  visibleAfterClose: boolean
  visibleAfterRestore: boolean
}

// A headless Linux session has no StatusNotifier host, so the tray is unavailable there and the
// window deliberately closes normally (`should_hide_on_close` and `tray_host` are covered by unit
// tests, the Ubuntu VM row by hand). `test.skip` has to run inside a test to take effect.
const skipOnLinux = (): void => test.skip(process.platform === 'linux', 'no tray host in CI')

// WebDriver cannot reach a hidden window, so the app runs the sequence and reports back.
test('closing the window with the tray on hides it, and a memry:// link brings it back', async ({
  app
}) => {
  skipOnLinux()
  const probe = await invokeTest<TrayProbe>(app, 'e2e_tray_probe', { restore: 'deep-link' })
  expect(probe).toEqual({
    visibleBefore: true,
    visibleAfterClose: false,
    visibleAfterRestore: true
  })
})

test('turning the tray off shows a window it had hidden', async ({ app }) => {
  skipOnLinux()
  const probe = await invokeTest<TrayProbe>(app, 'e2e_tray_probe', { restore: 'tray-off' })
  expect(probe).toEqual({
    visibleBefore: true,
    visibleAfterClose: false,
    visibleAfterRestore: true
  })
})
