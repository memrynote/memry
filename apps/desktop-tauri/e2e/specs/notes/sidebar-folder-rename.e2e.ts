// Renaming a notes folder (Collections section) from the row's context menu, ported from
// Electron's `sidebar-folder-rename.e2e.ts` (Step 13h, #3530). The field opens while a Radix
// context menu is still animating out, a race that runs on timers and CSS animations jsdom does
// not have. Reported symptom: the field flashes and vanishes ~200ms later, and the folder keeps
// its old name. On Tauri the rename runs through `notes_rename_folder`: the folder moves on
// disk and its notes keep their ids.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { invoke, vaultStatus } from '../../harness/vault-commands'
import { pollUntil } from '../../harness/wait'

interface NoteView {
  id: string
  path: string
}

async function ready(page: Page): Promise<void> {
  expect(await pollUntil(async () => (await vaultStatus(page)).isOpen, { timeoutMs: 30_000 })).toBe(
    true
  )
}

async function expandCollections(page: Page): Promise<void> {
  const header = page.locator('#section-header-collections')
  await expect(header).toBeVisible({ timeout: 30_000 })
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'true')
}

/**
 * Clicks a row-menu item and then nudges the pointer, the way a hand does. The menu is still
 * mounted through its exit animation, and Radix answers a pointer leaving an item by focusing
 * the menu content again: a field the item just opened is blurred by that, and a blur commits.
 */
async function clickMenuItemAndMoveOn(page: Page, label: string): Promise<void> {
  const item = page.getByRole('menuitem', { name: label, exact: true })
  await expect(item).toBeVisible()
  const box = await item.boundingBox()
  await item.click()
  if (!box) return
  for (let dy = 6; dy <= 48; dy += 6) {
    await page.mouse.move(box.x + box.width / 2, box.y + dy)
    await page.waitForTimeout(20)
  }
}

const renameField = (page: Page) => page.getByLabel('Rename', { exact: true })
const folderRow = (page: Page, path: string) => page.locator(`[data-tree-node-id="folder-${path}"]`)

/** New folder in the Collections header, named `name` in the field it opens. */
async function createFolder(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'New folder', exact: true }).first().click()
  const created = renameField(page)
  await expect(created).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(600)
  await expect(created).toBeVisible()
  await expect(created).toBeFocused()
  await created.fill(name)
  await created.press('Enter')
  await expect(folderRow(page, name)).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(500)
}

async function openRename(page: Page, path: string): Promise<void> {
  const row = folderRow(page, path)
  await row.scrollIntoViewIfNeeded()
  await row.click({ button: 'right' })
  await clickMenuItemAndMoveOn(page, 'Rename')
  const field = renameField(page)
  await expect(field).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(600)
  await expect(field).toBeVisible()
  await expect(field).toBeFocused()
}

async function commitRename(page: Page, name: string): Promise<void> {
  const field = renameField(page)
  await field.fill(name)
  await field.press('Enter')
}

test('the rename field stays open and focused, and the folder moves with its note', async ({
  page,
  testVaultPath
}) => {
  await ready(page)
  await expandCollections(page)
  await createFolder(page, 'Work')
  const inside = await invoke<NoteView>(page, 'notes_create', {
    input: { title: 'Inside', folder: 'Work', content: 'filler' }
  })

  await openRename(page, 'Work')
  await commitRename(page, 'Studio')
  await expect(folderRow(page, 'Studio')).toBeVisible({ timeout: 15_000 })

  expect(existsSync(join(testVaultPath, 'Studio/Inside.md'))).toBe(true)
  expect(existsSync(join(testVaultPath, 'Work'))).toBe(false)
  const note = await invoke<NoteView | null>(page, 'notes_get', { id: inside.id })
  expect(note?.path).toBe('Studio/Inside.md')
})

test('#3958: the open note follows its folder rename in the breadcrumb', async ({ page }) => {
  await ready(page)
  await expandCollections(page)
  await createFolder(page, 'Work')
  const inside = await invoke<NoteView>(page, 'notes_create', {
    input: { title: 'Inside', folder: 'Work', content: 'filler' }
  })

  const expand = folderRow(page, 'Work').getByRole('button', { name: 'Expand folder' })
  if (await expand.isVisible()) await expand.click()
  await page.locator(`[data-tree-node-id="${inside.id}"]`).click()
  await expect(page.locator('textarea[aria-label="Note title"]').first()).toHaveValue('Inside')
  const crumbs = page.getByRole('navigation', { name: 'Note location' })
  await expect(crumbs).toContainText('Work')

  await openRename(page, 'Work')
  await commitRename(page, 'Studio')
  await expect(folderRow(page, 'Studio')).toBeVisible({ timeout: 15_000 })

  await expect(crumbs).toContainText('Studio')
  await expect(crumbs).not.toContainText('Work')
})

test('the rename field stays open past the virtualization threshold', async ({
  page,
  testVaultPath
}) => {
  test.slow()
  // 150 notes puts the tree over VIRTUALIZATION_THRESHOLD (100), the renderer real users with a
  // real vault get.
  for (let i = 0; i < 150; i++) {
    writeFileSync(
      join(testVaultPath, 'notes', `bulk-${String(i).padStart(3, '0')}.md`),
      `---\ntitle: Bulk ${i}\n---\n\nfiller\n`
    )
  }
  mkdirSync(join(testVaultPath, 'notes', 'Work'), { recursive: true })
  writeFileSync(join(testVaultPath, 'notes', 'Work', 'inside.md'), '---\ntitle: Inside\n---\n\n')

  await ready(page)
  await page.reload()
  await ready(page)
  await expandCollections(page)
  const notesFolder = folderRow(page, 'notes')
  await expect(notesFolder).toBeVisible({ timeout: 30_000 })
  await notesFolder.click()
  await expect(folderRow(page, 'notes/Work')).toBeVisible({ timeout: 30_000 })
  // The tree turns virtualized only once every bulk note is listed, and that swap remounts every
  // row, an open menu or rename field with it. The virtualized tree nests the treeitem under the
  // row's positioned wrapper; the plain tree puts both on one element.
  await expect(
    page.locator('[data-tree-node-id="folder-notes/Work"] > [role="treeitem"]')
  ).toBeVisible({ timeout: 30_000 })

  await openRename(page, 'notes/Work')
  await commitRename(page, 'Studio')
  await expect(folderRow(page, 'notes/Studio')).toBeVisible({ timeout: 15_000 })
  expect(existsSync(join(testVaultPath, 'notes/Studio/inside.md'))).toBe(true)
})

test('the rename field survives a vault change landing while it is open', async ({
  page,
  testVaultPath
}) => {
  await ready(page)
  await expandCollections(page)
  await createFolder(page, 'Work')
  await openRename(page, 'Work')

  // What a sync, another device or the file watcher does while the user is mid-rename: the notes
  // list and the folder list both change.
  writeFileSync(
    join(testVaultPath, 'notes', 'arrived-from-sync.md'),
    '---\ntitle: Arrived\n---\n\nfiller\n'
  )
  mkdirSync(join(testVaultPath, 'notes', 'ArrivedFolder'), { recursive: true })
  await page.waitForTimeout(1500)

  const field = renameField(page)
  await expect(field).toBeVisible()
  await expect(field).toBeFocused()
  await commitRename(page, 'Studio')
  await expect(folderRow(page, 'Studio')).toBeVisible({ timeout: 15_000 })
})
