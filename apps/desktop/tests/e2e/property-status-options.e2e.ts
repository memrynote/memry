/**
 * Status property option persistence.
 *
 * A status option the user types into the picker has to reach
 * `.memry/properties.md` and come back exactly once. Two regressions this
 * guards. A status definition created with `categories: undefined` made js-yaml
 * refuse the dump, so the write threw while the main-process cache kept the
 * broken definition and every later "add status option" silently did nothing.
 * And the append had no dedupe on `option.value`, so adding the same name twice
 * left two entries in the category.
 */

import * as fs from 'fs'
import * as path from 'path'

import type { Locator, Page } from '@playwright/test'

import { test, expect } from './fixtures'
import { seedNote, waitForAppReady, waitForVaultReady } from './utils/electron-helpers'
import { openNoteByHandle } from './utils/note-sync-helpers'
import { waitForStable } from './utils/wait-helpers'

const NEW_OPTION = 'Blocked'

/** Label of the status category the new option is typed into. */
const CATEGORY = 'In progress'

/** Ships in every status definition, so it identifies the status picker's popover. */
const DEFAULT_OPTION = 'Not started'

function statusPicker(page: Page): Locator {
  return page
    .locator('[data-slot="picker-content"]')
    .filter({ has: page.getByRole('option', { name: DEFAULT_OPTION, exact: true }) })
    .first()
}

function optionsNamed(picker: Locator, value: string): Locator {
  return picker.getByRole('option', { name: value, exact: true })
}

async function addStatusPropertyThroughUi(page: Page): Promise<Locator> {
  await page.locator('.group\\/metadata').first().hover()

  const addPropertyButton = page.getByRole('button', { name: 'Add property' }).first()
  await expect(addPropertyButton).toBeVisible()
  await addPropertyButton.click()

  await page.getByRole('option', { name: 'Status', exact: true }).first().click()

  const picker = statusPicker(page)
  await expect(picker).toBeVisible()
  return picker
}

async function reopenStatusPicker(page: Page): Promise<Locator> {
  const propertyList = page.getByRole('list', { name: 'Properties list' }).first()
  await expect(propertyList).toBeVisible()
  await propertyList.locator('[aria-haspopup]').first().click()

  const picker = statusPicker(page)
  await expect(picker).toBeVisible()
  return picker
}

async function typeNewOption(picker: Locator, value: string): Promise<void> {
  const category = picker.locator('[data-slot="picker-section"]').filter({ hasText: CATEGORY })
  await category.getByRole('button', { name: 'Add', exact: true }).click()

  const input = picker.getByRole('textbox', { name: 'Option name' })
  await expect(input).toBeVisible()
  await input.fill(value)
  await input.press('Enter')
}

function readDefinitionsFile(vaultPath: string): string {
  const file = path.join(vaultPath, '.memry', 'properties.md')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

function countOccurrences(text: string, value: string): number {
  return text.split(value).length - 1
}

test.describe('Status property options', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
  })

  test('a status option added in the picker survives a reload exactly once', async ({
    page,
    testVaultPath
  }) => {
    const title = `Status Options ${Date.now()}`
    const id = await seedNote(page, title)
    await openNoteByHandle(page, { id, title })

    const picker = await addStatusPropertyThroughUi(page)
    await typeNewOption(picker, NEW_OPTION)
    await expect(optionsNamed(picker, NEW_OPTION)).toHaveCount(1)

    await page.reload()
    await waitForAppReady(page)
    await waitForVaultReady(page)
    await openNoteByHandle(page, { id, title })

    const reopened = await reopenStatusPicker(page)
    await expect(optionsNamed(reopened, NEW_OPTION)).toHaveCount(1)
    expect(countOccurrences(readDefinitionsFile(testVaultPath), NEW_OPTION)).toBe(1)
  })

  test('adding the same status option twice leaves one entry', async ({ page, testVaultPath }) => {
    const title = `Status Options Idempotent ${Date.now()}`
    const id = await seedNote(page, title)
    await openNoteByHandle(page, { id, title })

    const picker = await addStatusPropertyThroughUi(page)
    await typeNewOption(picker, NEW_OPTION)
    await expect(optionsNamed(picker, NEW_OPTION)).toHaveCount(1)

    await typeNewOption(picker, NEW_OPTION)

    // A duplicating append rewrites the file, so settling on unchanged bytes is
    // what separates "the second add was dropped" from "it has not landed yet".
    const settled = await waitForStable(async () => readDefinitionsFile(testVaultPath), {
      stableFor: 2_000,
      timeout: 20_000
    })
    expect(countOccurrences(settled, NEW_OPTION)).toBe(1)
    await expect(optionsNamed(picker, NEW_OPTION)).toHaveCount(1)
  })
})
