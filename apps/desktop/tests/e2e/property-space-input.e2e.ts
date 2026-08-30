/**
 * Property inputs must accept the space character.
 *
 * Reported as "Properties do not allow spaces anymore": typing `movie series`
 * into a property field drops the space and leaves `movieseries`.
 *
 * These drive real key events (`keyboard.type`), never `fill()` — `fill()` sets
 * the value directly and would pass even while every keystroke is being
 * swallowed.
 */

import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { waitForAppReady, waitForVaultReady, seedNote } from './utils/electron-helpers'
import { openNoteByHandle } from './utils/note-sync-helpers'

const TWO_WORDS = 'movie series'

async function openSeededNote(page: Page, title: string): Promise<string> {
  const id = await seedNote(page, title)
  await openNoteByHandle(page, { id, title })
  return id
}

async function openAddPropertyPopup(page: Page): Promise<void> {
  await page.locator('.group\\/metadata').first().hover()
  const addPropertyButton = page.getByRole('button', { name: 'Add property' }).first()
  await expect(addPropertyButton).toBeVisible()
  await addPropertyButton.click()
}

async function addProperty(page: Page, type: 'Text' | 'Select'): Promise<void> {
  await openAddPropertyPopup(page)
  const typeOption = page.getByRole('option', { name: type, exact: true }).first()
  await expect(typeOption).toBeVisible()
  await typeOption.click()
}

test.describe('Property fields accept spaces', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
  })

  test('the add-property name field keeps the space in "movie series"', async ({ page }) => {
    await openSeededNote(page, `Prop space name ${Date.now()}`)
    await openAddPropertyPopup(page)

    const nameInput = page.getByRole('textbox', { name: 'Property name' })
    await expect(nameInput).toBeVisible()
    await nameInput.click()
    await page.keyboard.type(TWO_WORDS, { delay: 25 })

    await expect(nameInput).toHaveValue(TWO_WORDS)
  })

  test('a text property value keeps the space in "movie series"', async ({ page }) => {
    await openSeededNote(page, `Prop space value ${Date.now()}`)
    await addProperty(page, 'Text')

    const valueInput = page.getByRole('textbox', { name: 'Empty' }).first()
    await expect(valueInput).toBeFocused()
    await page.keyboard.type(TWO_WORDS, { delay: 25 })

    await expect(valueInput).toHaveValue(TWO_WORDS)
  })

  // The picker lives in a Radix portal, so its keydowns leave the row in the DOM
  // but still climb the React tree through the row's value wrapper.
  test('a new select option name keeps the space in "movie series"', async ({ page }) => {
    await openSeededNote(page, `Prop space option ${Date.now()}`)
    await addProperty(page, 'Select')

    const newOption = page.getByRole('button', { name: 'New option' })
    await expect(newOption).toBeVisible()
    await newOption.click()

    const optionInput = page.getByRole('textbox', { name: 'Option name' })
    await expect(optionInput).toBeFocused()
    await page.keyboard.type(TWO_WORDS, { delay: 25 })

    await expect(optionInput).toHaveValue(TWO_WORDS)
  })

  test('renaming a property keeps the space in "movie series"', async ({ page }) => {
    await openSeededNote(page, `Prop space rename ${Date.now()}`)
    await addProperty(page, 'Text')

    const propertyList = page.getByRole('list', { name: 'Properties list' }).first()
    const nameLabel = propertyList.getByRole('button', { name: 'Text', exact: true }).first()
    await expect(nameLabel).toBeVisible()
    await nameLabel.click()

    const renameInput = page.getByRole('textbox', { name: 'Edit property name' })
    await expect(renameInput).toBeFocused()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type(TWO_WORDS, { delay: 25 })

    await expect(renameInput).toHaveValue(TWO_WORDS)
  })
})
