// Port of apps/desktop/tests/e2e/update-notice-focus.e2e.ts. A downloaded update is the loudest
// thing the quiet update flow does: the settings gear gets a badge and nothing else moves, so
// text being typed keeps its focus and its characters. The Electron spec types into a new
// template; templates are not ported yet, so this one types into the settings search field.
import { test, expect } from '../../harness/test'
import { invokeTest } from '../../harness/invoke-test'
import { invoke } from '../../harness/vault-commands'

test.use({ extraEnv: { MEMRY_TEST_UPDATER: 'scripted' } })

test('a surfaced release does not steal focus from, or discard, text being typed', async ({
  app,
  page
}) => {
  await invoke(page, 'updater_set_auto_download', { enabled: true })
  // The startup check runs as the window shows; scripting before it ended would hand it the step.
  await expect
    .poll(async () => {
      const state = await invoke<{ lastCheckedAt: number | null; status: string }>(
        page,
        'updater_get_state'
      )
      return state.lastCheckedAt !== null && state.status !== 'checking'
    })
    .toBe(true)
  await invokeTest(app, 'e2e_updater_script', {
    steps: [
      {
        kind: 'available',
        version: '2026.1101.1',
        notesHtml: '<h2>Fixes</h2><p>Release v2026-11-01</p>'
      }
    ]
  })

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const search = page.getByPlaceholder('Search settings')
  await search.click()
  await page.keyboard.type('Wins and blockers')

  // Surface the release straight after typing; auto download takes it to `downloaded`.
  await invoke(page, 'updater_check_for_updates')

  await expect(page.getByRole('button', { name: /Update ready/ })).toBeVisible({ timeout: 20_000 })
  await expect(search).toBeFocused()
  await expect(search).toHaveValue('Wins and blockers')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
