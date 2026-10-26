// Settings through the real commands: a write lands in core, the synced field gets a per-path
// clock, and theme and language are applied from the startup state before first paint after a
// restart.
import { test, expect } from '../../harness/test'
import { invokeTest } from '../../harness/invoke-test'
import { restart } from '../../harness/tauri-lifecycle'
import type { Page } from '../../harness/pw-compat/page'
import { invoke } from '../../harness/vault-commands'

type Written = { success: boolean; error?: string }

/** The renderer installs `window.api` while its bundle loads; a script that runs first would fail. */
const rendererReady = (page: Page) =>
  expect
    .poll(() => page.evaluate(() => typeof window.api?.settings), { timeout: 30_000 })
    .toBe('object')

test('settings groups persist and a synced field gets a per-path clock', async ({ app, page }) => {
  await rendererReady(page)
  const writes = await page.evaluate(async () => {
    const api = window.api
    return Promise.all([
      api.settings.setGeneralSettings({ theme: 'dark', clockFormat: '24h' }),
      api.settings.setEditorSettings({ width: 'full' }),
      api.settings.setTabSettings({ restoreSessionOnStart: true, tabCloseButton: 'always' }),
      api.settings.setJournalSettings({ showSchedule: false })
    ])
  })
  expect((writes as Written[]).find((write) => !write.success)).toBeUndefined()

  const read = await page.evaluate(async () => ({
    general: await window.api.settings.getGeneralSettings(),
    editor: await window.api.settings.getEditorSettings(),
    tabs: await window.api.settings.getTabSettings(),
    journal: await window.api.settings.getJournalSettings()
  }))
  expect(read.general).toMatchObject({ theme: 'dark', clockFormat: '24h' })
  expect(read.editor).toMatchObject({ width: 'full' })
  expect(read.tabs).toMatchObject({ restoreSessionOnStart: true, tabCloseButton: 'always' })
  expect(read.journal).toMatchObject({ showSchedule: false })

  // `general.theme` syncs and `tabs.*` is device-local, so only the first has a clock row.
  const clocks = await invokeTest<{ path: string }[]>(app, 'e2e_debug_query', {
    sql: 'SELECT path FROM settings_field_clocks'
  })
  const paths = clocks.map((row) => row.path)
  expect(paths).toContain('general.theme')
  expect(paths.some((path) => path.startsWith('tabs.'))).toBe(false)
})

test('a rejected value leaves the group as it was', async ({ page }) => {
  await rendererReady(page)
  const result = await page.evaluate(() =>
    window.api.settings.setGeneralSettings({ zoomFactor: 99 })
  )
  expect((result as Written).success).toBe(false)
  const general = await page.evaluate(() => window.api.settings.getGeneralSettings())
  expect((general as { zoomFactor?: number }).zoomFactor ?? 1).toBeLessThanOrEqual(2)
})

test('theme and language are applied from the startup state after a restart', async ({
  app,
  page
}) => {
  await rendererReady(page)
  await invoke(page, 'settings_set_group', { group: 'general', patch: { theme: 'dark' } })
  await invoke(page, 'locale_set', { locale: 'ar' })

  await restart(app)

  const readDocument = () =>
    page.evaluate(() => ({
      startup: window.__MEMRY_STARTUP__,
      dark: document.documentElement.classList.contains('dark'),
      dir: document.documentElement.dir,
      lang: document.documentElement.lang
    }))
  await expect.poll(readDocument, { timeout: 30_000 }).toMatchObject({
    startup: { theme: 'dark', locale: 'ar', direction: 'rtl' },
    dark: true,
    dir: 'rtl',
    lang: 'ar'
  })
})
