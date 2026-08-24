/**
 * "Clicking a page opens a new tab" — the preference from issue #1644.
 *
 * The reported complaint is that browsing or creating several pages leaves a
 * tab per page. The machine to reuse a tab already existed in the reducer and
 * was wired to nothing, so this runs against the real app: a unit test on the
 * reducer cannot tell whether the sidebar actually passes the option, which is
 * exactly the gap that left the feature dark in the first place.
 *
 * The preference is deliberately narrow: it changes what a *plain* click does.
 * "Open in New Tab" and a pinned tab must survive it untouched.
 */

import type { Page } from '@playwright/test'

import { test, expect } from './fixtures'
import { ready } from './utils/desktop-test-helpers'
import { SELECTORS, tabSessionStorageKey } from './utils/electron-helpers'

const tabs = (page: Page) => page.locator(SELECTORS.tab)
const treeRow = (page: Page, nodeId: string) => page.locator(`[data-tree-node-id="${nodeId}"]`)

async function setOpenPagesInNewTab(page: Page, enabled: boolean): Promise<void> {
  const result = await page.evaluate(
    (value) => window.api.settings.setGeneralSettings({ openPagesInNewTab: value }),
    enabled
  )
  expect(result.success).toBe(true)
  // The renderer picks the value up over the settings-changed broadcast; the
  // sidebar reads it out of the hook, so wait for it rather than racing it.
  await expect
    .poll(async () =>
      page.evaluate(async () => (await window.api.settings.getGeneralSettings()).openPagesInNewTab)
    )
    .toBe(enabled)
  await page.waitForTimeout(300)
}

/** Seed notes at the vault root and hand back their ids, in order. */
async function seedNotes(page: Page, titles: string[]): Promise<string[]> {
  const ids = await page.evaluate(async (noteTitles) => {
    const created: string[] = []
    for (const title of noteTitles) {
      const result = await window.api.notes.create({ title, content: `${title} body` })
      if (!result?.note) throw new Error(`notes.create returned no note for "${title}"`)
      created.push(result.note.id)
    }
    return created
  }, titles)

  expect(ids).toHaveLength(titles.length)
  return ids
}

/** The Collections section ships collapsed on a fresh profile (#625 tour). */
async function openCollections(page: Page): Promise<void> {
  const header = page.getByRole('button', { name: /^Collections section/ })
  await header.waitFor({ state: 'visible', timeout: 20_000 })
  if ((await header.getAttribute('aria-expanded')) !== 'true') {
    await header.click()
  }
  await expect(header).toHaveAttribute('aria-expanded', 'true')
}

async function clickNoteRow(page: Page, noteId: string, title: string): Promise<void> {
  const row = treeRow(page, noteId)
  await row.waitFor({ state: 'visible', timeout: 15_000 })
  await row.click()
  await expect(page.locator(SELECTORS.activeTab)).toContainText(title, { timeout: 10_000 })
}

test.describe('Clicking a page reuses the current tab (#1644)', () => {
  test.beforeEach(async ({ page }) => {
    await ready(page)
    await openCollections(page)
  })

  test('off: browsing many pages leaves the tab count where it started', async ({ page }) => {
    const titles = ['Reuse Alpha', 'Reuse Bravo', 'Reuse Charlie', 'Reuse Delta']
    const ids = await seedNotes(page, titles)

    await setOpenPagesInNewTab(page, false)

    // The first click is the one that turns the launch tab into a page; from
    // there the count must not move no matter how many pages are visited.
    await clickNoteRow(page, ids[0], titles[0])
    const afterFirst = await tabs(page).count()

    for (let i = 1; i < ids.length; i++) {
      await clickNoteRow(page, ids[i], titles[i])
      expect(await tabs(page).count()).toBe(afterFirst)
    }

    await expect(page.locator(SELECTORS.activeTab)).toContainText(titles[titles.length - 1])
  })

  test('on (default): every page click adds a tab', async ({ page }) => {
    const titles = ['Fresh Alpha', 'Fresh Bravo', 'Fresh Charlie']
    const ids = await seedNotes(page, titles)

    await setOpenPagesInNewTab(page, true)

    await clickNoteRow(page, ids[0], titles[0])
    const afterFirst = await tabs(page).count()

    await clickNoteRow(page, ids[1], titles[1])
    expect(await tabs(page).count()).toBe(afterFirst + 1)

    await clickNoteRow(page, ids[2], titles[2])
    expect(await tabs(page).count()).toBe(afterFirst + 2)
  })

  test('off: a pinned tab is never replaced', async ({ page }) => {
    const titles = ['Pinned Anchor', 'Passerby One', 'Passerby Two']
    const ids = await seedNotes(page, titles)

    await setOpenPagesInNewTab(page, false)

    // The tab context menu is a native OS menu, which Playwright cannot drive,
    // so the pinned tab is seeded through the session Memry restores on start —
    // the same shape persistence writes.
    const storageKey = await tabSessionStorageKey(page)
    await page.addInitScript(
      ({ noteId, title, storageKey }) => {
        localStorage.setItem(
          storageKey,
          JSON.stringify({
            version: 2,
            tabGroups: {
              g1: {
                id: 'g1',
                activeTabId: 'anchor-tab',
                tabs: [
                  {
                    id: 'anchor-tab',
                    type: 'note',
                    title,
                    icon: 'file-text',
                    path: `/notes/${noteId}`,
                    entityId: noteId,
                    isPinned: true
                  }
                ]
              }
            },
            layout: { type: 'leaf', tabGroupId: 'g1' },
            activeGroupId: 'g1',
            settings: { restoreSessionOnStart: true, tabCloseButton: 'hover' },
            savedAt: Date.now()
          })
        )
      },
      { noteId: ids[0], title: titles[0], storageKey }
    )
    await page.reload()
    await ready(page)
    await openCollections(page)

    const anchor = page.locator(`${SELECTORS.tab}[data-pinned="true"][data-tab-id="anchor-tab"]`)
    await expect(anchor).toHaveCount(1)

    // The pinned tab is the active one, so this click has to fall through to a
    // new tab rather than reuse it.
    await clickNoteRow(page, ids[1], titles[1])
    await clickNoteRow(page, ids[2], titles[2])

    // The pinned page survived both visits, and the two passers-by shared one
    // tab between them rather than each minting their own.
    await expect(anchor).toHaveCount(1)
    await expect(page.locator(`${SELECTORS.tab}:has-text("${titles[1]}")`)).toHaveCount(0)
    await expect(page.locator(`${SELECTORS.tab}:has-text("${titles[2]}")`)).toHaveCount(1)
  })

  test('off: "Open in New Tab" still opens a new tab', async ({ page }) => {
    const titles = ['Intent Alpha', 'Intent Bravo']
    const ids = await seedNotes(page, titles)

    await setOpenPagesInNewTab(page, false)

    await clickNoteRow(page, ids[0], titles[0])
    const before = await tabs(page).count()

    await treeRow(page, ids[1]).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Open in New Tab' }).click()
    await expect(page.locator(SELECTORS.activeTab)).toContainText(titles[1], { timeout: 10_000 })

    expect(await tabs(page).count()).toBe(before + 1)
    await expect(page.locator(`${SELECTORS.tab}:has-text("${titles[0]}")`)).toHaveCount(1)
  })

  test('off: sidebar section click reuses; middle-click still opens a background tab', async ({
    page
  }) => {
    const titles = ['Nav Reuse Anchor']
    const ids = await seedNotes(page, titles)

    await setOpenPagesInNewTab(page, false)

    await clickNoteRow(page, ids[0], titles[0])
    const count = await tabs(page).count()

    // A singleton section (Tasks) with no tab open yet: the plain click obeys
    // the preference and takes over the current tab.
    const tasksNav = page.locator('[data-tour="nav-tasks"]')
    await tasksNav.click()
    await expect(page.locator(SELECTORS.activeTab)).toContainText('Tasks', { timeout: 10_000 })
    expect(await tabs(page).count()).toBe(count)

    // Middle-click is an explicit gesture: a genuinely new background copy,
    // preference notwithstanding.
    await tasksNav.click({ button: 'middle' })
    await expect.poll(async () => tabs(page).count(), { timeout: 10_000 }).toBe(count + 1)
    // Focus stayed on the tab we were on.
    await expect(page.locator(SELECTORS.activeTab)).toContainText('Tasks')
  })

  test('singletons duplicate through "Open in New Tab" in the nav context menu', async ({
    page
  }) => {
    await setOpenPagesInNewTab(page, true)

    const inboxNav = page.locator('[data-tour="nav-inbox"]')
    await inboxNav.click()
    const inboxTabs = page.locator(`${SELECTORS.tab}:has-text("Inbox")`)
    await expect(inboxTabs).toHaveCount(1)

    // Plain re-click keeps focusing the existing copy.
    await inboxNav.click()
    await expect(inboxTabs).toHaveCount(1)

    // The context-menu command mints a real second copy (#1644 un-gated it).
    await inboxNav.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Open in New Tab' }).click()
    await expect(inboxTabs).toHaveCount(2)
  })

  test('off: middle-click on a note row opens a background tab', async ({ page }) => {
    const titles = ['Middle Anchor', 'Middle Target']
    const ids = await seedNotes(page, titles)

    await setOpenPagesInNewTab(page, false)

    await clickNoteRow(page, ids[0], titles[0])
    const count = await tabs(page).count()

    await treeRow(page, ids[1]).click({ button: 'middle' })
    await expect.poll(async () => tabs(page).count(), { timeout: 10_000 }).toBe(count + 1)
    // The anchor keeps focus; the target arrived in the background.
    await expect(page.locator(SELECTORS.activeTab)).toContainText(titles[0])
    await expect(page.locator(`${SELECTORS.tab}:has-text("${titles[1]}")`)).toHaveCount(1)
  })
})
