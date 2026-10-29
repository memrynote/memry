import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

// The e2e build is a bare binary, not an app bundle, and macOS keeps no notification center for
// one. The plugin answered a post there with success and showed nothing (#3528); the post now
// fails, as it does when the user turned notifications off.
test('an unbundled macOS build rejects a notification it cannot show', async ({ page }) => {
  test.skip(process.platform !== 'darwin', 'the app bundle rule is macOS-only')
  expect(await invoke<boolean>(page, 'notification_supported')).toBe(false)
  expect(await invoke<string>(page, 'notification_permission')).toBe('denied')
  // Caught in the page: a rejection that reaches the driver makes it retry the script.
  const rejected = await page.evaluate(() =>
    window.__TAURI__.core
      .invoke('notification_show', {
        request: { key: 'e2e', title: 'e2e', body: 'e2e', silent: true, route: { kind: 'focus' } }
      })
      .then(
        () => null,
        (error: unknown) => JSON.stringify(error)
      )
  )
  expect(rejected).toContain('"code":"notification_show"')
  expect(rejected).toContain('app bundle')
})
