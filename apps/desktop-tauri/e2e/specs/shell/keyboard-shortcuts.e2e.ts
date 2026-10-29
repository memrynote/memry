// Keyboard shortcuts and the native menu bridge (inv09 #11 #12). WebDriver can press neither a
// native menu item nor its key equivalent, so a spec runs an item with `e2e_menu_activate` and a
// chord as a key event in the page. The chords of the notes, tabs and editor are covered by the
// steps that port those views.
import { appReady } from '../../harness/app-ready'
import { invokeTest } from '../../harness/invoke-test'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

interface MenuNode {
  id: string | null
  label: string
  accelerator: string | null
  children: MenuNode[]
}

const palette = (page: Page) => page.locator('[cmdk-input]')
const settingsView = (page: Page) => page.getByTestId('settings-view')
const helpDialog = (page: Page) => page.getByRole('dialog', { name: 'Keyboard Shortcuts' })
const sidebar = (page: Page) => page.locator('[data-slot="sidebar"][data-side="left"]')

/** The app zoom the renderer saved, which it also hands to `app_set_zoom_factor`. */
async function zoomFactor(page: Page): Promise<number> {
  const general = await invoke<{ zoomFactor?: number }>(page, 'settings_get_group', {
    group: 'general'
  })
  return general.zoomFactor ?? 1
}

function findItem(nodes: MenuNode[], id: string): MenuNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node
    const inner = findItem(node.children, id)
    if (inner) return inner
  }
  return undefined
}

/** Moves the focus off any field: app chords stand down while one has it. */
async function blur(page: Page): Promise<void> {
  await page.evaluate(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
  })
}

/** Runs `open`, waits for `shown`, then closes it with Escape. */
async function opensAndCloses(
  page: Page,
  open: () => Promise<unknown>,
  shown: ReturnType<Page['locator']>
): Promise<void> {
  await open()
  await expect(shown).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(shown).toHaveCount(0)
  await blur(page)
}

test('a menu item runs its command in the page', async ({ app, page }) => {
  await appReady(page)
  await blur(page)
  const activate = (id: string) => () => invokeTest(app, 'e2e_menu_activate', { id })

  await opensAndCloses(page, activate('nav.search'), palette(page))
  await opensAndCloses(page, activate('nav.commands'), palette(page))
  await opensAndCloses(page, activate('nav.settings'), settingsView(page))
  await opensAndCloses(page, activate('view.shortcuts'), helpDialog(page))

  await expect(sidebar(page)).toHaveAttribute('data-state', 'expanded')
  await activate('view.toggleSidebar')()
  await expect(sidebar(page)).toHaveAttribute('data-state', 'collapsed')
  await activate('view.toggleSidebar')()
  await expect(sidebar(page)).toHaveAttribute('data-state', 'expanded')

  await activate('view.zoomIn')()
  await expect.poll(() => zoomFactor(page)).toBeGreaterThan(1)
  await activate('view.actualSize')()
  await expect.poll(() => zoomFactor(page)).toBe(1)
})

test('a chord pressed in the page runs the same command', async ({ page }) => {
  await appReady(page)
  await blur(page)
  const press = (chord: string) => () => page.keyboard.press(chord)

  await opensAndCloses(page, press(`${MOD}+k`), palette(page))
  await opensAndCloses(page, press(`${MOD}+p`), palette(page))
  await opensAndCloses(page, press(`${MOD}+,`), settingsView(page))
  await opensAndCloses(page, press(`${MOD}+/`), helpDialog(page))

  await page.keyboard.press(`${MOD}+b`)
  await expect(sidebar(page)).toHaveAttribute('data-state', 'collapsed')
  await page.keyboard.press(`${MOD}+b`)
  await expect(sidebar(page)).toHaveAttribute('data-state', 'expanded')

  await page.keyboard.press(`${MOD}+=`)
  await expect.poll(() => zoomFactor(page)).toBeGreaterThan(1)
  await page.keyboard.press(`${MOD}+0`)
  await expect.poll(() => zoomFactor(page)).toBe(1)
})

test('a rebind moves the menu shortcut and the page chord', async ({ app, page }) => {
  await appReady(page)
  const zoomIn = async () =>
    findItem(await invokeTest<MenuNode[]>(app, 'e2e_menu_tree'), 'view.zoomIn')
  const before = await zoomIn()
  if (process.platform === 'darwin') expect(before?.accelerator).toBe('CmdOrCtrl+=')
  else expect(before?.label).toBe('Zoom In\tCtrl+=')

  await invoke(page, 'settings_set_group', {
    group: 'keyboard',
    patch: { overrides: { 'view.zoomIn': { key: 'e', modifiers: { meta: true, alt: true } } } }
  })
  // macOS holds a live key equivalent; Windows and Linux show the shortcut in the label only, so
  // the editor keeps its keys.
  if (process.platform === 'darwin') {
    await expect.poll(async () => (await zoomIn())?.accelerator).toBe('CmdOrCtrl+Alt+E')
  } else {
    await expect.poll(async () => (await zoomIn())?.label).toBe('Zoom In\tCtrl+Alt+E')
    expect((await zoomIn())?.accelerator).toBeNull()
  }

  await blur(page)
  await page.keyboard.press(`${MOD}+=`)
  await page.waitForTimeout(300)
  expect(await zoomFactor(page)).toBe(1)
  await page.keyboard.press(`${MOD}+Alt+e`)
  await expect.poll(() => zoomFactor(page)).toBeGreaterThan(1)
})
