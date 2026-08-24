/**
 * Attachments panel + self-heal E2E (issue #1713)
 *
 * Covers the two halves of the issue against a real vault on disk:
 *  - self-heal: an attachment renamed on disk outside the app (prefix kept)
 *    still renders, without the note's markdown ever changing;
 *  - ambiguous renames stay broken but the block names the file it expected;
 *  - the note menu's "Attachments…" panel lists the folder with original +
 *    stored names and per-row OS actions.
 *
 * Side-effecting OS items (Reveal in Finder / Open in default app) are only
 * asserted present + enabled — never clicked (same policy as
 * attachment-block-menu / note-menu-actions).
 */

import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { ready, uniqueLabel } from './utils/desktop-test-helpers'
import { SELECTORS } from './utils/electron-helpers'

const ORIGINAL_NAME = 'original-report.txt'

interface SeededAttachment {
  /** The note that is opened, whose body is the file-block marker. */
  noteId: string
  /** The note the attachment was uploaded against — the on-disk folder key. */
  attachmentNoteId: string
  storedFilename: string
  /** The note-relative ref written into the block marker. */
  url: string
}

/**
 * Create a note whose body is a single file-block marker pointing at a real
 * uploaded attachment, then open it via the restored-session pattern (same
 * seed as attachment-block-menu).
 */
async function seedNoteWithFileBlock(
  page: Page,
  vaultPath: string,
  title: string
): Promise<SeededAttachment> {
  const seeded = await page.evaluate(
    async ({ t, fileName }) => {
      const api = window.api

      const host = await api.notes.create({ title: `${t} host`, content: 'attachment host' })
      if (!host.success || !host.note) throw new Error(host.error ?? 'host note create failed')

      const file = new File([new TextEncoder().encode('self-heal e2e')], fileName, {
        type: 'text/plain'
      })
      const uploaded = await api.notes.uploadAttachment(host.note.id, file)
      if (!uploaded.success || !uploaded.path) {
        throw new Error(uploaded.error ?? 'attachment upload failed')
      }
      const attachments = await api.notes.listAttachments(host.note.id)
      const storedFilename = attachments[0]?.filename
      if (!storedFilename) throw new Error('uploaded attachment not listed')

      const marker = `<!-- file:${JSON.stringify({
        url: uploaded.path,
        name: fileName,
        size: uploaded.size ?? 0,
        mimeType: 'text/plain'
      })} -->`
      const note = await api.notes.create({ title: t, content: marker })
      if (!note.success || !note.note) throw new Error(note.error ?? 'note create failed')

      return {
        noteId: note.note.id,
        attachmentNoteId: host.note.id,
        storedFilename,
        url: uploaded.path
      }
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

function attachmentDiskPath(vaultPath: string, seeded: SeededAttachment): string {
  return path.join(vaultPath, 'attachments', seeded.attachmentNoteId, seeded.storedFilename)
}

test.describe('Attachment self-heal', () => {
  test('a prefix-preserving external rename no longer breaks the block', async ({
    page,
    testVaultPath
  }) => {
    await ready(page)
    const seeded = await seedNoteWithFileBlock(page, testVaultPath, uniqueLabel('Heal Rename'))

    // Rename outside the app, keeping the 6-char prefix.
    const diskPath = attachmentDiskPath(testVaultPath, seeded)
    const renamed = seeded.storedFilename.replace(/\.txt$/, '-renamed.txt')
    fs.renameSync(diskPath, path.join(path.dirname(diskPath), renamed))

    await page.reload()
    await ready(page)
    await page.locator(SELECTORS.noteEditor).first().waitFor({ state: 'visible', timeout: 20_000 })

    // The block renders normally — no missing-file card.
    await page.locator('.file-attachment').first().waitFor({ state: 'visible', timeout: 20_000 })
    await expect(page.getByTestId('attachment-missing-card')).toHaveCount(0)

    // The real resolve IPC heals to the renamed file; the stored ref is untouched.
    const resolved = await page.evaluate(
      ({ noteId, url }) => window.api.notes.resolveAttachment(noteId, url),
      { noteId: seeded.noteId, url: seeded.url }
    )
    expect(resolved.exists).toBe(true)
    expect(resolved.storedFilename).toBe(renamed)
  })

  test('an ambiguous rename stays broken and names the expected file', async ({
    page,
    testVaultPath
  }) => {
    await ready(page)
    const seeded = await seedNoteWithFileBlock(page, testVaultPath, uniqueLabel('Heal Ambiguous'))

    // Two candidates share the prefix — the heal must not guess.
    const diskPath = attachmentDiskPath(testVaultPath, seeded)
    const dir = path.dirname(diskPath)
    const prefix = seeded.storedFilename.slice(0, 7)
    fs.renameSync(diskPath, path.join(dir, `${prefix}candidate-a.txt`))
    fs.writeFileSync(path.join(dir, `${prefix}candidate-b.txt`), 'decoy')

    await page.reload()
    await ready(page)
    await page.locator(SELECTORS.noteEditor).first().waitFor({ state: 'visible', timeout: 20_000 })

    const card = page.getByTestId('attachment-missing-card')
    await expect(card).toBeVisible({ timeout: 20_000 })
    await expect(card).toContainText(seeded.storedFilename)
  })
})

test.describe('Note attachments panel', () => {
  test('lists original + stored names with enabled OS actions', async ({ page, testVaultPath }) => {
    await ready(page)
    const seeded = await seedNoteWithFileBlock(page, testVaultPath, uniqueLabel('Attach Panel'))

    // The panel lists the OPENED note's own folder; the seed uploads against a
    // host note (the marker-as-initial-content workaround), so mirror the file
    // into the opened note's folder the way a normal upload would have put it.
    const hostPath = attachmentDiskPath(testVaultPath, seeded)
    const ownDir = path.join(testVaultPath, 'attachments', seeded.noteId)
    fs.mkdirSync(ownDir, { recursive: true })
    fs.copyFileSync(hostPath, path.join(ownDir, seeded.storedFilename))

    await page.locator('[data-testid="note-more-menu"]').first().click()
    await page.getByRole('option', { name: 'Attachments…' }).click()

    const dialog = page.getByTestId('note-attachments-dialog')
    await expect(dialog).toBeVisible()

    const row = dialog.getByTestId('note-attachment-row')
    await expect(row).toHaveCount(1)
    await expect(row).toContainText(ORIGINAL_NAME)
    await expect(row).toContainText(seeded.storedFilename)

    // OS items present + enabled, never clicked.
    for (const label of ['Reveal in Finder', 'Open in default app']) {
      const button = row.getByRole('button', { name: label })
      await expect(button).toBeVisible()
      await expect(button).toBeEnabled()
    }
  })
})
