import { test, expect } from '../../harness/test'
import { invokeTest } from '../../harness/invoke-test'
import { readMainLog, waitForMainLog } from '../../harness/wait'

// On macOS this posts the real NSWorkspace notifications, so the observers are under test; on
// Windows and Linux it publishes on the monitor, and the VM rows cover the OS side (suspend and
// resume log lines, logoff).
test('sleep, wake and power-off reach the power monitor and the log', async ({ app }) => {
  await invokeTest(app, 'e2e_post_power_event', { kind: 'sleep' })
  expect(await waitForMainLog(app, 'system suspend')).toBe(true)

  await invokeTest(app, 'e2e_post_power_event', { kind: 'wake' })
  expect(await waitForMainLog(app, 'system resume')).toBe(true)

  await invokeTest(app, 'e2e_post_power_event', { kind: 'poweroff' })
  expect(await waitForMainLog(app, 'session ending')).toBe(true)
})

test('an unknown event kind is refused', async ({ app }) => {
  let refused = false
  await invokeTest(app, 'e2e_post_power_event', { kind: 'explode' }).catch(() => {
    refused = true
  })
  expect(refused).toBe(true)
})

// Windows sends WM_ENDSESSION to every top-level window of the process, and tao's hidden event
// target answers it with process::exit(0). Either window may be asked first, and neither may let
// the process end before the quit sequence has run.
for (const target of ['event-target', 'main']) {
  test(`a sign-out announced to the ${target} window runs the quit sequence to its end`, async ({
    app
  }) => {
    test.skip(process.platform !== 'win32', 'WM_ENDSESSION is Windows-only')

    await invokeTest(app, 'e2e_send_session_end', { target })

    expect(await waitForMainLog(app, 'starting graceful shutdown', 5_000)).toBe(true)
    expect(await waitForMainLog(app, 'cleanup complete', 5_000)).toBe(true)
    expect(readMainLog(app.dirs.logDir)).not.toContain('the session ended before the quit sequence')
  })
}
