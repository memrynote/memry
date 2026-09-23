// @ts-nocheck - E2E tests in development, follow canvas-folder-rename.e2e.ts convention
/**
 * Dragging a notes folder onto another folder in the sidebar (#2206).
 *
 * The folder that failed was one holding a subfolder: on Windows the vault
 * watcher keeps every directory open, and Windows will not rename a directory
 * while anything beneath it is open, so the move failed EPERM and the drop
 * silently did nothing. A folder with no subfolder moved fine. jsdom has neither
 * a real drag nor a real filesystem under a watcher, so this runs in Electron;
 * the Windows smoke job is the run that exercises the failing platform.
 */
import * as fs from 'fs'
import * as path from 'path'

import { test, expect, type Page } from './fixtures'
import { ready } from './utils/desktop-test-helpers'

async function openVault(page: Page): Promise<void> {
  await page
    .locator('aside, [data-testid="sidebar"], [class*="sidebar"], nav')
    .first()
    .waitFor({ state: 'visible', timeout: 90_000 })
  await ready(page)
}

async function expandCollections(page: Page): Promise<void> {
  const header = page.getByRole('button', { name: /Collections section/ })
  await expect(header).toBeVisible({ timeout: 30_000 })
  if ((await header.getAttribute('aria-expanded')) !== 'true') {
    await header.click()
  }
  await expect(header).toHaveAttribute('aria-expanded', 'true')
}

function seed(vault: string, fillerNotes: number): void {
  const notes = path.join(vault, 'notes')
  const write = (rel: string, title: string): void => {
    fs.mkdirSync(path.dirname(path.join(notes, rel)), { recursive: true })
    fs.writeFileSync(path.join(notes, rel), `---\ntitle: ${title}\n---\n\nfiller\n`)
  }
  write('Beta/beta-note.md', 'beta-note')
  write('Beta/Gamma/gamma-note.md', 'gamma-note')
  write('Delta/delta-note.md', 'delta-note')
  for (let i = 0; i < fillerNotes; i++) {
    write(`filler-${String(i).padStart(3, '0')}.md`, `Filler ${i}`)
  }
}

const row = (page: Page, nodeId: string) => page.locator(`[data-tree-node-id="${nodeId}"]`)

/** A hand-driven drag: press on the label, move in steps, release mid-row ("inside"). */
async function dragOnto(page: Page, fromId: string, toId: string): Promise<void> {
  const from = await row(page, fromId).boundingBox()
  const to = await row(page, toId).boundingBox()
  await page.mouse.move(from.x + 60, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + 64, from.y + from.height / 2 + 6, { steps: 4 })
  await page.mouse.move(to.x + 60, to.y + to.height / 2, { steps: 12 })
  await page.mouse.up()
}

for (const [tree, fillerNotes] of [
  ['plain', 0],
  // Past VIRTUALIZATION_THRESHOLD (100), the tree most real vaults render.
  ['virtualized', 150]
] as const) {
  test(`a folder holding a subfolder drops into another folder (${tree} tree)`, async ({
    page,
    testVaultPath
  }) => {
    test.setTimeout(180_000)
    seed(testVaultPath, fillerNotes)
    await openVault(page)
    await page.reload()
    await openVault(page)
    await expandCollections(page)

    await row(page, 'folder-notes').first().click()
    await expect(row(page, 'folder-notes/Beta')).toBeVisible({ timeout: 30_000 })
    await expect(row(page, 'folder-notes/Delta')).toBeVisible()

    await dragOnto(page, 'folder-notes/Beta', 'folder-notes/Delta')

    const onDisk = (rel: string) => fs.existsSync(path.join(testVaultPath, 'notes', rel))
    await expect.poll(() => onDisk('Delta/Beta/Gamma/gamma-note.md'), { timeout: 15_000 }).toBe(true)
    expect(onDisk('Beta')).toBe(false)

    await expect(row(page, 'folder-notes/Beta')).toHaveCount(0, { timeout: 15_000 })
    await row(page, 'folder-notes/Delta').click()
    await expect(row(page, 'folder-notes/Delta/Beta')).toBeVisible({ timeout: 15_000 })
    await row(page, 'folder-notes/Delta/Beta').click()
    await row(page, 'folder-notes/Delta/Beta/Gamma').click()
    // Once, not twice: the watcher re-identified the moved note instead of
    // indexing a second copy at the new path.
    const noteRows = page.locator('[data-tree-node-id]:not([data-tree-node-id^="folder-"])')
    await expect(noteRows.filter({ hasText: 'gamma-note' })).toHaveCount(1, { timeout: 15_000 })
  })
}
