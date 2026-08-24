/**
 * Attachment block menu E2E (issue #1709)
 *
 * Covers the reveal / open / copy-path menu on the custom `file` block: the
 * hover "⋯" dropdown and the right-click context menu, the original + stored
 * filename header, and Copy path landing the absolute on-disk path on the
 * clipboard.
 *
 * Side-effecting OS items (the reveal item / Open in default app) are only
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

// The reveal item is labelled for the host's file manager: Finder on macOS,
// Explorer on Windows, a generic file manager everywhere else.
const REVEAL_LABEL =
  process.platform === 'darwin'
    ? 'Reveal in Finder'
    : process.platform === 'win32'
      ? 'Show in Explorer'
      : 'Show in file manager'

const ORIGINAL_NAME = 'original-report.txt'

interface SeededAttachment {
  /** The note that is opened, whose body is the file-block marker. */
  noteId: string
  /** The note the attachment was uploaded against — the on-disk folder key. */
  attachmentNoteId: string
  storedFilename: string
}

/**
 * Create a note whose body is a single file-block marker pointing at a real
 * uploaded attachment, then open it via the restored-session pattern (the
 * robust open used by note-menu-actions / pdf-embed-resize).
 */
async function seedNoteWithFileBlock(
  page: Page,
  vaultPath: string,
  title: string
): Promise<SeededAttachment> {
  const seeded = await page.evaluate(
    async ({ t, fileName }) => {
      const api = window.api

      // The attachment needs a host note to be uploaded against; the note that
      // is actually opened is created afterwards WITH the marker as its initial
      // content — a post-create `notes.update` would lose to the CRDT body,
      // which keeps the body the note was created with.
      const host = await api.notes.create({ title: `${t} host`, content: 'attachment host' })
      if (!host.success || !host.note) throw new Error(host.error ?? 'host note create failed')

      const file = new File([new TextEncoder().encode('attachment menu e2e')], fileName, {
        type: 'text/plain'
      })
      const uploaded = await api.notes.uploadAttachment(host.note.id, file)
      if (!uploaded.success || !uploaded.path) {
        throw new Error(uploaded.error ?? 'attachment upload failed')
      }
      const attachments = await api.notes.listAttachments(host.note.id)
      const storedFilename = attachments[0]?.filename
      if (!storedFilename) throw new Error('uploaded attachment not listed')

      // Both notes sit in the same folder, so the host-relative ref resolves
      // identically from the note that embeds it.
      const marker = `<!-- file:${JSON.stringify({
        url: uploaded.path,
        name: fileName,
        size: uploaded.size ?? 0,
        mimeType: 'text/plain'
      })} -->`
      const note = await api.notes.create({ title: t, content: marker })
      if (!note.success || !note.note) throw new Error(note.error ?? 'note create failed')

      return { noteId: note.note.id, attachmentNoteId: host.note.id, storedFilename }
    },
    { t: title, fileName: ORIGINAL_NAME }
  )

  await page.addInitScript(
    ({ noteId, t, storageKey }) => {
      // Tab state is stored per vault since #1702: `memry_tab_state:<vaultPath>`.
      localStorage.setItem(
        storageKey,
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
    { noteId: seeded.noteId, t: title, storageKey: `memry_tab_state:${vaultPath}` }
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
    const { attachmentNoteId, storedFilename } = await seedNoteWithFileBlock(
      page,
      testVaultPath,
      uniqueLabel('Attachment Menu')
    )

    const card = page.locator('.file-attachment').first()
    await card.hover()
    await card.locator('[data-testid="attachment-menu-button"]').click()

    const menu = page.locator('[data-testid="attachment-dropdown-menu"]')
    await expect(menu).toBeVisible()
    // Header: original filename + the stored (on-disk) filename.
    await expect(menu.getByText(ORIGINAL_NAME, { exact: true })).toBeVisible()
    await expect(menu.getByText(`Stored as ${storedFilename}`)).toBeVisible()

    // OS-touching items: present + enabled, never clicked (no Finder on CI).
    for (const label of [REVEAL_LABEL, 'Open in default app']) {
      const item = menu.getByRole('menuitem', { name: label })
      await expect(item).toBeVisible()
      await expect(item).not.toHaveAttribute('data-disabled')
    }

    await menu.getByRole('menuitem', { name: 'Copy path' }).click()
    await expect(page.getByText('Path copied').first()).toBeVisible({ timeout: 5_000 })

    const clipboardText = await electronApp.evaluate(({ clipboard }) => clipboard.readText())
    expect(clipboardText).toBe(
      path.join(testVaultPath, 'attachments', attachmentNoteId, storedFilename)
    )
  })

  test('right-click on the block opens the same menu', async ({ page, testVaultPath }) => {
    await ready(page)
    const { storedFilename } = await seedNoteWithFileBlock(
      page,
      testVaultPath,
      uniqueLabel('Attachment Context')
    )

    await page.locator('.file-attachment').first().click({ button: 'right' })

    const menu = page.locator('[data-testid="attachment-context-menu"]')
    await expect(menu).toBeVisible()
    await expect(menu.getByText(`Stored as ${storedFilename}`)).toBeVisible()
    for (const label of [REVEAL_LABEL, 'Open in default app', 'Copy path']) {
      await expect(menu.getByRole('menuitem', { name: label })).toBeVisible()
    }
    // Close without invoking anything.
    await page.keyboard.press('Escape')
  })
})
