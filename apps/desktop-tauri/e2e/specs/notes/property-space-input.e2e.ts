// Property inputs accept the space character (#3530 13k-3), ported from Electron's
// `property-space-input.e2e.ts`: typing `movie series` into a property field once dropped the
// space and left `movieseries`. These type real key events, never a direct value set, which
// would pass while every keystroke is swallowed. A typed value also reaches the note's file.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { openNoteByHandle } from '../../harness/note-sync-helpers'
import { openDetailsMenu } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { invoke, vaultStatus } from '../../harness/vault-commands'
import { pollUntil } from '../../harness/wait'

const TWO_WORDS = 'movie series'

interface CreatedNote {
  id: string
  title: string
  path: string
}

async function openNewNote(page: Page, title: string): Promise<CreatedNote> {
  expect(await pollUntil(async () => (await vaultStatus(page)).isOpen, { timeoutMs: 30_000 })).toBe(
    true
  )
  const note = await invoke<CreatedNote>(page, 'notes_create', { input: { title } })
  await openNoteByHandle(page, { id: note.id, title: note.title })
  return note
}

async function openAddPropertyPopup(page: Page): Promise<void> {
  await openDetailsMenu(page)
  await page.getByRole('menuitem', { name: 'Add property' }).click()
}

async function addProperty(page: Page, type: 'Text' | 'Select'): Promise<void> {
  await openAddPropertyPopup(page)
  const typeOption = page.getByRole('option', { name: type, exact: true }).first()
  await expect(typeOption).toBeVisible()
  await typeOption.click()
}

test('the add-property name field keeps the space in "movie series"', async ({ page }) => {
  await openNewNote(page, `Prop space name ${Date.now()}`)
  await openAddPropertyPopup(page)

  const nameInput = page.getByRole('textbox', { name: 'Property name' })
  await expect(nameInput).toBeVisible()
  await nameInput.click()
  await page.keyboard.type(TWO_WORDS)

  await expect(nameInput).toHaveValue(TWO_WORDS)
})

test('a text property value keeps the space in "movie series" and reaches the file', async ({
  page,
  testVaultPath
}) => {
  const note = await openNewNote(page, `Prop space value ${Date.now()}`)
  await addProperty(page, 'Text')

  const valueInput = page.getByRole('textbox', { name: 'Empty' }).first()
  await expect(valueInput).toBeFocused()
  await page.keyboard.type(TWO_WORDS)
  await expect(valueInput).toHaveValue(TWO_WORDS)

  await page.keyboard.press('Enter')
  const file = join(testVaultPath, note.path)
  const written = await pollUntil(() => readFileSync(file, 'utf8').includes(`: ${TWO_WORDS}\n`), {
    timeoutMs: 15_000
  })
  expect(written).toBe(true)
})

// The picker lives in a portal, so its keydowns leave the row in the DOM but still climb the
// React tree through the row's value wrapper.
test('a new select option name keeps the space in "movie series"', async ({ page }) => {
  await openNewNote(page, `Prop space option ${Date.now()}`)
  await addProperty(page, 'Select')

  const newOption = page.getByRole('button', { name: 'New option' })
  await expect(newOption).toBeVisible()
  await newOption.click()

  const optionInput = page.getByRole('textbox', { name: 'Option name' })
  await expect(optionInput).toBeFocused()
  await page.keyboard.type(TWO_WORDS)

  await expect(optionInput).toHaveValue(TWO_WORDS)
})

test('renaming a property keeps the space in "movie series"', async ({ page }) => {
  await openNewNote(page, `Prop space rename ${Date.now()}`)
  await addProperty(page, 'Text')

  const propertyList = page.getByRole('list', { name: 'Properties list' }).first()
  const nameLabel = propertyList.getByRole('button', { name: 'Text', exact: true }).first()
  await expect(nameLabel).toBeVisible()
  await nameLabel.click()

  const renameInput = page.getByRole('textbox', { name: 'Edit property name' })
  await expect(renameInput).toBeFocused()
  // WKWebView takes no select-all chord from WebDriver; the typing below is what is tested.
  await renameInput.clear()
  await page.keyboard.type(TWO_WORDS)

  await expect(renameInput).toHaveValue(TWO_WORDS)
})
