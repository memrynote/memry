import { test, expect } from '../../harness/test'
import { invokeTest } from '../../harness/invoke-test'
import { waitForMainLog } from '../../harness/wait'

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
