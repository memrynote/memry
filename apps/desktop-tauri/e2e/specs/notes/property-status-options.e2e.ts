// Status property options (#3530 13k-3), ported from Electron's `property-status-options.e2e.ts`:
// a status option typed into the picker reaches `.memry/properties.md` and comes back exactly
// once, after a reload and when it is added twice. The status property itself is a value the
// note's file holds.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { openNoteByHandle } from '../../harness/note-sync-helpers'
import { openDetailsMenu } from '../../harness/notes'
import type { Locator } from '../../harness/pw-compat/locator'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { invoke, vaultStatus } from '../../harness/vault-commands'
import { pollUntil, sleep } from '../../harness/wait'

const NEW_OPTION = 'Blocked'
/** Label of the status category the new option is typed into. */
const CATEGORY = 'In progress'
/** Ships in every status definition, so it identifies the status picker's popover. */
const DEFAULT_OPTION = 'Not started'

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

function statusPicker(page: Page): Locator {
  return page.locator('[data-slot="picker-content"]').filter({ hasText: DEFAULT_OPTION }).first()
}

function optionsNamed(picker: Locator, value: string): Locator {
  return picker.getByRole('option', { name: value, exact: true })
}

async function addStatusPropertyThroughUi(page: Page): Promise<Locator> {
  await openDetailsMenu(page)
  await page.getByRole('menuitem', { name: 'Add property' }).click()
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
  const file = join(vaultPath, '.memry', 'properties.md')
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

function countOccurrences(text: string, value: string): number {
  return text.split(value).length - 1
}

/** The file's text once it has not changed for `stableMs`. */
async function settled(read: () => string, stableMs = 2_000, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = read()
  let since = Date.now()
  while (Date.now() < deadline) {
    await sleep(200)
    const now = read()
    if (now !== last) {
      last = now
      since = Date.now()
    } else if (Date.now() - since >= stableMs) {
      return now
    }
  }
  return last
}

test('a status option added in the picker survives a reload exactly once', async ({
  page,
  testVaultPath
}) => {
  const note = await openNewNote(page, `Status Options ${Date.now()}`)

  const picker = await addStatusPropertyThroughUi(page)
  await typeNewOption(picker, NEW_OPTION)
  await expect(optionsNamed(picker, NEW_OPTION)).toHaveCount(1)

  // The new status property is a value of the note's file.
  const file = join(testVaultPath, note.path)
  expect(await pollUntil(() => readFileSync(file, 'utf8').includes('Status:'))).toBe(true)

  await page.reload()
  await openNoteByHandle(page, { id: note.id, title: note.title })

  const reopened = await reopenStatusPicker(page)
  await expect(optionsNamed(reopened, NEW_OPTION)).toHaveCount(1)
  expect(countOccurrences(readDefinitionsFile(testVaultPath), NEW_OPTION)).toBe(1)
})

test('adding the same status option twice leaves one entry', async ({ page, testVaultPath }) => {
  await openNewNote(page, `Status Options Idempotent ${Date.now()}`)

  const picker = await addStatusPropertyThroughUi(page)
  await typeNewOption(picker, NEW_OPTION)
  await expect(optionsNamed(picker, NEW_OPTION)).toHaveCount(1)

  await typeNewOption(picker, NEW_OPTION)

  // A duplicating append rewrites the file, so settling on unchanged bytes is what separates
  // "the second add was dropped" from "it has not landed yet".
  const text = await settled(() => readDefinitionsFile(testVaultPath))
  expect(countOccurrences(text, NEW_OPTION)).toBe(1)
  await expect(optionsNamed(picker, NEW_OPTION)).toHaveCount(1)
})
