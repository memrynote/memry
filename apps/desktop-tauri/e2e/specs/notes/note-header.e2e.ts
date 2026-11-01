// The note header and local-only notes in the running app (Step 13n, #3530): a note opened from
// the sidebar shows its title, its header tags and its counts, and the note menu's local-only
// toggle keeps the note's changes off the sync queue until it is turned off, when the whole
// note is queued. The title, icon and tag edits arrive with notes_update and rename (13f, 13g);
// the Electron `notes` spec's create, edit, link and delete cases move with those slices.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { invokeTest } from '../../harness/invoke-test'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { vaultStatus } from '../../harness/vault-commands'
import { pollUntil } from '../../harness/wait'

type App = Parameters<typeof invokeTest>[0]

const PATH = 'notes/getting-started.md'
const TITLE = 'getting-started'

interface NoteFile {
  noteId: string
  path: string
  contentHash: string | null
}

/** The id of the note the vault's `PATH` became, once the open adopted it. */
async function noteId(app: App, page: Page): Promise<string> {
  expect(await pollUntil(async () => (await vaultStatus(page)).isOpen, { timeoutMs: 30_000 })).toBe(
    true
  )
  const row = await pollUntil(
    async () =>
      (await invokeTest<NoteFile[]>(app, 'e2e_vault_note_files')).find(
        (file) => file.path === PATH && file.contentHash !== null
      ),
    { timeoutMs: 20_000 }
  )
  expect(row).toBeDefined()
  return (row as NoteFile).noteId
}

/** Opens the note from the Collections tree, as a user does. */
async function openFromSidebar(page: Page, id: string): Promise<void> {
  const section = page.locator('#section-header-collections')
  if ((await section.getAttribute('aria-expanded')) === 'false') await section.click()
  const folder = page.locator('[data-tree-node-id="folder-notes"]')
  const expand = folder.getByRole('button', { name: 'Expand folder' })
  if (await expand.isVisible()) await expand.click()
  await page.locator(`[data-tree-node-id="${id}"]`).click()
  await expect(page.locator('textarea[aria-label="Note title"]').first()).toHaveValue(TITLE)
}

/** The ops queued for the note, oldest first. */
async function queued(app: App, id: string): Promise<string[]> {
  const rows = await invokeTest<{ op: string }[]>(app, 'e2e_debug_query', {
    sql: `SELECT op FROM outbox WHERE item_id = '${id}' ORDER BY id`
  })
  return rows.map((row) => row.op)
}

async function chooseFromNoteMenu(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('option', { name: label, exact: true }).click()
}

test('a note opened from the sidebar shows its title, tags and counts', async ({ app, page }) => {
  const id = await noteId(app, page)
  await openFromSidebar(page, id)

  const tags = page.getByRole('list', { name: 'Tags', exact: true }).first()
  await expect(tags).toContainText('tutorial')
  await expect(tags).toContainText('onboarding')

  const note = await page.evaluate(
    (opened) => window.__TAURI__.core.invoke('notes_get', { id: opened }),
    id
  )
  const words = (note as { wordCount: number }).wordCount
  expect(words).toBeGreaterThan(0)
  await page.locator('.outline-indicator').hover()
  await expect(page.locator('.outline-indicator')).toContainText(`${words} words`)
})

test('local-only from the note menu keeps the note off the sync queue until it is lifted', async ({
  app,
  page,
  testVaultPath
}) => {
  const id = await noteId(app, page)
  await openFromSidebar(page, id)
  // The adopted note waits for its first push.
  expect(await queued(app, id)).not.toEqual([])

  await chooseFromNoteMenu(page, 'Set local only')
  await expect(page.getByText('Note set to local only')).toBeVisible()
  expect(await queued(app, id)).toEqual([])
  const count = (): Promise<unknown> =>
    page.evaluate(() => window.__TAURI__.core.invoke('notes_get_local_only_count'))
  expect(await count()).toBe(1)

  // An edit while local-only reaches the file and nothing else.
  await invokeTest(app, 'e2e_note_edit', { noteId: id, text: 'kept on this device' })
  const file = join(testVaultPath, PATH)
  expect(
    await pollUntil(() => readFileSync(file, 'utf8').includes('kept on this device'), {
      timeoutMs: 10_000
    })
  ).toBe(true)
  expect(await queued(app, id)).toEqual([])

  await chooseFromNoteMenu(page, 'Disable local only')
  await expect(page.getByText('Note will sync to cloud')).toBeVisible()
  expect(await queued(app, id)).toEqual(['upsert', 'crdt-update'])
  expect(await count()).toBe(0)
})
