// Templates in the running app (Step 13l, #3530), ported from Electron's `templates.e2e.ts`: the
// template commands called from the page as `services/templates-service.ts` calls them, and the
// Settings › Templates list following their events. Applying a template to a note and saving a
// note as one move over with `notes_apply_template` (13l-4).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { invoke, vaultStatus } from '../../harness/vault-commands'
import { pollUntil } from '../../harness/wait'

interface Template {
  id: string
  name: string
  isBuiltIn: boolean
  tags: string[]
  properties: unknown[]
  content: string
}

interface ListItem {
  id: string
  name: string
  isBuiltIn: boolean
}

async function ready(page: Page): Promise<void> {
  expect(await pollUntil(async () => (await vaultStatus(page)).isOpen, { timeoutMs: 30_000 })).toBe(
    true
  )
}

const stamp = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

test('creates, updates, duplicates, deletes, and persists templates in the vault', async ({
  page,
  testVaultPath
}) => {
  await ready(page)
  const templateName = `Template ${stamp()}`
  const updatedName = `${templateName} Updated`
  const copyName = `${templateName} Copy`

  const created = await invoke<Template>(page, 'templates_create', {
    input: {
      name: templateName,
      description: 'Template coverage from Tauri E2E',
      icon: 'T',
      tags: ['e2e-template'],
      properties: [{ name: 'Stage', type: 'select', value: 'Draft', options: ['Draft', 'Final'] }],
      content: '# Template heading\n\nBody from E2E'
    }
  })
  const updated = await invoke<Template>(page, 'templates_update', {
    input: {
      id: created.id,
      name: updatedName,
      tags: ['e2e-template', 'updated'],
      content: '# Updated heading\n\nUpdated body from E2E'
    }
  })
  const duplicate = await invoke<Template>(page, 'templates_duplicate', {
    id: created.id,
    newName: copyName
  })
  const beforeDelete = await invoke<ListItem[]>(page, 'templates_list')

  // A pre-sync file of the template goes with it; it would be imported again otherwise.
  const legacyDir = join(testVaultPath, '.memry', 'templates')
  mkdirSync(legacyDir, { recursive: true })
  const legacyFile = join(legacyDir, `${created.id}.md`)
  writeFileSync(legacyFile, `---\nid: ${created.id}\nname: Old\n---\nold body\n`)

  await invoke(page, 'templates_delete', { id: duplicate.id })
  await invoke(page, 'templates_delete', { id: created.id })
  const afterDelete = await invoke<ListItem[]>(page, 'templates_list')

  expect(updated).toMatchObject({
    id: created.id,
    name: updatedName,
    tags: ['e2e-template', 'updated'],
    properties: [{ name: 'Stage', type: 'select', value: 'Draft', options: ['Draft', 'Final'] }],
    content: '# Updated heading\n\nUpdated body from E2E'
  })
  const listedBefore = new Set(beforeDelete.map((template) => template.name))
  expect(listedBefore.has(updatedName) && listedBefore.has(copyName)).toBe(true)
  const listedAfter = new Set(afterDelete.map((template) => template.id))
  expect(listedAfter.has(created.id) || listedAfter.has(duplicate.id)).toBe(false)
  expect(existsSync(legacyFile)).toBe(false)
  expect(existsSync(join(legacyDir, `${duplicate.id}.md`))).toBe(false)
  expect(await invoke<Template | null>(page, 'templates_get', { id: created.id })).toBeNull()
})

test('Settings › Templates follows the template events and refuses to change a built-in', async ({
  page
}) => {
  await ready(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  // Settings › Editor holds the Templates section.
  await page.getByRole('button', { name: 'Editor', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Blank Note', exact: true })).toBeVisible()

  const name = `Listed ${stamp()}`
  const created = await invoke<Template>(page, 'templates_create', { input: { name } })
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible()

  await invoke(page, 'templates_delete', { id: created.id })
  await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0)

  const refused = await page.evaluate(() =>
    window.__TAURI__.core.invoke('templates_delete', { id: 'blank' }).then(
      () => 'deleted',
      (error: unknown) => (error as { kind: string }).kind
    )
  )
  expect(refused).toBe('invalid')
  await expect(page.getByRole('button', { name: 'Blank Note', exact: true })).toBeVisible()
})
