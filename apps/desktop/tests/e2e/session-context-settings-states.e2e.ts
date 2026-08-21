import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { MOD, ready, uniqueLabel } from './utils/desktop-test-helpers'
import { createNote, navigateTo, SELECTORS, showAllTasksScope } from './utils/electron-helpers'

async function tabTitles(page: Page): Promise<string[]> {
  return page
    .locator(SELECTORS.tab)
    .evaluateAll((tabs) => tabs.map((tab) => tab.textContent?.trim() ?? ''))
}

async function activeTabTitle(page: Page): Promise<string> {
  return page
    .locator(SELECTORS.activeTab)
    .first()
    .textContent()
    .then((text) => text?.trim() ?? '')
}

async function createSecondaryWindow(electronApp: ElectronApplication): Promise<Page> {
  const windowPromise = electronApp.waitForEvent('window')
  await electronApp.evaluate(async () => {
    const hooks = (
      globalThis as typeof globalThis & {
        __memryTestHooks?: { createSecondaryWindowForE2E(): Promise<number> }
      }
    ).__memryTestHooks
    if (!hooks) throw new Error('Memry test hooks are not registered')
    await hooks.createSecondaryWindowForE2E()
  })

  const page = await windowPromise
  await ready(page)
  return page
}

async function openSettingsSection(page: Page, section: string): Promise<void> {
  await page.evaluate((requestedSection) => {
    window.api.quickCapture.openSettings(requestedSection)
  }, section)
  await expect(page.getByRole('dialog')).toBeVisible()
}

async function openNoteTabs(page: Page, titles: string[]): Promise<void> {
  const notes = await page.evaluate(async (noteTitles) => {
    const created: Array<{ id: string; title: string }> = []
    for (const title of noteTitles) {
      const result = await window.api.notes.create({ title, content: `Body for ${title}` })
      if (!result.success || !result.note) {
        throw new Error(result.error ?? 'failed to create note')
      }
      created.push({ id: result.note.id, title: result.note.title })
    }
    return created
  }, titles)

  for (const note of notes) {
    await page.evaluate((detail) => {
      window.dispatchEvent(new CustomEvent('memry:test-open-note', { detail }))
    }, note)
  }
}

async function openTreeContextMenu(target: Locator): Promise<void> {
  await target.evaluate((element) => {
    element.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, buttons: 2 })
    )
  })
}

async function getFolderPaths(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const folders = (await window.api.notes.getFolders()) as Array<string | { path: string }>
    return folders.map((folder) => (typeof folder === 'string' ? folder : folder.path))
  })
}

test.describe('Session, context menu, settings, shortcuts, and state E2E', () => {
  test.beforeEach(async ({ page }) => {
    await ready(page)
  })

  test('restores tab session after reload and supports a second app window', async ({
    electronApp,
    page
  }) => {
    const titles = [uniqueLabel('Session One'), uniqueLabel('Session Two')]
    await openNoteTabs(page, titles)

    await expect
      .poll(() => tabTitles(page))
      .toEqual(expect.arrayContaining(titles.map((title) => expect.stringContaining(title))))

    await page.reload()
    await ready(page)

    await expect
      .poll(() => tabTitles(page))
      .toEqual(expect.arrayContaining(titles.map((title) => expect.stringContaining(title))))

    const secondPage = await createSecondaryWindow(electronApp)
    await expect(secondPage.locator(SELECTORS.tabBar).first()).toBeVisible()
    await navigateTo(secondPage, 'inbox')
    await expect(secondPage.locator(SELECTORS.activeTab).first()).toContainText('Inbox')
  })

  test('handles native tab context menu action and notes tree note/folder actions', async ({
    electronApp,
    page
  }) => {
    const titles = [uniqueLabel('Tab Context One'), uniqueLabel('Tab Context Two')]
    const folderPath = uniqueLabel('Folder Context')
    await openNoteTabs(page, titles)
    await page.evaluate((path) => window.api.notes.createFolder(path), folderPath)
    await page.reload()
    await ready(page)

    await electronApp.evaluate(() => {
      ;(
        globalThis as typeof globalThis & {
          __memryNextContextMenuSelection?: string | null
          __memryLastContextMenuItems?: Array<{ id: string }>
        }
      ).__memryNextContextMenuSelection = 'close-others'
    })

    const countBefore = await page.locator(SELECTORS.tab).count()
    expect(countBefore).toBeGreaterThan(1)
    await page.locator(SELECTORS.tab).first().click({ button: 'right' })

    await expect.poll(() => page.locator(SELECTORS.tab).count()).toBe(1)
    await expect
      .poll(() =>
        electronApp.evaluate(() =>
          (
            (
              globalThis as typeof globalThis & {
                __memryLastContextMenuItems?: Array<{ id: string }>
              }
            ).__memryLastContextMenuItems ?? []
          ).map((item) => item.id)
        )
      )
      .toContain('close-others')

    const treeNode = page.locator('[data-tree-node-id]').filter({ hasText: titles[0] }).first()
    await expect(treeNode).toBeVisible()
    await openTreeContextMenu(treeNode)
    await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible()
    await page.getByRole('menuitem', { name: /^Delete$/ }).click()
    await expect(page.getByRole('alertdialog')).toBeVisible()
    await page.getByRole('button', { name: /^Delete$/ }).click()
    await expect
      .poll(async () =>
        page.evaluate(async (title) => {
          const result = await window.api.notes.list({ limit: 1000 })
          return result.notes.some((note) => note.title === title)
        }, titles[0])
      )
      .toBe(false)

    const folderNode = page.locator(`[data-tree-node-id="folder-${folderPath}"]`).first()
    await expect(folderNode).toBeVisible()
    await openTreeContextMenu(folderNode)
    await expect(page.getByRole('menuitem', { name: /^New Folder$/ })).toBeVisible()
    await page.getByRole('menuitem', { name: /^New Folder$/ }).click()
    await expect.poll(() => getFolderPaths(page)).toContain(`${folderPath}/Untitled Folder`)

    await openTreeContextMenu(folderNode)
    await page.getByRole('menuitem', { name: /^Delete$/ }).click()
    await expect(page.getByRole('alertdialog')).toBeVisible()
    await page.getByRole('button', { name: /^Delete$/ }).click()
    await expect.poll(() => getFolderPaths(page)).not.toContain(folderPath)
  })

  test('renders Account, Calendar OAuth, AI, Templates, and Shortcuts settings panels', async ({
    page
  }) => {
    await openSettingsSection(page, 'account')
    await expect(page.getByText('Set up Sync')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible()

    await openSettingsSection(page, 'calendar')
    await expect(page.getByRole('heading', { name: 'Calendar', exact: true })).toBeVisible()
    await expect(page.getByText('Default behavior')).toBeVisible()

    await openSettingsSection(page, 'ai')
    await expect(page.getByRole('heading', { name: 'AI Assistant' })).toBeVisible()
    await expect(page.getByText('Inline AI Editing')).toBeVisible()

    await openSettingsSection(page, 'templates')
    await expect(page.getByRole('heading', { name: 'Templates' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'New Template' })).toBeVisible()

    await openSettingsSection(page, 'shortcuts')
    await expect(page.getByRole('heading', { name: 'Keyboard Shortcuts' })).toBeVisible()
    await expect(page.getByPlaceholder('Search shortcuts...')).toBeVisible()
  })

  test('opens keyboard help and command palette shortcuts in different contexts', async ({
    page
  }) => {
    await page.keyboard.press('?')
    await expect(page.getByRole('dialog').filter({ hasText: 'Keyboard Shortcuts' })).toBeVisible()
    await page.keyboard.press('Escape')

    await page.keyboard.press(`${MOD}+k`)
    const searchInput = page.locator('[cmdk-input], input[placeholder*="Search"]').first()
    await expect(searchInput).toBeVisible()
    await page.keyboard.press('Escape')

    await createNote(page, uniqueLabel('Shortcut Context'), 'typing target')
    await page.locator(SELECTORS.noteEditor).first().click()
    await page.keyboard.press(`${MOD}+k`)
    await expect(searchInput).toBeVisible()
  })

  test('round-trips tab activation history with keyboard and mouse navigation', async ({
    page
  }) => {
    const titles = [
      uniqueLabel('History One'),
      uniqueLabel('History Two'),
      uniqueLabel('History Three')
    ]
    await openNoteTabs(page, titles)

    for (const title of titles) {
      await page.locator(SELECTORS.tab).filter({ hasText: title }).first().click()
      await expect.poll(() => activeTabTitle(page)).toContain(title)
    }

    await page.keyboard.press(`${MOD}+[`)
    await expect.poll(() => activeTabTitle(page)).toContain(titles[1])
    await page.keyboard.press(`${MOD}+[`)
    await expect.poll(() => activeTabTitle(page)).toContain(titles[0])
    await page.keyboard.press(`${MOD}+]`)
    await expect.poll(() => activeTabTitle(page)).toContain(titles[1])

    await page.evaluate(() => {
      window.dispatchEvent(new MouseEvent('mousedown', { button: 3, bubbles: true }))
    })
    await expect.poll(() => activeTabTitle(page)).toContain(titles[0])

    await page.evaluate(() => {
      window.dispatchEvent(new MouseEvent('mousedown', { button: 4, bubbles: true }))
    })
    await expect.poll(() => activeTabTitle(page)).toContain(titles[1])
  })

  test('shows empty states for notes, inbox, tasks, calendar, and folder view', async ({
    page
  }) => {
    await navigateTo(page, 'notes')
    await expect(page.getByText('No notes yet')).toBeVisible()

    await navigateTo(page, 'inbox')
    await expect(page.getByText('Inbox Zero')).toBeVisible()

    await navigateTo(page, 'tasks')
    await showAllTasksScope(page)
    await expect(page.getByText('No tasks yet')).toBeVisible()

    await page
      .locator('button:has-text("Calendar"), a:has-text("Calendar"), span:text("Calendar")')
      .first()
      .click()
    await expect(page.locator('[data-testid="calendar-page"]')).toBeVisible()
    await expect(page.locator('[data-testid="calendar-view"] [data-visual-type]')).toHaveCount(0)

    await page.evaluate(() => window.api.notes.createFolder('E2E Empty Folder'))
    await page.reload()
    await ready(page)
    const folderNode = page.locator('[data-tree-node-id="folder-E2E Empty Folder"]').first()
    await expect(folderNode).toBeVisible()
    await page.evaluate((folderPath) => {
      window.dispatchEvent(
        new CustomEvent('memry:test-open-folder', {
          detail: { path: folderPath, title: folderPath }
        })
      )
    }, 'E2E Empty Folder')
    await expect(page.getByText('No notes in this folder')).toBeVisible()
  })
})
