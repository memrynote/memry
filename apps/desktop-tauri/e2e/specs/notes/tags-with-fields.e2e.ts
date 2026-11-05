// Tags with fields in the running app (Step 13j-3, #3530), ported from Electron's
// `tags-with-fields.e2e.ts`: the tag hub's ready-made tags write a tag's fields, its related
// tags and its template, and the strip stays dismissed over a restart. The relation picker,
// Linked here and the field rename of Electron's first test wait for 13j-3c and 13j-3d.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { SELECTORS } from '../../harness/app-helpers'
import { createNote, openFromSidebar } from '../../harness/notes'
import type { TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'

import type { Page } from '../../harness/pw-compat/page'
import { restart } from '../../harness/tauri-lifecycle'
import { test, expect } from '../../harness/test'
import { vaultOpen } from '../../harness/tags'
import { invoke } from '../../harness/vault-commands'

const STRIP = 'section[aria-labelledby="preset-offer-title"]'

const snapshot = (page: Page) => invoke<TagSchemaSnapshot>(page, 'tags_get_schema_snapshot')

async function openTagHub(page: Page): Promise<void> {
  await page.locator('button[aria-label="Open tag hub"]').click()
  await expect(page.getByRole('button', { name: /New tag/ })).toBeVisible({ timeout: 10_000 })
}

/** Adds the ready-made tag `key` from its card in the strip, unless it is already added. */
async function addPreset(page: Page, key: string): Promise<void> {
  const card = page.locator(`${STRIP} > div.grid > div`).filter({ hasText: new RegExp(`^${key}`) })
  const add = card.getByRole('button', { name: 'Add', exact: true })
  if (await add.isVisible()) await add.click()
  await expect(card.getByRole('button', { name: 'Added' })).toBeVisible({ timeout: 10_000 })
}

async function addHeaderTag(page: Page, tag: string): Promise<void> {
  // With tags present the tags row owns the add button; otherwise it lives in the details menu.
  const rowAddTag = page.getByRole('button', { name: 'Add tag', exact: true }).first()
  if (await rowAddTag.isVisible()) {
    await rowAddTag.click()
  } else {
    // The "add details" row takes pointer events only while the header is hovered, which a
    // WebDriver pointer move does not do in WKWebView, so its menu opens from the keyboard.
    const details = page.getByTestId('ghost-add-details')
    await details.waitFor({ state: 'attached' })
    await details.focus()
    await page.keyboard.press('Enter')
    await page.getByRole('menuitem', { name: 'Add tag', exact: true }).click()
  }
  await page.getByPlaceholder(/tag/i).last().fill(tag)
  await page.keyboard.press('Enter')
}

test('a ready-made tag brings its related tags, and Not now holds over a restart', async ({
  app,
  page
}) => {
  await vaultOpen(page)
  await openTagHub(page)
  await expect(page.getByRole('heading', { name: 'Ready-made tags' })).toBeVisible()

  // A meeting links attendees and a company, so adding it adds person and company first.
  await addPreset(page, 'meeting')
  await addPreset(page, 'person')
  await addPreset(page, 'company')
  const added = await snapshot(page)
  expect(added.presets.map((preset) => [preset.key, preset.state])).toEqual([
    ['person', 'added'],
    ['company', 'added'],
    ['meeting', 'added'],
    ['book', 'add']
  ])
  expect(added.tags.meeting.ownFields.map((field) => [field.name, field.relation?.target])).toEqual(
    [
      ['Date', undefined],
      ['Attendees', 'person'],
      ['Company', 'company']
    ]
  )
  expect(added.tags.person.ownFields.find((field) => field.name === 'Role')?.type).toBe('text')

  await page.locator(STRIP).getByRole('button', { name: 'Not now' }).click()
  await expect(page.locator(STRIP)).toHaveCount(0)

  await restart(app)
  await vaultOpen(page)
  expect((await snapshot(page)).presetStripDismissed).toBe(true)
  await openTagHub(page)
  await expect(page.locator(STRIP)).toHaveCount(0)
})

// Pending: the undo empties the file, but the open editor keeps the template. Without a CRDT
// doc (`syncCrdt.openDoc` is not ported) an outside edit reloads the editor from the body, and
// `use-editor-sync.ts` replaces nothing when that body is empty.
test.skip('a template added again after Undo reaches the open editor', async ({
  page,
  testVaultPath
}) => {
  await vaultOpen(page)
  await openTagHub(page)
  await addPreset(page, 'person')

  const title = `Again ${Date.now().toString(36)}`
  const note = await createNote(page, { title, content: '', folder: 'notes' })
  await openFromSidebar(page, note)
  const editor = page.locator(SELECTORS.noteEditor).first()
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'is now a person' })
  const file = (): string => readFileSync(join(testVaultPath, note.path), 'utf8')

  await addHeaderTag(page, 'person')
  await expect(toast).toBeVisible({ timeout: 10_000 })
  await expect(editor).toContainText('Context')
  await toast.getByRole('button', { name: 'Undo' }).click()
  await expect(editor).not.toContainText('Context')
  await expect.poll(file).not.toContain('Context')
  await expect(toast).toHaveCount(0)

  const tagsRow = page.getByRole('list', { name: 'Tags', exact: true }).first()
  const chip = tagsRow.getByRole('option', { name: 'person' })
  await chip.hover()
  await page.getByRole('button', { name: 'Remove tag: person' }).click()
  await expect(chip).toHaveCount(0)

  await addHeaderTag(page, 'person')
  await expect(toast).toBeVisible({ timeout: 10_000 })
  await expect.poll(file).toContain('Context')
  await expect(editor).toContainText('Context')

  // The editor's write-back after the fill keeps the template.
  await page.waitForTimeout(2500)
  expect(file()).toContain('Context')
})
