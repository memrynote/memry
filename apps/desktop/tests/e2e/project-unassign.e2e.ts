import fs from 'fs'
import os from 'os'
import path from 'path'

import type { Page } from '@playwright/test'

import { test, expect } from './fixtures'
import { PNG_BYTES, ready, uniqueLabel } from './utils/desktop-test-helpers'
import { seedNote, tabSessionStorageKey } from './utils/electron-helpers'

/**
 * Issue #1941: a file assigned to a project could not be unassigned without
 * deleting the project or the file.
 *
 * The two item kinds reach `project_links` by different routes, so both are
 * proved here. A markdown note carries its membership in frontmatter and the
 * projector derives the row, which is why the note block asserts on the raw
 * file bytes as well as on the link. A binary file has no frontmatter, so its
 * row in `project_links` is the whole of its membership and the chips on the
 * file page are the only place it is ever shown.
 *
 * Inbox is covered alongside a user-created project because the report named
 * it, and because `listProjects` does not treat it differently — a regression
 * that special-cased it would only show up here.
 */

interface SeededProjects {
  inboxId: string
  inboxName: string
  projectId: string
}

async function seedProjects(page: Page, projectName: string): Promise<SeededProjects> {
  return page.evaluate(async (name) => {
    const created = await window.api.tasks.createProject({ name, color: '#6366f1' })
    if (!created.success || !created.project) {
      throw new Error(created.error ?? 'project create failed')
    }

    const { projects } = await window.api.tasks.listProjects()
    const inbox = projects.find((project) => project.isInbox)
    if (!inbox) throw new Error('inbox project missing')

    return { inboxId: inbox.id, inboxName: inbox.name, projectId: created.project.id }
  }, projectName)
}

async function linkedItemIds(page: Page, projectId: string): Promise<string[]> {
  return page.evaluate(async (id) => {
    const links = await window.api.tasks.listProjectLinks(id)
    return Array.isArray(links) ? links.map((link) => link.itemId) : []
  }, projectId)
}

test.describe('Unassigning from a project', () => {
  test('a note leaves both a user project and Inbox from its project property', async ({
    page,
    testVaultPath
  }) => {
    await ready(page)

    const projectName = uniqueLabel('Unassign Project')
    const { inboxId, inboxName, projectId } = await seedProjects(page, projectName)
    const noteId = await seedNote(page, uniqueLabel('Unassign Note'), 'Body')

    await page.evaluate(
      async ({ noteId, projectId, inboxId }) => {
        for (const id of [projectId, inboxId]) {
          const linked = await window.api.tasks.linkProjectItem({
            projectId: id,
            itemType: 'note',
            itemId: noteId
          })
          if (!linked.success) throw new Error(linked.error ?? 'link failed')
        }
      },
      { noteId, projectId, inboxId }
    )

    await expect.poll(() => linkedItemIds(page, projectId)).toContain(noteId)
    await expect.poll(() => linkedItemIds(page, inboxId)).toContain(noteId)

    const notePath = await page.evaluate(async (id) => {
      const note = await window.api.notes.get(id)
      return note?.path ?? null
    }, noteId)
    expect(notePath).toBeTruthy()
    expect(fs.readFileSync(path.join(testVaultPath, notePath!), 'utf8')).toContain(projectName)

    await openNoteTab(page, noteId)

    const properties = page.getByRole('list', { name: 'Properties list' }).first()
    await expect(properties).toBeVisible()

    for (const name of [projectName, inboxName]) {
      // Exact: the property row's own wrapper is a role="button" whose
      // accessible name concatenates the chip label with this one, so a
      // substring match would resolve to two elements.
      const remove = properties.getByRole('button', { name: `Remove from ${name}`, exact: true })
      await expect(remove).toBeVisible()
      await remove.click()
      await expect(remove).toHaveCount(0)
    }

    await expect.poll(() => linkedItemIds(page, projectId)).not.toContain(noteId)
    await expect.poll(() => linkedItemIds(page, inboxId)).not.toContain(noteId)

    await page.reload()
    await page.waitForLoadState('domcontentloaded')

    await expect.poll(() => linkedItemIds(page, projectId)).not.toContain(noteId)
    await expect.poll(() => linkedItemIds(page, inboxId)).not.toContain(noteId)

    // The file is the sync payload and the reindex source, so the link has to
    // be gone from the bytes, not only from the index. `Note.content` is the
    // body with the frontmatter stripped, so the property is read off
    // `frontmatter` and confirmed against the file on disk.
    const stored = await page.evaluate(async (id) => {
      const note = await window.api.notes.get(id)
      return note ? JSON.stringify(note.frontmatter) : null
    }, noteId)
    expect(stored).not.toContain(projectName)
    expect(fs.readFileSync(path.join(testVaultPath, notePath!), 'utf8')).not.toContain(projectName)
  })

  test('a file leaves both a user project and Inbox from its project chips', async ({ page }) => {
    await ready(page)

    const projectName = uniqueLabel('Unassign File Project')
    const { inboxId, inboxName, projectId } = await seedProjects(page, projectName)

    const importDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-e2e-unassign-'))
    const fileName = `unassign-${Date.now()}.png`
    fs.writeFileSync(path.join(importDir, fileName), Buffer.from(PNG_BYTES))
    const fileTitle = path.basename(fileName, path.extname(fileName))

    try {
      const imported = await page.evaluate(
        async (sourcePath) => window.api.notes.importFiles([sourcePath], ''),
        path.join(importDir, fileName)
      )
      expect(imported.success).toBe(true)

      const findFileId = async (): Promise<string | null> =>
        page.evaluate(async (title) => {
          const list = await window.api.notes.list({ limit: 200 })
          return list.notes.find((note) => note.title === title)?.id ?? null
        }, fileTitle)

      // The import writes the file; the indexer gives it an id a moment later.
      await expect.poll(findFileId, { timeout: 20_000 }).not.toBeNull()
      const fileId = await findFileId()
      expect(fileId).toBeTruthy()

      await page.evaluate(
        async ({ fileId, projectId, inboxId }) => {
          for (const id of [projectId, inboxId]) {
            const linked = await window.api.tasks.linkProjectItem({
              projectId: id,
              itemType: 'file',
              itemId: fileId
            })
            if (!linked.success) throw new Error(linked.error ?? 'link failed')
          }
        },
        { fileId: fileId!, projectId, inboxId }
      )

      await expect.poll(() => linkedItemIds(page, projectId)).toContain(fileId)
      await expect.poll(() => linkedItemIds(page, inboxId)).toContain(fileId)

      await openFileTab(page, fileId!, fileTitle)

      for (const name of [projectName, inboxName]) {
        const remove = page.getByRole('button', { name: `Remove from ${name}`, exact: true })
        await expect(remove).toBeVisible()
        await remove.click()
        await expect(remove).toHaveCount(0)
      }

      await expect.poll(() => linkedItemIds(page, projectId)).not.toContain(fileId)
      await expect.poll(() => linkedItemIds(page, inboxId)).not.toContain(fileId)

      await page.reload()
      await page.waitForLoadState('domcontentloaded')

      await expect.poll(() => linkedItemIds(page, projectId)).not.toContain(fileId)
      await expect.poll(() => linkedItemIds(page, inboxId)).not.toContain(fileId)
    } finally {
      fs.rmSync(importDir, { recursive: true, force: true })
    }
  })
})

async function openNoteTab(page: Page, noteId: string): Promise<void> {
  await seedTab(page, { type: 'note', id: noteId, title: 'Unassign Note', path: `/note/${noteId}` })
  await expect(page.getByRole('list', { name: 'Properties list' }).first()).toBeVisible()
}

async function openFileTab(page: Page, fileId: string, title: string): Promise<void> {
  await seedTab(page, { type: 'file', id: fileId, title, path: `/file/${fileId}` })
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
}

async function seedTab(
  page: Page,
  tab: { type: string; id: string; title: string; path: string }
): Promise<void> {
  const storageKey = await tabSessionStorageKey(page)
  await page.addInitScript(
    ({ tab, storageKey }) => {
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          version: 2,
          tabGroups: {
            g1: {
              id: 'g1',
              activeTabId: 'seeded-tab',
              tabs: [
                {
                  id: 'seeded-tab',
                  type: tab.type,
                  title: tab.title,
                  icon: tab.type,
                  path: tab.path,
                  entityId: tab.id,
                  isPinned: false
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
    { tab, storageKey }
  )
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
}
