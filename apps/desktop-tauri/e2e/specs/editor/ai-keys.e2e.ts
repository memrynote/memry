// Inline AI keys end to end (Step 22, #3539): a key typed in Settings goes to the keychain under
// the selected provider and reaches the renderer only masked, and a plaintext key an Electron
// row still carries moves into the keychain at the first read. `e2e_ai_inline_key_state` reads
// the keychain itself, not the store's cache, and answers in booleans, so the key never comes
// back out; a restart shows the key outlives the process.
import { randomUUID } from 'node:crypto'

import { invokeTest } from '../../harness/invoke-test'
import { vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { restart, type TauriApp } from '../../harness/tauri-lifecycle'
import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

const MASKED_KEY = '\u2022'.repeat(8)
// Not an `sk-` literal: the repo secret scanner flags one even in tests.
const newKey = () => `e2e-ai-key-${randomUUID()}`

/** `ai_inline_get_settings` shows the key masked; the key itself is never compared here. */
const shownMasked = async (page: Page): Promise<boolean> =>
  (await invoke<{ apiKey: string }>(page, 'ai_inline_get_settings')).apiKey === MASKED_KEY

/** Where the key is; booleans only, so the key never comes back from the app. */
const keyState = (app: TauriApp, key: string) =>
  invokeTest<{ keychainMatches: boolean; rowKeyEmpty: boolean }>(app, 'e2e_ai_inline_key_state', {
    expected: key
  })

test('a key typed in Settings is stored in the keychain and shown masked', async ({
  app,
  page
}) => {
  const key = newKey()
  await vaultOpen(page)
  await invokeTest(app, 'e2e_ai_inline_seed_row', {
    patch: { enabled: true, provider: 'openai', model: 'gpt-4o-mini', apiKey: '' }
  })

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'AI & Agents', exact: true }).click()
  const field = page.getByPlaceholder('Enter OpenAI API key')
  await field.fill(key)
  await field.blur()

  await expect.poll(() => shownMasked(page), { timeout: 15_000 }).toBe(true)
  expect(await keyState(app, key)).toEqual({
    keychainMatches: true,
    rowKeyEmpty: true
  })

  await restart(app)
  await vaultOpen(page)
  expect(await keyState(app, key)).toEqual({
    keychainMatches: true,
    rowKeyEmpty: true
  })
  expect(await shownMasked(page)).toBe(true)
})

test('a plaintext key left in the settings row moves into the keychain', async ({ app, page }) => {
  const key = newKey()
  await vaultOpen(page)
  await invokeTest(app, 'e2e_ai_inline_seed_row', {
    patch: { enabled: true, provider: 'anthropic', model: 'claude-e2e', apiKey: key }
  })
  expect(await keyState(app, key)).toEqual({
    keychainMatches: false,
    rowKeyEmpty: false
  })

  expect(await shownMasked(page)).toBe(true)
  expect(await keyState(app, key)).toEqual({
    keychainMatches: true,
    rowKeyEmpty: true
  })

  await restart(app)
  await vaultOpen(page)
  expect(await keyState(app, key)).toEqual({
    keychainMatches: true,
    rowKeyEmpty: true
  })
  expect(await shownMasked(page)).toBe(true)
})
