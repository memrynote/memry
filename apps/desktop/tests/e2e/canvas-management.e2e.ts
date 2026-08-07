// @ts-nocheck - E2E tests in development, follow notes.e2e.ts convention
/**
 * Canvas management — the sidebar folder tree, end to end.
 *
 * One journey, in the order a user would take it: create a root-level folder,
 * create a canvas inside it, rename it, duplicate it, drag the original out to
 * the root, delete it with confirmation, reload, and assert the tree survived.
 *
 * Two things this suite has to work around:
 *
 * 1. The onboarding tour covers the sidebar on a first launch. `ready()` (via
 *    `dismissFirstRunOnboarding`) is what clears it; every navigation that
 *    reloads has to run it again.
 * 2. Drag and drop is native HTML5. Playwright's `dragTo` drives a mouse, which
 *    Chromium does NOT turn into a real drag data store here, so the drag is
 *    dispatched as events carrying a shared `DataTransfer` — the same shape the
 *    other canvas specs use for drops onto the canvas surface.
 *
 * Placement is asserted through `window.api.canvas.list()` / `canvasFolder.list()`
 * rather than through row text: the folder of a canvas is the thing under test,
 * and the API is where it is actually stored.
 */
import { test, expect, type Page } from './fixtures'
import { ready } from './utils/desktop-test-helpers'

const CANVAS_DRAG_MIME = 'application/x-memry-canvas'

/**
 * A cold first launch opens the vault slowly (embedding-model init can take
 * ~30s), exceeding waitForVaultReady's internal 15s fallback — wait for the
 * sidebar to appear before ready() runs its onboarding dismissal.
 */
async function openVault(page: Page): Promise<void> {
  await page
    .locator('aside, [data-testid="sidebar"], [class*="sidebar"], nav')
    .first()
    .waitFor({ state: 'visible', timeout: 90_000 })
  await ready(page)
}

/** The CANVASES section header button, whatever its expanded state. */
function sectionHeader(page: Page) {
  return page.getByRole('button', { name: /Canvases section/ })
}

/** Expands the CANVASES section if it is collapsed, and leaves it expanded. */
async function expandCanvasSection(page: Page): Promise<void> {
  const header = sectionHeader(page)
  await expect(header).toBeVisible({ timeout: 30_000 })
  if ((await header.getAttribute('aria-expanded')) !== 'true') {
    await header.click()
  }
  await expect(header).toHaveAttribute('aria-expanded', 'true')
}

function row(page: Page, key: string) {
  return page.locator(`[data-testid="canvas-tree-row"][data-row-key="${key}"]`)
}

/** Opens a row's "⋯" menu and clicks one item by its visible label. */
async function rowAction(page: Page, key: string, label: string | RegExp): Promise<void> {
  const target = row(page, key)
  await expect(target).toBeVisible()
  await target.hover()
  await target.locator('[data-testid="canvas-row-actions"]').click()
  const menu = page.locator('[data-testid="canvas-row-actions-menu"]')
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: label, exact: typeof label === 'string' }).click()
  await expect(menu).toHaveCount(0)
}

/** Types a name into the tree's shared name dialog and saves it. */
async function submitNameDialog(page: Page, title: RegExp, value: string): Promise<void> {
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText(title)).toBeVisible()
  const input = dialog.locator('input')
  await input.fill(value)
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

async function listCanvases(page: Page) {
  return page.evaluate(async () => (await window.api.canvas.list()).canvases)
}

async function listFolders(page: Page) {
  return page.evaluate(async () => window.api.canvasFolder.list())
}

/**
 * A native HTML5 drag, dispatched rather than mimed.
 *
 * All three events share ONE DataTransfer, because the drop handler re-reads
 * the payload from the transfer it is finally handed; a fresh one per event
 * would arrive empty and the drop would be refused.
 */
async function dragRowOnto(page: Page, rowKey: string, targetSelector: string): Promise<void> {
  await page.evaluate(
    ({ rowKey: key, targetSelector: target, mime }) => {
      const source = document.querySelector(`[data-row-key="${key}"]`)
      const destination = document.querySelector(target)
      if (!source || !destination) throw new Error(`drag endpoints missing: ${key} → ${target}`)

      const transfer = new DataTransfer()
      const fire = (node: Element, type: string): void => {
        const event = new DragEvent(type, { bubbles: true, cancelable: true })
        Object.defineProperty(event, 'dataTransfer', { value: transfer })
        node.dispatchEvent(event)
      }

      fire(source, 'dragstart')
      // Proves the payload was written under our own MIME type; without it the
      // drop below would be a silent no-op and the test would still "pass".
      if (!transfer.types.includes(mime)) throw new Error('dragstart wrote no canvas payload')
      fire(destination, 'dragover')
      fire(destination, 'drop')
      fire(source, 'dragend')
    },
    { rowKey, targetSelector, mime: CANVAS_DRAG_MIME }
  )
}

test.describe('Canvas management — folders, placement and row actions', () => {
  // The journey boots the app twice (initial + the persistence reload) at ~25s
  // per boot, and drives a dozen dialogs in between; 60s is far too short.
  test.describe.configure({ timeout: 300_000 })

  test('folder → canvas → rename → duplicate → move to root → delete → reload', async ({
    page
  }) => {
    await openVault(page)
    await expandCanvasSection(page)

    // ---------------------------------------------------------------- folder
    // Root-level folders have no parent row to right-click, so the section
    // header's own button is the only way to make the first one.
    const header = sectionHeader(page)
    await header.hover()
    await page.getByRole('button', { name: 'New canvas folder', exact: true }).click()
    await submitNameDialog(page, /New canvas folder/, 'Work')

    await expect(row(page, 'folder:Work')).toBeVisible()
    await expect.poll(async () => (await listFolders(page)).folders.length).toBe(1)

    // ---------------------------------------------------------------- canvas
    await rowAction(page, 'folder:Work', 'New canvas here')
    await expect(page.locator('[data-canvas-editor]')).toBeVisible({ timeout: 30_000 })

    await expect.poll(async () => (await listCanvases(page)).length).toBe(1)
    const created = (await listCanvases(page))[0]
    expect(created.folder).toBe('Work')

    // Creating into a folder expands it, so the new row is on screen.
    const canvasKey = `canvas:${created.id}`
    await expect(row(page, canvasKey)).toBeVisible()

    // ---------------------------------------------------------------- rename
    await rowAction(page, canvasKey, 'Rename')
    await submitNameDialog(page, /Rename canvas/, 'Plan')
    await expect
      .poll(async () => (await listCanvases(page)).find((c) => c.id === created.id)?.title)
      .toBe('Plan')

    // ------------------------------------------------------------- duplicate
    await rowAction(page, canvasKey, 'Duplicate')
    await expect.poll(async () => (await listCanvases(page)).length).toBe(2)

    const duplicate = (await listCanvases(page)).find((c) => c.id !== created.id)
    expect(duplicate).toBeTruthy()
    // A duplicate lands beside its original, not at the root.
    expect(duplicate.folder).toBe('Work')
    await expect(row(page, `canvas:${duplicate.id}`)).toBeVisible()

    // ---------------------------------------------------------- drag to root
    await dragRowOnto(page, canvasKey, '[data-testid="canvas-tree-root-drop"]')
    await expect
      .poll(async () => (await listCanvases(page)).find((c) => c.id === created.id)?.folder ?? null)
      .toBeNull()
    // The one that did not move stayed put.
    expect((await listCanvases(page)).find((c) => c.id === duplicate.id).folder).toBe('Work')

    // ---------------------------------------------------------------- delete
    await rowAction(page, canvasKey, 'Delete')
    const confirm = page.getByRole('alertdialog')
    await expect(confirm.getByText(/Delete this canvas\?/)).toBeVisible()
    await expect(confirm.getByText(/"Plan"/)).toBeVisible()
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click()

    await expect.poll(async () => (await listCanvases(page)).length).toBe(1)
    await expect(row(page, canvasKey)).toHaveCount(0)

    // ---------------------------------------------------------------- reload
    await page.reload()
    await openVault(page)
    await expandCanvasSection(page)

    const folders = await listFolders(page)
    expect(folders.folders.map((folder) => folder.path)).toEqual(['Work'])

    const survivors = await listCanvases(page)
    expect(survivors).toHaveLength(1)
    expect(survivors[0].id).toBe(duplicate.id)
    expect(survivors[0].folder).toBe('Work')

    // The tree redraws from disk + db. Which folders were open is remembered
    // across restarts, so `Work` comes back expanded and its one canvas is on
    // screen without another click — the deleted one is not.
    const folderRow = row(page, 'folder:Work')
    const duplicateRow = row(page, `canvas:${duplicate.id}`)
    await expect(folderRow).toBeVisible()
    await expect(duplicateRow).toBeVisible()
    await expect(row(page, canvasKey)).toHaveCount(0)

    // And the folder still opens and closes.
    await folderRow.click()
    await expect(duplicateRow).toHaveCount(0)
    await folderRow.click()
    await expect(duplicateRow).toBeVisible()
  })
})
