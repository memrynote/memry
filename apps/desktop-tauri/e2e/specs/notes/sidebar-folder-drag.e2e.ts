// Dragging in the sidebar's Collections tree, ported from Electron's `sidebar-folder-drag.e2e.ts`.
// The notes part (Step 13g-3, #3530): a note dropped on another folder moves there through
// `notes_move`, its file keeps its name, its relative embed is re-pointed from the new folder,
// and the tree shows it once, under the folder it was dropped on. The folder part (Step 13h,
// #2206): a folder holding a subfolder dropped on another folder moves there through
// `notes_rename_folder`. On Windows the watcher holds every directory open and Windows will not
// rename one while anything beneath it is open, so the move failed and the drop did nothing; a
// folder with no subfolder moved fine. The Windows e2e job is the run on the failing platform.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { invoke, vaultStatus } from '../../harness/vault-commands'
import { pollUntil } from '../../harness/wait'

interface NoteView {
  id: string
  path: string
}

const row = (page: Page, nodeId: string) => page.locator(`[data-tree-node-id="${nodeId}"]`)

async function ready(page: Page): Promise<void> {
  expect(await pollUntil(async () => (await vaultStatus(page)).isOpen, { timeoutMs: 30_000 })).toBe(
    true
  )
}

/**
 * Opens the Collections section and expands `folders`, outermost first. A row that just mounted
 * may not show its toggle yet, so each folder is clicked open until it says it is.
 */
async function expand(page: Page, folders: string[]): Promise<void> {
  const section = page.locator('#section-header-collections')
  if ((await section.getAttribute('aria-expanded')) === 'false') await section.click()
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
 * Drags the row `fromId` onto the middle of the row `toId` ("inside") with the HTML5 drag events
 * the tree listens to. The harness's WebDriver pointer actions do not start the webview's native
 * drag (tried: the drop never fired), so the events are sent in the page, each at the row's
 * middle, carrying one shared `dataTransfer`. The virtualized tree puts `data-tree-node-id` on a
 * positioned wrapper and listens on the `treeitem` row inside it, so that row gets the events.
 */
async function dragOnto(page: Page, fromId: string, toId: string): Promise<void> {
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
      const fire = (element: Element, type: string) => {
        const rect = element.getBoundingClientRect()
        const event = new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 60,
          clientY: rect.top + rect.height / 2
        })
        Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
        element.dispatchEvent(event)
      }
      const [source, target] = [node(from), node(to)]
      fire(source, 'dragstart')
      fire(target, 'dragenter')
      fire(target, 'dragover')
      fire(target, 'drop')
      fire(source, 'dragend')
    },
    { from: fromId, to: toId }
  )
}

test('a note dropped on another folder moves there with its embeds', async ({
  page,
  testVaultPath
}) => {
  await ready(page)
  const create = (title: string, folder: string, content: string) =>
    invoke<NoteView>(page, 'notes_create', { input: { title, folder, content } })
  const dragged = await create('Drag me', 'notes/Source', '![photo](img/photo.png)')
  await create('Anchor', 'notes/Target', 'Stays')

  await expand(page, ['notes', 'notes/Source', 'notes/Target'])
  await expect(row(page, dragged.id)).toBeVisible({ timeout: 30_000 })
  await dragOnto(page, dragged.id, 'folder-notes/Target')

  // The file lands first; its embed is re-pointed in the note's next turn.
  const moved = join(testVaultPath, 'notes/Target/Drag me.md')
  const repointed = async () =>
    existsSync(moved) && readFileSync(moved, 'utf8').includes('![photo](../Source/img/photo.png)')
  expect(await pollUntil(repointed, { timeoutMs: 15_000 })).toBe(true)
  expect(existsSync(join(testVaultPath, 'notes/Source/Drag me.md'))).toBe(false)
  const note = await invoke<NoteView | null>(page, 'notes_get', { id: dragged.id })
  expect(note?.path).toBe('notes/Target/Drag me.md')

  // Once, the same note: the move kept its id, and no second note was made at the new path.
  await expand(page, ['notes/Target'])
  await expect(row(page, dragged.id)).toBeVisible({ timeout: 15_000 })
  await expect(row(page, dragged.id)).toHaveCount(1)
  const noteRows = page.locator('[data-tree-node-id]:not([data-tree-node-id^="folder-"])')
  await expect(noteRows.filter({ hasText: 'Drag me' })).toHaveCount(1)
})

/** `Beta` holding `Gamma`, a `Delta` to drop it on, and `filler` notes beside them. */
function seed(vault: string, filler: number): void {
  const write = (rel: string, title: string) => {
    const file = join(vault, 'notes', rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `---\ntitle: ${title}\n---\n\nfiller\n`)
  }
  write('Beta/beta-note.md', 'beta-note')
  write('Beta/Gamma/gamma-note.md', 'gamma-note')
  write('Delta/delta-note.md', 'delta-note')
  for (let i = 0; i < filler; i++) write(`filler-${String(i).padStart(3, '0')}.md`, `Filler ${i}`)
}

for (const [tree, filler] of [
  ['plain', 0],
  // Past VIRTUALIZATION_THRESHOLD (100), the tree most real vaults render.
  ['virtualized', 150]
] as const) {
  test(`a folder holding a subfolder drops into another folder (${tree} tree)`, async ({
    page,
    testVaultPath
  }) => {
    test.slow()
    seed(testVaultPath, filler)
    await ready(page)
    await page.reload()
    await ready(page)
    await expand(page, ['notes'])
    await expect(row(page, 'folder-notes/Beta')).toBeVisible({ timeout: 30_000 })
    await expect(row(page, 'folder-notes/Delta')).toBeVisible()
    // Only once every filler note is listed does the tree turn virtualized; dropping before that
    // would test the plain tree twice.
    const virtualizedRow = page.locator(
      '[data-tree-node-id="folder-notes/Beta"] > [role="treeitem"]'
    )
    if (filler > 0) await expect(virtualizedRow).toBeVisible({ timeout: 30_000 })

    await dragOnto(page, 'folder-notes/Beta', 'folder-notes/Delta')

    const onDisk = (rel: string) => existsSync(join(testVaultPath, 'notes', rel))
    expect(
      await pollUntil(async () => onDisk('Delta/Beta/Gamma/gamma-note.md'), { timeoutMs: 15_000 })
    ).toBe(true)
    expect(onDisk('Beta')).toBe(false)

    await expect(row(page, 'folder-notes/Beta')).toHaveCount(0, { timeout: 15_000 })
    await expand(page, ['notes/Delta', 'notes/Delta/Beta', 'notes/Delta/Beta/Gamma'])
    // Once, not twice: the note followed its folder instead of a second copy being indexed at
    // the new path.
    const noteRows = page.locator('[data-tree-node-id]:not([data-tree-node-id^="folder-"])')
    await expect(noteRows.filter({ hasText: 'gamma-note' })).toHaveCount(1, { timeout: 15_000 })
  })
}
