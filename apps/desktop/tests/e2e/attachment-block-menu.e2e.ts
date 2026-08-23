/**
 * Attachment block menu E2E (issue #1709)
 *
 * Covers the reveal / open / copy-path menu on the custom `file` block: the
 * hover "⋯" dropdown and the right-click context menu, the original + stored
 * filename header, and Copy path landing the absolute on-disk path on the
 * clipboard.
 *
 * Side-effecting OS items (Reveal in Finder / Open in default app) are only
 * asserted present + enabled — they are never clicked, so no Finder/Explorer
 * window is spawned on the CI machine (same policy as note-menu-actions).
 * The shell calls and path validation are verified at the unit level in
 * `src/main/vault/attachment-actions.test.ts`.
 */

import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { ready, uniqueLabel } from './utils/desktop-test-helpers'
import { SELECTORS } from './utils/electron-helpers'

const ORIGINAL_NAME = 'original-report.txt'

interface SeededAttachment {
  noteId: string
  storedFilename: string
}

/**
 * Create a note whose body is a single file-block marker pointing at a real
 * uploaded attachment, then open it via the restored-session pattern (the
 * robust open used by note-menu-actions / pdf-embed-resize).
 */
async function seedNoteWithFileBlock(page: Page, title: string): Promise<SeededAttachment> {
  const seeded = await page.evaluate(
    async ({ t, fileName }) => {
      const api = window.api
      const note = await api.notes.create({ title: t, content: 'attachment host' })
      if (!note.success || !note.note) throw new Error(note.error ?? 'note create failed')

      const file = new File([new TextEncoder().encode('attachment menu e2e')], fileName, {
        type: 'text/plain'
      })
      const uploaded = await api.notes.uploadAttachment(note.note.id, file)
      if (!uploaded.success || !uploaded.path) {
        throw new Error(uploaded.error ?? 'attachment upload failed')
      }
      const attachments = await api.notes.listAttachments(note.note.id)
      const storedFilename = attachments[0]?.filename
      if (!storedFilename) throw new Error('uploaded attachment not listed')

      const marker = `<!-- file:${JSON.stringify({
        url: uploaded.path,
        name: fileName,
        size: uploaded.size ?? 0,
        mimeType: 'text/plain'
      })} -->`
      const updated = await api.notes.update({ id: note.note.id, content: marker })
      if (!updated.success) throw new Error('note update failed')

      return { noteId: note.note.id, storedFilename }
    },
    { t: title, fileName: ORIGINAL_NAME }
  )

  await page.addInitScript(
    ({ noteId, t }) => {
      localStorage.setItem(
        'memry_tab_state',
        JSON.stringify({
          version: 2,
          tabGroups: {
            g1: {
              id: 'g1',
              activeTabId: 'note-tab',
              tabs: [
                {
                  id: 'note-tab',
                  type: 'note',
                  title: t,
                  icon: 'file',
                  path: `/notes/${noteId}`,
                  entityId: noteId,
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
    { noteId: seeded.noteId, t: title }
  )
  await page.reload()
  await ready(page)
  await page.locator(SELECTORS.noteEditor).first().waitFor({ state: 'visible', timeout: 20_000 })
  await page.locator('.file-attachment').first().waitFor({ state: 'visible', timeout: 20_000 })

  return seeded
}

test.describe('Attachment block menu', () => {
  test('hover menu shows both filenames, OS items enabled, Copy path lands the disk path', async ({
    page,
    electronApp,
    testVaultPath
  }) => {
    await ready(page)
    const { noteId, storedFilename } = await seedNoteWithFileBlock(
      page,
      uniqueLabel('Attachment Menu')
    )

    const card = page.locator('.file-attachment').first()
    await card.hover()
    await card.locator('[data-testid="attachment-menu-button"]').click()

    const menu = page.locator('[data-testid="attachment-dropdown-menu"]')
    await expect(menu).toBeVisible()
    // Header: original filename + the stored (on-disk) filename.
    await expect(menu.getByText(ORIGINAL_NAME)).toBeVisible()
    await expect(menu.getByText(`Stored as ${storedFilename}`)).toBeVisible()

    // OS-touching items: present + enabled, never clicked (no Finder on CI).
    for (const label of ['Reveal in Finder', 'Open in default app']) {
      const item = menu.getByRole('menuitem', { name: label })
      await expect(item).toBeVisible()
      await expect(item).not.toHaveAttribute('data-disabled')
    }

    await menu.getByRole('menuitem', { name: 'Copy path' }).click()
    await expect(page.getByText('Path copied').first()).toBeVisible({ timeout: 5_000 })

    const clipboardText = await electronApp.evaluate(({ clipboard }) => clipboard.readText())
    expect(clipboardText).toBe(path.join(testVaultPath, 'attachments', noteId, storedFilename))
  })

  test('right-click on the block opens the same menu', async ({ page }) => {
    await ready(page)
    const { storedFilename } = await seedNoteWithFileBlock(page, uniqueLabel('Attachment Context'))

    await page.locator('.file-attachment').first().click({ button: 'right' })

    const menu = page.locator('[data-testid="attachment-context-menu"]')
    await expect(menu).toBeVisible()
    await expect(menu.getByText(`Stored as ${storedFilename}`)).toBeVisible()
    for (const label of ['Reveal in Finder', 'Open in default app', 'Copy path']) {
      await expect(menu.getByRole('menuitem', { name: label })).toBeVisible()
    }
    // Close without invoking anything.
    await page.keyboard.press('Escape')
  })
})
