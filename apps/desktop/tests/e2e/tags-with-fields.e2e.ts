/**
 * Tags with fields, end to end through the UI: ready-made tags from the Tags
 * hub, the tags row applying a template (with Undo), a relation field limited
 * to its target tag, Linked here on the target, an inline #tag with fields
 * staying a mention, and a field rename reaching the note's file on disk.
 */

import * as fs from 'fs'
import * as path from 'path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { ready } from './utils/desktop-test-helpers'
import { createNote, SELECTORS } from './utils/electron-helpers'

const TITLE = `Ada Lovelace ${Date.now().toString(36)}`

function tagsRow(page: Page) {
  return page.getByRole('list', { name: 'Tags' }).first()
}

async function noteIdByTitle(page: Page, title: string): Promise<string> {
  const id = await page.evaluate(async (t) => {
    const { notes } = await window.api.notes.list({})
    return notes.find((note) => note.title === t)?.id ?? null
  }, title)
  if (!id) throw new Error(`no note titled "${title}"`)
  return id
}

async function addPreset(page: Page, name: string): Promise<void> {
  const card = page
    .locator('section[aria-labelledby="preset-offer-title"] > div.grid > div')
    .filter({ has: page.getByText(name.toLowerCase(), { exact: true }) })
  // Person's Company relation adds #company along with it.
  const add = card.getByRole('button', { name: 'Add', exact: true })
  if (await add.isVisible()) await add.click()
  await expect(card.getByRole('button', { name: 'Added' })).toBeVisible()
}

async function addHeaderTag(page: Page, tag: string): Promise<void> {
  // The title's "Add tag" opens the tags row while it is empty; the row has its own after.
  await page.getByRole('button', { name: 'Add tag', exact: true }).first().click()
  const input = page.getByPlaceholder(/tag/i).last()
  await input.fill(tag)
  await page.keyboard.press('Enter')
}

function noteFile(vault: string, title: string): string {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return entry.name.startsWith('.') ? [] : walk(full)
      return entry.name.endsWith('.md') ? [full] : []
    })
  const file = walk(vault).find((f) => path.basename(f, '.md') === title)
  if (!file) throw new Error(`no file for "${title}" in ${vault}`)
  return file
}

function frontmatter(file: string): string {
  const text = fs.readFileSync(file, 'utf8')
  return text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ''
}

test.describe('Tags with fields', () => {
  test('ready-made tag, template undo, relation, linked here, inline mention, field rename', async ({
    page,
    testVaultPath
  }) => {
    test.setTimeout(180_000)
    await ready(page)

    // Ready-made Person, Company and Meeting from the Tags hub.
    await page.locator('button[aria-label="Open tag hub"]').click()
    await expect(page.getByRole('heading', { name: 'Ready-made tags' })).toBeVisible()
    await addPreset(page, 'Person')
    await addPreset(page, 'Company')
    await addPreset(page, 'Meeting')

    // A new note gets #person in the tags row: the template fills it.
    await createNote(page, TITLE)
    const noteId = await noteIdByTitle(page, TITLE)
    const editor = page.locator(SELECTORS.noteEditor).first()
    const headerTags = (): Promise<string[]> =>
      page.evaluate(async (id) => (await window.api.notes.get(id))?.headerTags ?? [], noteId)
    await addHeaderTag(page, 'person')
    const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'is now a person' })
    await expect(toast).toBeVisible()
    await expect(editor).toContainText('Context')

    // Undo empties the body again; the tag stays.
    await toast.getByRole('button', { name: 'Undo' }).click()
    await expect(editor).not.toContainText('Context')
    await expect
      .poll(async () => (await page.evaluate((id) => window.api.notes.get(id), noteId))?.content)
      .not.toContain('Context')
    await expect(tagsRow(page).getByRole('option', { name: 'person' })).toBeVisible()

    // Company is a relation limited to #company; create Acme from the picker.
    const companyRow = page
      .getByRole('list', { name: 'person' })
      .locator('> *')
      .filter({ hasText: 'Company' })
    await companyRow.getByRole('button', { name: 'Add relation' }).last().click()
    const picker = page.getByTestId('object-relation-picker')
    await expect(picker.getByRole('textbox', { name: 'Search company' })).toBeVisible()
    await picker.getByRole('textbox', { name: 'Search company' }).fill('Acme')
    await picker.getByRole('button', { name: /New company .Acme./ }).click()
    await expect(companyRow).toContainText('Acme')

    const acmeLink = `memry://note/${await noteIdByTitle(page, 'Acme')}`
    await expect
      .poll(async () => frontmatter(noteFile(testVaultPath, TITLE)), { timeout: 10_000 })
      .toMatch(new RegExp(`^Company:\\n\\s+- '${acmeLink}'`, 'm'))

    // Inline #meeting is a tag with fields: it stays a mention in the text.
    await editor.click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type(' Met at #meeting ')
    await expect(editor).toContainText('meeting')
    await page.waitForTimeout(1500)
    expect(await headerTags()).toContain('person')
    expect(await headerTags()).not.toContain('meeting')
    await expect(tagsRow(page).getByRole('option', { name: 'meeting' })).toHaveCount(0)

    // Acme's page lists the note under Linked here.
    await companyRow.getByText('Acme').click()
    const linkedHere = page.getByTestId('linked-here')
    await expect(linkedHere).toBeVisible()
    await expect(linkedHere).toContainText(TITLE)

    // Rename Person's Company field to Employer from the tag settings.
    await page.locator('button[aria-label="Open tag hub"]').click()
    await page.getByRole('button', { name: /^person Has fields/ }).click()
    await page.getByRole('button', { name: 'Edit tag' }).click()
    const sheet = page.getByRole('complementary', { name: 'Settings for #person' })
    await sheet.getByRole('button', { name: 'Actions for Company' }).click()
    await page.getByRole('menuitem', { name: 'Rename…' }).click()
    const renameInput = page.getByRole('textbox', { name: 'New name' })
    await renameInput.fill('Employer')
    await page.getByRole('button', { name: 'Rename', exact: true }).click()

    await expect
      .poll(async () => frontmatter(noteFile(testVaultPath, TITLE)), { timeout: 15_000 })
      .toMatch(new RegExp(`^Employer:\\n\\s+- '${acmeLink}'`, 'm'))
    expect(frontmatter(noteFile(testVaultPath, TITLE))).not.toMatch(/^Company:/m)
  })
})
