// A template applied from the note page's menu (Step 13l-4, #3530), ported from Electron's
// `apply-template-note-menu.e2e.ts` (#2328): the open note takes the template's body, icon, tag
// and property, and shows them. Electron's project property and the project hub's link to the
// note wait for the tasks domain (Step 21); this spec applies a text property instead.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { SELECTORS } from '../../harness/app-helpers'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { invoke, vaultStatus } from '../../harness/vault-commands'
import { pollUntil } from '../../harness/wait'

const ICON = '🚀'
const TAG = 'e2e-apply-from-note-menu'

interface NoteView {
  id: string
  path: string
  title: string
  content: string
  tags: string[]
  headerTags: string[]
  properties: Record<string, unknown>
  emoji: string | null
}

const stamp = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

async function ready(page: Page): Promise<void> {
  expect(await pollUntil(async () => (await vaultStatus(page)).isOpen, { timeoutMs: 30_000 })).toBe(
    true
  )
}

/** Opens the note from the Collections tree, as a user does. */
async function openFromSidebar(page: Page, note: NoteView): Promise<void> {
  const section = page.locator('#section-header-collections')
  if ((await section.getAttribute('aria-expanded')) === 'false') await section.click()
  const folder = page.locator('[data-tree-node-id="folder-notes"]')
  const expand = folder.getByRole('button', { name: 'Expand folder' })
  if (await expand.isVisible()) await expand.click()
  await page.locator(`[data-tree-node-id="${note.id}"]`).click()
  await expect(page.locator('textarea[aria-label="Note title"]').first()).toHaveValue(note.title)
}

test('the note menu applies a template: its body, icon, tag and property', async ({
  page,
  testVaultPath
}) => {
  await ready(page)
  const templateName = `Apply From Menu ${stamp()}`
  await invoke(page, 'templates_create', {
    input: {
      name: templateName,
      icon: ICON,
      tags: [TAG],
      properties: [{ name: 'Stage', type: 'text', value: 'Draft' }],
      content: '## From the template'
    }
  })
  const target = await invoke<NoteView>(page, 'notes_create', {
    input: { title: `Apply Template Target ${stamp()}`, content: 'Existing body', folder: 'notes' }
  })
  await openFromSidebar(page, target)

  await page.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('option', { name: 'Apply Template', exact: true }).click()
  await page.getByPlaceholder('Search templates...').fill(templateName)
  await page
    .getByRole('button', { name: new RegExp(templateName) })
    .first()
    .click()
  await page.getByRole('button', { name: 'Apply Template', exact: true }).click()
  await page.getByRole('button', { name: 'Replace content & add template details' }).click()
  await expect(page.getByText('Template applied').first()).toBeVisible({ timeout: 10_000 })

  // The open editor takes the template's body, as it takes an outside edit.
  await expect(page.locator(SELECTORS.noteEditor).first()).toContainText('From the template')
  await expect(page.getByTestId('note-title-icon').first()).toContainText(ICON)
  await expect(
    page.getByRole('list', { name: 'Tags', exact: true }).first().getByRole('option', { name: TAG })
  ).toBeVisible()

  const applied = await invoke<NoteView>(page, 'notes_get', { id: target.id })
  expect(applied).toMatchObject({
    emoji: ICON,
    headerTags: [TAG],
    properties: { Stage: 'Draft' },
    content: '## From the template\n'
  })
  expect(readFileSync(join(testVaultPath, target.path), 'utf8')).toBe(
    `---\ntags:\n  - ${TAG}\nStage: Draft\n---\n## From the template\n`
  )
})
