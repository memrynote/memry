// @ts-nocheck - E2E test; window.api typing lives in the renderer bundle
/**
 * The `/` menu renders Memry's own rows (`slash-menu.tsx`) on top of
 * BlockNote's suggestion plumbing. These pin the parts a unit test cannot: that
 * BlockNote actually mounts it, that ⌘/Ctrl+Enter reaches it before BlockNote's
 * own Enter handler, that the no-match fallback hands the query to `[[`, and
 * that a used row comes back under Recent.
 */

import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { ready } from './utils/desktop-test-helpers'
import { SELECTORS } from './utils/electron-helpers'
import { openNoteByHandle } from './utils/note-sync-helpers'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

async function openFreshNote(page: Page, title: string) {
  const note = await page.evaluate(async (noteTitle) => {
    const result = await window.api.notes.create({ title: noteTitle, content: '' })
    if (!result.success || !result.note) throw new Error(result.error || 'note create failed')
    return { id: result.note.id, title: result.note.title, emoji: result.note.emoji ?? null }
  }, title)
  await openNoteByHandle(page, note)
  const editor = page.locator(SELECTORS.noteEditor).first()
  await editor.waitFor({ state: 'visible', timeout: 15_000 })
  await editor.click()
}

async function firstBlock(page: Page) {
  return page.evaluate(() => {
    const block = (window as any).__memryEditor.document[0]
    return { type: block.type, props: block.props }
  })
}

const menu = (page: Page) => page.locator('.memry-slash-menu')

test.describe('Slash menu', () => {
  test.beforeEach(async ({ page }) => {
    await ready(page)
    await page.evaluate(() => localStorage.removeItem('memry:slash-menu-recent'))
  })

  test('lists the long tail at rest and shows the selected row in the action bar', async ({
    page
  }) => {
    await openFreshNote(page, `Slash Rest ${Date.now()}`)

    await page.keyboard.type('/')

    await expect(menu(page)).toBeVisible()
    await expect(menu(page).getByRole('option', { name: 'Heading 6' })).toBeAttached()
    await expect(menu(page).getByRole('option', { name: 'Toggle Heading 1' })).toBeAttached()
    await expect(menu(page).getByRole('option', { name: 'Video' })).toBeAttached()
    await expect(menu(page).getByText('Insert', { exact: true }).last()).toBeVisible()
  })

  test('Cmd/Ctrl+Enter on Heading 2 inserts a toggle heading', async ({ page }) => {
    await openFreshNote(page, `Slash Secondary ${Date.now()}`)

    await page.keyboard.type('/heading 2')
    await expect(menu(page).getByRole('option', { name: 'Heading 2' }).first()).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await expect(menu(page).getByText('As toggle')).toBeVisible()
    await page.keyboard.press(`${MOD}+Enter`)

    await expect(menu(page)).toBeHidden()
    await expect
      .poll(() => firstBlock(page))
      .toMatchObject({ type: 'heading', props: { level: 2, isToggleable: true } })
  })

  test('a used row comes back under Recent', async ({ page }) => {
    await openFreshNote(page, `Slash Recent ${Date.now()}`)

    await page.keyboard.type('/quote')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await firstBlock(page)).type).toBe('quote')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')

    await page.keyboard.type('/')
    await expect(menu(page).getByText('Recent', { exact: true })).toBeVisible()
    await expect(menu(page).getByRole('option').first()).toHaveAccessibleName('Quote')
  })

  test('no match hands the query to note search', async ({ page }) => {
    await openFreshNote(page, `Slash Fallback ${Date.now()}`)

    await page.keyboard.type('/zqxv')
    await expect(menu(page).getByText('No blocks match “zqxv”')).toBeVisible()
    await page.keyboard.press('Enter')

    await expect(menu(page)).toBeHidden()
    await expect(page.locator('.wiki-link-menu')).toBeVisible()
    await expect(page.locator(SELECTORS.noteEditor).first()).toContainText('[[zqxv')
  })
})
