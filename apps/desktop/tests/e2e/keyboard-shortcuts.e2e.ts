/**
 * Keyboard shortcuts E2E.
 *
 * Presses every chord listed in Settings -> Shortcuts (plus the fixed aliases
 * the help dialog advertises) in the built app and checks the visible effect,
 * then rebinds through the real settings UI and checks that the new chord
 * works, the old one is free, and a vault switch loads that vault's own chords.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { MOD, ready } from './utils/desktop-test-helpers'
import { waitForVaultReady } from './utils/electron-helpers'

const IS_MAC = process.platform === 'darwin'
// Kept vault workspaces stay mounted but hidden; count only the visible one.
const tabs = (page: Page) => page.locator('[role="tab"][data-group-id]:visible')
const panes = (page: Page) => page.locator('[role="tablist"][data-group-id]:visible')
const activeTab = (page: Page) =>
  page.locator('[role="tab"][data-group-id][aria-selected="true"]:visible')
const sidebar = (page: Page) => page.locator('[data-slot="sidebar"][data-side="left"]')
const helpDialog = (page: Page) => page.getByRole('dialog', { name: 'Keyboard Shortcuts' })
const editor = (page: Page) =>
  page.locator('[aria-label="Rich text editor"] [contenteditable="true"]:visible').first()

/** Most app chords stand down while a text field has focus; start from none. */
async function blur(page: Page): Promise<void> {
  await page.evaluate(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
  })
}

async function activeTabId(page: Page): Promise<string | null> {
  return activeTab(page).first().getAttribute('data-tab-id')
}

async function devicePixelRatio(page: Page): Promise<number> {
  return page.evaluate(() => window.devicePixelRatio)
}

/** The sidebar row ⌘N puts into rename for the note it just created. */
const renameInput = (page: Page) => page.locator('input[aria-label="Rename"]:focus')

/** A note tab, opened through ⌘N, with the sidebar rename it starts closed. */
async function newNoteTab(page: Page): Promise<void> {
  const before = await tabs(page).count()
  await blur(page)
  await page.keyboard.press(`${MOD}+n`)
  await expect(tabs(page)).toHaveCount(before + 1)
  await expect(renameInput(page)).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(renameInput(page)).toHaveCount(0)
  await blur(page)
}

function makeVault(prefix: string): string {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fs.mkdirSync(path.join(vaultPath, '.memry'), { recursive: true })
  fs.mkdirSync(path.join(vaultPath, 'notes'), { recursive: true })
  fs.mkdirSync(path.join(vaultPath, 'journal'), { recursive: true })
  return vaultPath
}

test.describe('Keyboard shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await ready(page)
    await blur(page)
  })

  test('navigation and view chords open what they name', async ({ page }) => {
    // Search: ⌘K, and the fixed ⌘P alias.
    for (const chord of [`${MOD}+k`, `${MOD}+p`]) {
      await page.keyboard.press(chord)
      await expect(page.locator('[cmdk-input]')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.locator('[cmdk-input]')).toHaveCount(0)
      await blur(page)
    }

    // Settings: ⌘,
    await page.keyboard.press(`${MOD}+Comma`)
    await expect(page.getByTestId('settings-view')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('settings-view')).toHaveCount(0)
    await blur(page)

    // Shortcuts help: ⌘/ and ?
    for (const chord of [`${MOD}+Slash`, 'Shift+Slash']) {
      await page.keyboard.press(chord)
      await expect(helpDialog(page)).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(helpDialog(page)).toHaveCount(0)
      await blur(page)
    }

    // Switch vault: ⌘⇧O
    await page.keyboard.press(`${MOD}+Shift+O`)
    await expect(page.locator('[data-slot="picker-content"]').first()).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-slot="picker-content"]')).toHaveCount(0)
    await blur(page)

    // Toggle sidebar: ⌘B
    await expect(sidebar(page)).toHaveAttribute('data-state', 'expanded')
    await page.keyboard.press(`${MOD}+b`)
    await expect(sidebar(page)).toHaveAttribute('data-state', 'collapsed')
    await page.keyboard.press(`${MOD}+b`)
    await expect(sidebar(page)).toHaveAttribute('data-state', 'expanded')

    // New note: ⌘N. It leaves the new row in sidebar rename, and app chords
    // must still get through that field: ⌘N again, then ⌘W.
    await newNoteTab(page)
    const count = await tabs(page).count()
    await page.keyboard.press(`${MOD}+n`)
    await expect(tabs(page)).toHaveCount(count + 1)
    await expect(renameInput(page)).toHaveCount(1)
    await page.keyboard.press(`${MOD}+n`)
    await expect(tabs(page)).toHaveCount(count + 2)
    await expect(renameInput(page)).toHaveCount(1)
    await page.keyboard.press(`${MOD}+w`)
    await expect(tabs(page)).toHaveCount(count + 1)
    await blur(page)

    // Zoom: ⌘= / ⌘⇧+ / ⌘- / ⌘0
    const base = await devicePixelRatio(page)
    await page.keyboard.press(`${MOD}+Equal`)
    await expect.poll(() => devicePixelRatio(page)).toBeGreaterThan(base)
    const zoomed = await devicePixelRatio(page)
    await page.keyboard.press(`${MOD}+Shift+Equal`)
    await expect.poll(() => devicePixelRatio(page)).toBeGreaterThan(zoomed)
    await page.keyboard.press(`${MOD}+Minus`)
    await expect.poll(() => devicePixelRatio(page)).toBeCloseTo(zoomed, 5)
    await page.keyboard.press(`${MOD}+Digit0`)
    await expect.poll(() => devicePixelRatio(page)).toBeCloseTo(base, 5)
  })

  test('tab and pane chords act on the tab strip', async ({ page }) => {
    // New tab menu: ⌘T
    const picker = page.locator('[data-slot="picker-content"]')
    await page.keyboard.press(`${MOD}+t`)
    await expect(picker.first()).toBeVisible()
    await expect(picker.first()).toContainText('Inbox Capture')
    await page.keyboard.press('Escape')
    await expect(picker).toHaveCount(0)
    await blur(page)

    await newNoteTab(page)
    await newNoteTab(page)
    const count = await tabs(page).count()
    const last = await activeTabId(page)

    // Previous / next tab: Ctrl+⇧Tab, Ctrl+Tab
    await page.keyboard.press('Control+Shift+Tab')
    await expect.poll(() => activeTabId(page)).not.toBe(last)
    await page.keyboard.press('Control+Tab')
    await expect.poll(() => activeTabId(page)).toBe(last)

    // Back / forward through tab history: ⌘[ ⌘]
    await page.keyboard.press(`${MOD}+BracketLeft`)
    await expect.poll(() => activeTabId(page)).not.toBe(last)
    await page.keyboard.press(`${MOD}+BracketRight`)
    await expect.poll(() => activeTabId(page)).toBe(last)

    // Pin / unpin: ⌘⇧P
    const pinned = page.locator('[role="tab"][data-pinned="true"]:visible')
    await expect(pinned).toHaveCount(0)
    await page.keyboard.press(`${MOD}+Shift+P`)
    await expect(pinned).toHaveCount(1)
    await page.keyboard.press(`${MOD}+Shift+P`)
    await expect(pinned).toHaveCount(0)

    // Duplicate: ⌘⇧D opens a second tab on the same note
    const title = await activeTab(page).first().textContent()
    await page.keyboard.press(`${MOD}+Shift+D`)
    await expect(tabs(page)).toHaveCount(count + 1)
    await expect.poll(() => activeTabId(page)).not.toBe(last)
    await expect(activeTab(page).first()).toHaveText(title ?? '')

    // Close / reopen: ⌘W ⌘⇧T. The duplicate goes first; reopening it would
    // only focus the original, which still shows the same note.
    await page.keyboard.press(`${MOD}+w`)
    await expect(tabs(page)).toHaveCount(count)
    await page.keyboard.press(`${MOD}+w`)
    await expect(tabs(page)).toHaveCount(count - 1)
    await page.keyboard.press(`${MOD}+Shift+T`)
    await expect(tabs(page)).toHaveCount(count)

    // Split right / close split / split down: ⌘\ ⌘⌥W ⌘⇧\
    await expect(panes(page)).toHaveCount(1)
    await page.keyboard.press(`${MOD}+Backslash`)
    await expect(panes(page)).toHaveCount(2)
    await page.keyboard.press(`${MOD}+Alt+w`)
    await expect(panes(page)).toHaveCount(1)
    await page.keyboard.press(`${MOD}+Shift+Backslash`)
    await expect(panes(page)).toHaveCount(2)
    await page.keyboard.press(`${MOD}+Alt+w`)
    await expect(panes(page)).toHaveCount(1)

    // Close all tabs in the pane: ⌘⇧W
    await page.keyboard.press(`${MOD}+Shift+W`)
    await expect.poll(() => tabs(page).count()).toBeLessThan(count)
  })

  for (const surface of ['note editor', 'note title field'] as const) {
    test(`tab, pane and vault chords fire with the caret in the ${surface}`, async ({ page }) => {
      const focusField = async (): Promise<void> => {
        const field =
          surface === 'note editor'
            ? editor(page)
            : page.locator('textarea[aria-label="Note title"]:visible').first()
        await field.click()
        await expect(field).toBeFocused()
      }
      const titleValue = () =>
        page.locator('textarea[aria-label="Note title"]:visible').first().inputValue()

      await newNoteTab(page)
      await newNoteTab(page)
      const count = await tabs(page).count()

      // New tab menu: ⌘T
      await focusField()
      await page.keyboard.press(`${MOD}+t`)
      const picker = page.locator('[data-slot="picker-content"]')
      await expect(picker.first()).toContainText('Inbox Capture')
      await page.keyboard.press('Escape')
      await expect(picker).toHaveCount(0)

      // Switch vault: ⌘⇧O
      await focusField()
      await page.keyboard.press(`${MOD}+Shift+O`)
      await expect(picker.first()).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(picker).toHaveCount(0)

      // Pin / unpin: ⌘⇧P
      const pinned = page.locator('[role="tab"][data-pinned="true"]:visible')
      await focusField()
      await page.keyboard.press(`${MOD}+Shift+P`)
      await expect(pinned).toHaveCount(1)
      await focusField()
      await page.keyboard.press(`${MOD}+Shift+P`)
      await expect(pinned).toHaveCount(0)

      // Previous / next tab: Ctrl+⇧Tab, Ctrl+Tab
      const current = await activeTabId(page)
      await focusField()
      await page.keyboard.press('Control+Shift+Tab')
      await expect.poll(() => activeTabId(page)).not.toBe(current)
      const previous = await activeTabId(page)
      await focusField()
      await page.keyboard.press('Control+Tab')
      await expect.poll(() => activeTabId(page)).toBe(current)

      // Back / forward, one step each: ⌘[ ⌘]
      await focusField()
      await page.keyboard.press(`${MOD}+BracketLeft`)
      await expect.poll(() => activeTabId(page)).toBe(previous)
      await focusField()
      await page.keyboard.press(`${MOD}+BracketRight`)
      await expect.poll(() => activeTabId(page)).toBe(current)

      // Duplicate, then close the duplicate and the original, then reopen:
      // ⌘⇧D ⌘W ⌘W ⌘⇧T
      await focusField()
      await page.keyboard.press(`${MOD}+Shift+D`)
      await expect(tabs(page)).toHaveCount(count + 1)
      await focusField()
      await page.keyboard.press(`${MOD}+w`)
      await expect(tabs(page)).toHaveCount(count)
      await focusField()
      await page.keyboard.press(`${MOD}+w`)
      await expect(tabs(page)).toHaveCount(count - 1)
      // The close may land on Home, which has no field; go back to the other note.
      await tabs(page).filter({ hasText: 'Untitled' }).first().click()
      await focusField()
      await page.keyboard.press(`${MOD}+Shift+T`)
      await expect(tabs(page)).toHaveCount(count)

      // Nothing leaked into either field as typed text.
      await expect.poll(titleValue).toMatch(/^Untitled( \d+)?$/)
      await expect(editor(page)).toHaveText('')

      // Close all tabs in the pane: ⌘⇧W
      await focusField()
      await page.keyboard.press(`${MOD}+Shift+W`)
      await expect.poll(() => tabs(page).count()).toBeLessThan(count)

      // Split right / close split / split down: ⌘\\ ⌘⌥W ⌘⇧\\. A split clones
      // the active tab and keeps focus here, so ⌘⌥W closes this pane.
      await newNoteTab(page)
      await focusField()
      await page.keyboard.press(`${MOD}+Backslash`)
      await expect(panes(page)).toHaveCount(2)
      await focusField()
      await page.keyboard.press(`${MOD}+Alt+w`)
      await expect(panes(page)).toHaveCount(1)
      await focusField()
      await page.keyboard.press(`${MOD}+Shift+Backslash`)
      await expect(panes(page)).toHaveCount(2)
      await focusField()
      await page.keyboard.press(`${MOD}+Alt+w`)
      await expect(panes(page)).toHaveCount(1)
    })
  }

  test('editor formatting chords format the selection', async ({ page }) => {
    await newNoteTab(page)
    await editor(page).click()
    await page.keyboard.type('abc')
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowLeft')
    // ProseMirror adopts the DOM selection on the next selectionchange; wait
    // until its own selection spans all three characters.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const dom = document.querySelector('.ProseMirror') as
            (Element & { editor?: { state: { selection: { from: number; to: number } } } }) | null
          const selection = dom?.editor?.state.selection
          return selection ? selection.to - selection.from : 0
        })
      )
      .toBe(3)

    // One mark at a time: inline code excludes every other mark.
    for (const [chord, tag] of [
      [`${MOD}+b`, 'strong'],
      [`${MOD}+i`, 'em'],
      [`${MOD}+u`, 'u'],
      [`${MOD}+Shift+S`, 's'],
      [`${MOD}+e`, 'code']
    ]) {
      const marked = editor(page).locator(tag).filter({ hasText: 'abc' })
      await page.keyboard.press(chord)
      await expect(marked, chord).toHaveCount(1)
      await page.keyboard.press(chord)
      await expect(marked, chord).toHaveCount(0)
    }
    // ⌘B is Bold inside the editor, never the sidebar toggle.
    await expect(sidebar(page)).toHaveAttribute('data-state', 'expanded')
  })

  test('a rebind from Settings takes over and frees the default chord', async ({
    page,
    electronApp
  }) => {
    await page.keyboard.press(`${MOD}+Comma`)
    const settings = page.getByTestId('settings-view')
    await expect(settings).toBeVisible()
    await page
      .getByTestId('settings-nav')
      .getByRole('button', { name: 'Shortcuts', exact: true })
      .click()

    // While a row records, the app's own shortcuts stand down: ⌘K is reported
    // as a conflict instead of opening search, ⌘W instead of closing a tab.
    const tabsBefore = await tabs(page).count()
    const newNoteRow = settings.locator('.group').filter({ hasText: 'New Note' }).first()
    await newNoteRow.getByTitle('Click to rebind').click()
    await page.keyboard.press(`${MOD}+k`)
    await expect(newNoteRow.getByText('Conflicts with: Search')).toBeVisible()
    await expect(page.locator('[cmdk-input]')).toHaveCount(0)
    await page.keyboard.press(`${MOD}+w`)
    await expect(newNoteRow.getByText('Conflicts with: Close Tab')).toBeVisible()
    await page.waitForTimeout(300)
    await expect(tabs(page)).toHaveCount(tabsBefore)
    await page.keyboard.press('Escape')
    await expect(settings).toBeVisible()

    const row = settings.locator('.group').filter({ hasText: 'Split Right' }).first()
    await row.getByTitle('Click to rebind').click()
    await page.keyboard.press(`${MOD}+Alt+KeyY`)
    await expect(row.getByText('Y', { exact: true })).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)
    await blur(page)

    await page.keyboard.press(`${MOD}+Backslash`)
    await page.waitForTimeout(300)
    await expect(panes(page)).toHaveCount(1)
    await page.keyboard.press(`${MOD}+Alt+KeyY`)
    await expect(panes(page)).toHaveCount(2)
    await page.keyboard.press(`${MOD}+Alt+w`)
    await expect(panes(page)).toHaveCount(1)

    // The help dialog shows the chord that is live, not the default.
    await page.keyboard.press(`${MOD}+Slash`)
    const splitRow = helpDialog(page).locator('div.grid').filter({ hasText: 'Split right' })
    await expect(splitRow.getByText('Y', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await blur(page)

    // Close tab is also a menu item. Rebinding it moves the menu accelerator
    // too, so ⌘W no longer closes the tab through the menu on macOS.
    await page.evaluate(() =>
      window.api.settings.setKeyboardSettings({
        overrides: { 'tabs.closeTab': { key: 'e', modifiers: { meta: true, alt: true } } }
      })
    )
    await expect
      .poll(() =>
        electronApp.evaluate(
          ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('file.closeTab')?.accelerator
        )
      )
      .toBe('CmdOrCtrl+Alt+E')

    await newNoteTab(page)
    const count = await tabs(page).count()
    await page.keyboard.press(`${MOD}+w`)
    await page.waitForTimeout(300)
    await expect(tabs(page)).toHaveCount(count)
    await page.keyboard.press(`${MOD}+Alt+KeyE`)
    await expect(tabs(page)).toHaveCount(count - 1)
  })

  test('adjacent-vault chords page between vaults, each with its own rebinds', async ({ page }) => {
    const firstPath = await page.evaluate(async () => (await window.api.vault.getStatus()).path)
    await page.evaluate(() =>
      window.api.settings.setKeyboardSettings({
        overrides: { 'tabs.splitRight': { key: 'y', modifiers: { meta: true, alt: true } } }
      })
    )

    const secondPath = makeVault('memry-e2e-shortcuts-second-')
    try {
      const created = await page.evaluate(
        (p) => window.api.vault.create(p, 'Shortcuts Second Vault'),
        secondPath
      )
      expect(created.success, created.error).toBe(true)
      await waitForVaultReady(page)
      await expect
        .poll(async () => page.evaluate(async () => (await window.api.vault.getStatus()).path))
        .not.toBe(firstPath)
      await blur(page)

      // The second vault has no rebinds: ⌘\ splits again.
      await page.keyboard.press(`${MOD}+Backslash`)
      await expect(panes(page)).toHaveCount(2)
      await page.keyboard.press(`${MOD}+Alt+w`)
      await expect(panes(page)).toHaveCount(1)

      const adjacent = IS_MAC ? 'Control+Meta' : 'Control+Alt'
      const vaultPath = () => page.evaluate(async () => (await window.api.vault.getStatus()).path)
      const before = await vaultPath()
      await page.keyboard.press(`${adjacent}+ArrowLeft`)
      await expect.poll(vaultPath, { timeout: 20_000 }).not.toBe(before)
      await waitForVaultReady(page)
      await blur(page)
      await page.keyboard.press(`${adjacent}+ArrowRight`)
      await expect.poll(vaultPath, { timeout: 20_000 }).toBe(before)
      await waitForVaultReady(page)
      await blur(page)

      // Back on the second vault, then page to the first: its rebind is live again.
      await page.keyboard.press(`${adjacent}+ArrowLeft`)
      await expect.poll(vaultPath, { timeout: 20_000 }).toBe(firstPath)
      await waitForVaultReady(page)
      await blur(page)
      await page.keyboard.press(`${MOD}+Alt+KeyY`)
      await expect(panes(page)).toHaveCount(2)
    } finally {
      fs.rmSync(secondPath, { recursive: true, force: true })
    }
  })
})
