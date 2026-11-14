// The sidebar's mixed manual order and its note-folder pairs (#4412, Electron `437a9da8b1`,
// `b2bf258ac2`, `32cd745cb5`). In Manual sort a folder dropped between two notes stays there,
// saved by one `notes_reorder` that holds the folder's path among the notes' paths, and the
// order holds across a restart. `Recipes.md` beside `Recipes/` is one row: renaming the row
// renames both on disk, and deleting it removes both.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { expandCollections } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { restart } from '../../harness/tauri-lifecycle'
import { test, expect } from '../../harness/test'
import { invoke, vaultStatus } from '../../harness/vault-commands'
import { pollUntil } from '../../harness/wait'

const row = (page: Page, nodeId: string) => page.locator(`[data-tree-node-id="${nodeId}"]`)

async function ready(page: Page): Promise<void> {
  expect(await pollUntil(async () => (await vaultStatus(page)).isOpen, { timeoutMs: 30_000 })).toBe(
    true
  )
}

function write(vault: string, rel: string, title: string): void {
  const file = join(vault, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `---\ntitle: ${title}\n---\n\nfiller\n`)
}

/** Opens Collections and expands `folders`, outermost first, until each says it is open. */
async function expand(page: Page, folders: string[]): Promise<void> {
  await expandCollections(page)
  for (const folder of folders) {
    const node = row(page, `folder-${folder}`)
    await expect(node).toBeVisible({ timeout: 30_000 })
    const open = async () => {
      if (await node.getByRole('button', { name: 'Collapse folder' }).isVisible()) return true
      const toggle = node.getByRole('button', { name: 'Expand folder' })
      if (await toggle.isVisible()) await toggle.click()
      return false
    }
    expect(await pollUntil(open, { timeoutMs: 15_000, intervalMs: 300 })).toBe(true)
  }
}

/**
 * Drags row `fromId` to the lower edge of row `toId` ("after") with the HTML5 drag events the
 * tree listens to; WebDriver pointer actions do not start the webview's native drag (see
 * `sidebar-folder-drag.e2e.ts`).
 */
async function dropAfter(page: Page, fromId: string, toId: string): Promise<void> {
  await page.evaluate(
    ({ from, to }: { from: string; to: string }) => {
      const node = (id: string) => {
        const found = document.querySelector(`[data-tree-node-id="${id}"]`)
        if (!found) throw new Error(`no row ${id}`)
        return found.querySelector(':scope > [role="treeitem"]') ?? found
      }
      const store = new Map<string, string>()
      const dataTransfer = {
        effectAllowed: 'all',
        dropEffect: 'none',
        files: [],
        items: [],
        get types() {
          return [...store.keys()]
        },
        setData: (type: string, value: string) => store.set(type, value),
        getData: (type: string) => store.get(type) ?? '',
        clearData: () => store.clear(),
        setDragImage: () => {}
      }
      const fire = (element: Element, type: string, nearBottom: boolean) => {
        const rect = element.getBoundingClientRect()
        const event = new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 60,
          clientY: nearBottom ? rect.bottom - 2 : rect.top + rect.height / 2
        })
        Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
        element.dispatchEvent(event)
      }
      const [source, target] = [node(from), node(to)]
      fire(source, 'dragstart', false)
      fire(target, 'dragenter', true)
      fire(target, 'dragover', true)
      fire(target, 'drop', true)
      fire(source, 'dragend', false)
    },
    { from: fromId, to: toId }
  )
}

/** The tree's row ids among `ids`, top to bottom. */
async function drawnOrder(page: Page, ids: string[]): Promise<string[]> {
  return page.evaluate((wanted: string[]) => {
    const rows = [...document.querySelectorAll<HTMLElement>('[data-tree-node-id]')]
      .filter((el) => wanted.includes(el.dataset.treeNodeId ?? ''))
      .map((el) => ({ id: el.dataset.treeNodeId ?? '', top: el.getBoundingClientRect().top }))
    return rows.toSorted((a, b) => a.top - b.top).map((r) => r.id)
  }, ids)
}

interface NoteRow {
  id: string
  path: string
}

async function idAt(page: Page, path: string): Promise<string> {
  let id: string | undefined
  const listed = async () => {
    const { notes } = await invoke<{ notes: NoteRow[] }>(page, 'notes_list', {
      options: { limit: 10_000 }
    })
    id = notes.find((note) => note.path === path)?.id
    return id !== undefined
  }
  expect(await pollUntil(listed, { timeoutMs: 30_000 })).toBe(true)
  return id as string
}

test('a folder dropped between two notes in Manual sort keeps its place after a restart', async ({
  app,
  page,
  testVaultPath
}) => {
  test.slow()
  write(testVaultPath, 'notes/Mix/one.md', 'one')
  write(testVaultPath, 'notes/Mix/two.md', 'two')
  write(testVaultPath, 'notes/Mix/Sub/inner.md', 'inner')
  await ready(page)
  await page.reload()
  await ready(page)
  const one = await idAt(page, 'notes/Mix/one.md')
  const two = await idAt(page, 'notes/Mix/two.md')
  const sub = 'folder-notes/Mix/Sub'

  await expand(page, ['notes', 'notes/Mix'])
  await expect(row(page, sub)).toBeVisible({ timeout: 30_000 })
  await expect(row(page, one)).toBeVisible()
  await expect(row(page, two)).toBeVisible()
  // Unmixed, the level draws its folders first.
  const [firstNote, secondNote] = (await drawnOrder(page, [one, two, sub])).slice(1)
  expect((await drawnOrder(page, [one, two, sub]))[0]).toBe(sub)

  await dropAfter(page, sub, firstNote)

  const mixed = [firstNote, sub, secondNote]
  await expect.poll(() => drawnOrder(page, mixed), { timeout: 15_000 }).toEqual(mixed)
  const positions = await invoke<Record<string, number>>(page, 'notes_get_all_positions', {})
  expect(positions['notes/Mix/']).toBeDefined()
  expect(positions['notes/Mix/Sub']).toBeDefined()

  await restart(app)
  await ready(page)
  await expand(page, ['notes', 'notes/Mix'])
  await expect.poll(() => drawnOrder(page, mixed), { timeout: 30_000 }).toEqual(mixed)
})

test('a note and its same-named folder are one row that renames and deletes as one', async ({
  page,
  testVaultPath
}) => {
  test.slow()
  write(testVaultPath, 'notes/Recipes.md', 'Recipes')
  write(testVaultPath, 'notes/Recipes/Soup.md', 'Soup')
  await ready(page)
  await page.reload()
  await ready(page)
  const recipes = await idAt(page, 'notes/Recipes.md')
  await idAt(page, 'notes/Recipes/Soup.md')

  await expand(page, ['notes'])
  const paired = row(page, 'folder-notes/Recipes')
  await expect(paired).toBeVisible({ timeout: 30_000 })
  await expect(row(page, recipes)).toHaveCount(0)
  await expect(paired).toContainText('Recipes')

  // Rename the row: the folder and the note both take the new name.
  await paired.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
  const field = page.getByLabel('Rename', { exact: true })
  await expect(field).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(600)
  await field.fill('Cookbook')
  await field.press('Enter')

  const onDisk = (rel: string) => existsSync(join(testVaultPath, rel))
  const renamedBoth = async () =>
    onDisk('notes/Cookbook.md') && onDisk('notes/Cookbook/Soup.md') && !onDisk('notes/Recipes.md')
  expect(await pollUntil(renamedBoth, { timeoutMs: 15_000 })).toBe(true)
  expect(onDisk('notes/Recipes')).toBe(false)
  const notePath = async () =>
    (await invoke<NoteRow | null>(page, 'notes_get', { id: recipes }))?.path
  await expect.poll(notePath, { timeout: 15_000 }).toBe('notes/Cookbook.md')
  const cookbook = row(page, 'folder-notes/Cookbook')
  await expect(cookbook).toBeVisible({ timeout: 15_000 })
  await expect(row(page, recipes)).toHaveCount(0)

  // Delete the row: the dialog lists both, and both leave the disk.
  await cookbook.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /^Delete/ }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(/Cookbook/)).toHaveCount(2)
  // Two items: the confirm reads "Delete 2".
  await dialog.getByRole('button', { name: /^Delete 2/ }).click()

  const deletedBoth = async () => !onDisk('notes/Cookbook.md') && !onDisk('notes/Cookbook')
  expect(await pollUntil(deletedBoth, { timeoutMs: 15_000 })).toBe(true)
  await expect(row(page, 'folder-notes/Cookbook')).toHaveCount(0, { timeout: 15_000 })
  expect(await invoke<NoteRow | null>(page, 'notes_get', { id: recipes })).toBeNull()
})
