// @ts-nocheck - E2E tests in development, follow canvas-folder-rename.e2e.ts convention
/**
 * Renaming a NOTES folder (Collections section) from the row's context menu.
 *
 * Companion to canvas-folder-rename.e2e.ts. The field opens while a Radix
 * context menu is still animating out, and every part of that race runs on
 * timers and CSS animations jsdom does not have, so the renderer suite cannot
 * see it. Reported symptom: the field flashes and vanishes ~200ms later, and
 * the folder keeps its old name.
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

function sectionHeader(page: Page) {
  return page.getByRole('button', { name: /Collections section/ })
}

async function expandCollections(page: Page): Promise<void> {
  const header = sectionHeader(page)
  await expect(header).toBeVisible({ timeout: 30_000 })
  if ((await header.getAttribute('aria-expanded')) !== 'true') {
    await header.click()
  }
  await expect(header).toHaveAttribute('aria-expanded', 'true')
}

/** Records every focus() call and every focusout, with a JS stack for the thief. */
async function instrumentFocus(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __focusLog: unknown[] }
    w.__focusLog = []
    const describe = (el: Element | null): string =>
      el
        ? `${el.tagName}${el.getAttribute('aria-label') ? `[${el.getAttribute('aria-label')}]` : ''}${
            el.getAttribute('data-tree-node-id') ? `{${el.getAttribute('data-tree-node-id')}}` : ''
          }.${(el.className || '').toString().slice(0, 50)}`
        : 'null'
    const origFocus = HTMLElement.prototype.focus
    HTMLElement.prototype.focus = function (...args) {
      w.__focusLog.push({
        t: Math.round(performance.now()),
        kind: 'focus()',
        on: describe(this),
        stack: (new Error().stack || '').split('\n').slice(2, 8).join(' <- ')
      })
      return origFocus.apply(this, args)
    }
    document.addEventListener(
      'focusout',
      (e) => {
        w.__focusLog.push({
          t: Math.round(performance.now()),
          kind: 'focusout',
          on: describe(e.target as Element),
          related: describe(e.relatedTarget as Element)
        })
      },
      true
    )
  })
}

async function dumpFocusLog(page: Page, label: string): Promise<void> {
  const log = await page.evaluate(() => (window as unknown as { __focusLog: unknown[] }).__focusLog)
  console.log(`\n===== FOCUS LOG (${label}) =====\n${JSON.stringify(log, null, 1)}\n`)
  await page.evaluate(() => {
    ;(window as unknown as { __focusLog: unknown[] }).__focusLog = []
  })
}

/**
 * Clicks a row-menu item and then nudges the pointer, the way a hand does.
 *
 * The nudge is the whole point: the menu is still mounted and still handling
 * pointer events through its exit animation, and Radix's `onItemLeave` answers
 * a pointer leaving an item by focusing the menu content again. A field the
 * item just opened is blurred by that, and a blur is a commit here.
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

function folderRow(page: Page, name: string) {
  return page.locator('[data-tree-node-id^="folder-"]').filter({ hasText: name }).first()
}

test.describe('Sidebar folder rename (Collections)', () => {
  test.describe.configure({ timeout: 180_000 })

  test('the rename field stays open and focused', async ({ page }) => {
    await openVault(page)
    await expandCollections(page)
    await instrumentFocus(page)

    // --- Create a folder: it drops straight into rename mode ---
    await page.getByRole('button', { name: 'New folder', exact: true }).first().click()

    const created = renameField(page)
    await expect(created).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(600)
    await dumpFocusLog(page, 'after create')
    await expect(created, 'create-mode field vanished').toBeVisible()
    await expect(created, 'create-mode field lost focus').toBeFocused()
    await created.fill('Work')
    await created.press('Enter')

    const row = folderRow(page, 'Work')
    await expect(row).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(500)

    // --- Rename it from the row's context menu (the reported flow) ---
    await instrumentFocus(page)
    await row.click({ button: 'right' })
    await clickMenuItemAndMoveOn(page, 'Rename')

    const field = renameField(page)
    await expect(field).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(600)
    await dumpFocusLog(page, 'after context-menu rename')

    await expect(field, 'rename field vanished after opening').toBeVisible()
    await expect(field, 'rename field lost focus after opening').toBeFocused()

    await field.fill('Studio')
    await field.press('Enter')
    await expect(folderRow(page, 'Studio')).toBeVisible({ timeout: 15_000 })
  })

  test('the rename field stays open past the virtualization threshold', async ({
    page,
    testVaultPath
  }) => {
    // 150 notes puts the tree over VIRTUALIZATION_THRESHOLD (100), which is the
    // renderer real users with a real vault get.
    for (let i = 0; i < 150; i++) {
      fs.writeFileSync(
        path.join(testVaultPath, 'notes', `bulk-${String(i).padStart(3, '0')}.md`),
        `---\ntitle: Bulk ${i}\n---\n\nfiller\n`
      )
    }
    fs.mkdirSync(path.join(testVaultPath, 'notes', 'Work'), { recursive: true })
    fs.writeFileSync(
      path.join(testVaultPath, 'notes', 'Work', 'inside.md'),
      '---\ntitle: Inside\n---\n\nfiller\n'
    )

    await openVault(page)
    await page.reload()
    await openVault(page)
    await expandCollections(page)
    await instrumentFocus(page)

    // Seeded notes live under notes/, which the tree draws as its own folder.
    const notesFolder = page.locator('[data-tree-node-id="folder-notes"]')
    await expect(notesFolder).toBeVisible({ timeout: 30_000 })
    await notesFolder.click()

    const row = page.locator('[data-tree-node-id="folder-notes/Work"]')
    await expect(row).toBeVisible({ timeout: 30_000 })
    await row.scrollIntoViewIfNeeded()
    await row.click({ button: 'right' })
    await clickMenuItemAndMoveOn(page, 'Rename')

    const field = renameField(page)
    await expect(field).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(600)
    await dumpFocusLog(page, 'virtualized context-menu rename')

    await expect(field, 'virtualized rename field vanished').toBeVisible()
    await expect(field, 'virtualized rename field lost focus').toBeFocused()

    await field.fill('Studio')
    await field.press('Enter')
    await expect(page.locator('[data-tree-node-id="folder-notes/Studio"]')).toBeVisible({
      timeout: 15_000
    })
  })

  test('the rename field survives a vault change landing while it is open', async ({
    page,
    testVaultPath
  }) => {
    await openVault(page)
    await expandCollections(page)

    await page.getByRole('button', { name: 'New folder', exact: true }).first().click()
    const created = renameField(page)
    await expect(created).toBeVisible({ timeout: 15_000 })
    await created.fill('Work')
    await created.press('Enter')

    const row = folderRow(page, 'Work')
    await expect(row).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(500)

    await instrumentFocus(page)
    await row.click({ button: 'right' })
    await clickMenuItemAndMoveOn(page, 'Rename')

    const field = renameField(page)
    await expect(field).toBeVisible({ timeout: 10_000 })
    await expect(field).toBeFocused()

    // The thing a sync push, another device, or the file watcher does while the
    // user is mid-rename: the notes list and the folder list both change.
    fs.writeFileSync(
      path.join(testVaultPath, 'notes', 'arrived-from-sync.md'),
      '---\ntitle: Arrived\n---\n\nfiller\n'
    )
    fs.mkdirSync(path.join(testVaultPath, 'notes', 'ArrivedFolder'), { recursive: true })

    await page.waitForTimeout(1500)
    await dumpFocusLog(page, 'after a vault change landed')

    await expect(field, 'field vanished when the vault changed under it').toBeVisible()
    await expect(field, 'field lost focus when the vault changed under it').toBeFocused()

    await field.fill('Studio')
    await field.press('Enter')
    await expect(folderRow(page, 'Studio')).toBeVisible({ timeout: 15_000 })
  })
})
