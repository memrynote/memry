// @ts-nocheck - E2E test; window.api typing lives in the renderer bundle
/**
 * Saving a note must not rewrite the bytes around a toggle (#1877, #1883).
 *
 * #1877: `Before\n\n\n<toggle>\n\n\nAfter` came back as
 * `Before\n\n<toggle>\n\nAfter`. `splitMarkdownByToggles` trimmed the gaps out of
 * its markdown segments before the blank-line scanner ever saw them, so a user's
 * spacing collapsed on every save.
 *
 * #1883: a `<details data-memry-toggle>` with no `</details>` is declined as a
 * toggle and left as markdown, but its markup lines then reached BlockNote's
 * parser, which has no block for raw HTML and drops it. The open and summary
 * lines vanished from the file and only the body text came back.
 *
 * The round-trip itself is pinned per-serializer by the shared corpus in
 * `@memry/editor-schema/conformance`. What only an E2E can show is that the
 * RUNNING app wires that serializer to the vault: the note is seeded as bytes on
 * disk, opened in the real editor, edited, and the `.md` is read back with `fs`.
 * Markdown on disk is the source of truth for this content, so the file bytes are
 * the assertion, not the in-memory document.
 *
 * `getNoteFileBodyById` is deliberately not used to read it back. Its
 * `normalizeBodyText` collapses `\n{3,}` to `\n\n`, which is exactly the byte
 * difference #1877 is about, so that helper would report the bug as fixed. The
 * same applies to `lastMarkdown` on the write-back debug state.
 *
 * The sync-auth fixture is here for the reason `note-open-byte-stability.e2e.ts`
 * gives: collaboration has to be live for the editor to bind the shared Y.Doc,
 * which is what puts the save on the CRDT write-back path
 * (`blocknote-converter.ts`) and hands the suite a write-back counter. Without
 * that counter a "the bytes did not change" test passes even when nothing ever
 * saved.
 */

import * as fs from 'fs'
import * as path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures/sync-auth-fixtures'
import {
  getNoteHandleByTitle,
  getWritebackDebugById,
  openNoteByTitle
} from './utils/note-sync-helpers'
import { waitForSyncOnline } from './utils/network-control'
import { SELECTORS } from './utils/electron-helpers'

const TOGGLE = [
  '<details data-memry-toggle>',
  '<summary>Gapped toggle</summary>',
  '',
  'Body line',
  '',
  '</details>'
].join('\n')

/** Two blank lines against each edge of the toggle: the spacing #1877 ate. */
const GAPPED_BODY = `Before\n\n\n${TOGGLE}\n\n\nAfter`

/** No `</details>`, so the region is declined and stays literal markdown (#1883). */
const UNTERMINATED_BODY = '<details data-memry-toggle>\n<summary>Never closed</summary>\n\nBody'

function seedVaultFile(vaultPath: string, title: string, body: string): string {
  const absPath = path.join(vaultPath, 'notes', `${title}.md`)
  fs.mkdirSync(path.dirname(absPath), { recursive: true })
  fs.writeFileSync(absPath, body, 'utf8')
  return absPath
}

/**
 * The bytes the file settles on once the indexer has claimed it.
 *
 * Indexing a file that has never been seen can rewrite it before any editor
 * exists, which is not what these tests are about. Taking the baseline after the
 * file stops moving makes the later comparison mean exactly "did SAVING it
 * change anything".
 */
async function indexedBaseline(
  page: Page,
  title: string,
  absPath: string
): Promise<{ id: string; bytes: string }> {
  const note = await getNoteHandleByTitle(page, title)
  let bytes = fs.readFileSync(absPath, 'utf8')
  await expect
    .poll(
      () => {
        const next = fs.readFileSync(absPath, 'utf8')
        const settled = next === bytes
        bytes = next
        return settled
      },
      { timeout: 20_000, intervals: [1000] }
    )
    .toBe(true)
  return { id: note.id, bytes }
}

async function openInEditor(page: Page, title: string): Promise<void> {
  await openNoteByTitle(page, title)
  await page.locator(SELECTORS.noteEditor).first().waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForFunction(() => Boolean((window as any).__memryEditor), undefined, {
    timeout: 30_000
  })
}

/**
 * An edit and its immediate undo, at the end of the document.
 *
 * Write-back only runs from a doc update — `onDocUpdate` is `scheduleWriteback`'s
 * one production caller — and opening a note with nothing to promote produces
 * none, so a test that only opened the note would assert on a file the app never
 * saved. Insert-then-remove is driven through the editor API rather than a click
 * and a keystroke because clicking into a document that contains a toggle can
 * land on its fold, and the fold state is part of the bytes under test.
 */
async function nudgeDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    const editor = (window as any).__memryEditor
    if (!editor) throw new Error('window.__memryEditor not exposed')

    const before = (editor.document as any[]).map((block) => block.id)
    editor.insertBlocks(
      [{ type: 'paragraph', content: [{ type: 'text', text: 'nudge', styles: {} }] }],
      before[before.length - 1],
      'after'
    )
    const added = (editor.document as any[]).filter((block) => !before.includes(block.id))
    editor.removeBlocks(added.map((block) => block.id))
  })
}

/** Block until the debounced write-back has run for this note and gone quiet. */
async function waitForWritebackToSettle(
  electronApp: ElectronApplication,
  noteId: string
): Promise<void> {
  await expect
    .poll(
      async () => {
        const debug = await getWritebackDebugById(electronApp, noteId)
        return { performed: (debug?.performedCount ?? 0) >= 1, pending: debug?.pending ?? true }
      },
      { timeout: 30_000 }
    )
    .toEqual({ performed: true, pending: false })
}

/** The document as {type, text, children}, so assertions read like the note. */
async function documentShape(page: Page): Promise<any[]> {
  return page.evaluate(() => {
    const editor = (window as any).__memryEditor
    if (!editor) throw new Error('window.__memryEditor not exposed')
    const shape = (blocks: any[]): any[] =>
      blocks.map((block) => ({
        type: block.type,
        text: Array.isArray(block.content)
          ? block.content.map((part: any) => part.text ?? '').join('')
          : (block.props?.url ?? ''),
        children: shape(block.children ?? [])
      }))
    return shape(editor.document)
  })
}

async function reopenCold(page: Page, title: string): Promise<void> {
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await waitForSyncOnline(page, 60_000)
  await openInEditor(page, title)
}

test.describe('Toggle write-back byte stability', () => {
  test('blank lines on both sides of a toggle survive a real save (#1877)', async ({
    pageA,
    electronAppA,
    vaultPathA,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair
    await waitForSyncOnline(pageA)

    const title = `Toggle Gap ${Date.now()}`
    const absPath = seedVaultFile(vaultPathA, title, GAPPED_BODY)
    const baseline = await indexedBaseline(pageA, title, absPath)
    expect(baseline.bytes, 'the indexer left the seeded spacing alone').toContain(GAPPED_BODY)

    await openInEditor(pageA, title)
    await nudgeDocument(pageA)
    await waitForWritebackToSettle(electronAppA, baseline.id)

    await expect
      .poll(() => fs.readFileSync(absPath, 'utf8'), { timeout: 20_000 })
      .toBe(baseline.bytes)
    expect(
      fs.readFileSync(absPath, 'utf8'),
      'both gaps are still two blank lines wide on disk'
    ).toContain(GAPPED_BODY)
    expect((await getWritebackDebugById(electronAppA, baseline.id))?.lastError).toBeNull()

    await reopenCold(pageA, title)

    await expect(
      pageA.getByText('Gapped toggle').first(),
      'the summary is still on screen, so preservation did not cost the block'
    ).toBeVisible()
    await expect
      .poll(() => documentShape(pageA), { timeout: 20_000 })
      .toContainEqual({
        type: 'toggleListItem',
        text: 'Gapped toggle',
        children: [{ type: 'paragraph', text: 'Body line', children: [] }]
      })
    expect(fs.readFileSync(absPath, 'utf8'), 'the cold reopen rewrote nothing').toBe(baseline.bytes)
  })

  test('an unterminated toggle keeps its open and summary lines through a save (#1883)', async ({
    pageA,
    electronAppA,
    vaultPathA,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair
    await waitForSyncOnline(pageA)

    const title = `Toggle Unterminated ${Date.now()}`
    const absPath = seedVaultFile(vaultPathA, title, UNTERMINATED_BODY)
    const baseline = await indexedBaseline(pageA, title, absPath)
    expect(baseline.bytes, 'the indexer left the seeded markup alone').toContain(UNTERMINATED_BODY)

    await openInEditor(pageA, title)
    await nudgeDocument(pageA)
    await waitForWritebackToSettle(electronAppA, baseline.id)

    await expect
      .poll(() => fs.readFileSync(absPath, 'utf8'), { timeout: 20_000 })
      .toBe(baseline.bytes)
    const saved = fs.readFileSync(absPath, 'utf8')
    expect(saved, 'the open line the save used to drop is still in the file').toContain(
      '<details data-memry-toggle>'
    )
    expect(saved, 'the summary line the save used to drop is still in the file').toContain(
      '<summary>Never closed</summary>'
    )
    expect(saved, 'the whole unterminated region is byte-identical').toContain(UNTERMINATED_BODY)
    expect((await getWritebackDebugById(electronAppA, baseline.id))?.lastError).toBeNull()

    await reopenCold(pageA, title)

    await expect(
      pageA.getByText('Never closed').first(),
      'the summary text is on screen as the literal markup the author wrote'
    ).toBeVisible()
    expect(
      (await documentShape(pageA)).some((block) => block.type === 'toggleListItem'),
      'a region with no closing tag is declined, not claimed as a toggle'
    ).toBe(false)
    expect(fs.readFileSync(absPath, 'utf8'), 'the cold reopen rewrote nothing').toBe(baseline.bytes)
  })
})
