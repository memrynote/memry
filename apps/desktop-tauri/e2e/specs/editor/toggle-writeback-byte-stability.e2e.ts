// Saving a note must not rewrite the bytes around a toggle (#1877, #1883), ported from
// Electron's `toggle-writeback-byte-stability.e2e.ts` (Step 14k, #3531).
//
// #1877: the blank lines on each side of a toggle collapsed on every save. #1883: a
// `<details data-memry-toggle>` with no `</details>` lost its open and summary lines. The note is
// seeded as bytes on disk, opened in the editor, edited, and the `.md` is read back with `fs`:
// the file bytes are the assertion, not the document. `normalizeBodyText` collapses `\n{3,}`,
// the very difference #1877 is about, so no helper that uses it reads the file here.
//
// Electron needed a signed-in sync pair to bind the editor to the shared document and put the
// save on the write-back path. The Tauri editor always edits the app's document, so the spec
// needs no sync; it waits on `e2e_writeback_debug_state` for a pass that compared the body with
// the file, without which "the bytes did not change" passes when nothing saved.
import * as fs from 'node:fs'

import { blockText, editorDocument, type EditorBlock } from '../../harness/editor'
import { vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import {
  indexedBaseline,
  nudgeDocument,
  openInEditor,
  seedVaultFile,
  waitForWritebackToSettle,
  writebackDebug
} from '../../harness/seeded-note'
import { test, expect } from '../../harness/test'

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

interface Shape {
  type: string
  text: string
  children: Shape[]
}

/** The document as {type, text, children}, so assertions read like the note. */
async function documentShape(page: Page): Promise<Shape[]> {
  const shape = (blocks: EditorBlock[]): Shape[] =>
    blocks.map((block) => ({
      type: block.type,
      text: Array.isArray(block.content)
        ? blockText(block)
        : typeof block.props?.url === 'string'
          ? block.props.url
          : '',
      children: shape(block.children ?? [])
    }))
  return shape(await editorDocument(page))
}

async function reopenCold(page: Page, title: string): Promise<void> {
  await page.reload()
  await vaultOpen(page)
  await openInEditor(page, title)
}

test.describe('Toggle write-back byte stability', () => {
  test('blank lines on both sides of a toggle survive a real save (#1877)', async ({
    app,
    page,
    testVaultPath
  }) => {
    await vaultOpen(page)
    const title = `Toggle Gap ${Date.now()}`
    const absPath = seedVaultFile(testVaultPath, title, GAPPED_BODY)
    const baseline = await indexedBaseline(page, title, absPath)
    // The app left the seeded spacing alone.
    expect(baseline.bytes).toContain(GAPPED_BODY)

    await openInEditor(page, title)
    await nudgeDocument(page)
    await waitForWritebackToSettle(app, baseline.id)

    await expect
      .poll(() => fs.readFileSync(absPath, 'utf8'), { timeout: 20_000 })
      .toBe(baseline.bytes)
    // Both gaps are still two blank lines wide on disk.
    expect(fs.readFileSync(absPath, 'utf8')).toContain(GAPPED_BODY)
    expect((await writebackDebug(app, baseline.id))?.lastError).toBeNull()

    await reopenCold(page, title)

    // The summary is still on screen, so preservation did not cost the block.
    await expect(page.getByText('Gapped toggle').first()).toBeVisible()
    await expect
      .poll(
        async () => (await documentShape(page)).find((block) => block.type === 'toggleListItem'),
        {
          timeout: 20_000
        }
      )
      .toEqual({
        type: 'toggleListItem',
        text: 'Gapped toggle',
        children: [{ type: 'paragraph', text: 'Body line', children: [] }]
      })
    // The cold reopen rewrote nothing.
    expect(fs.readFileSync(absPath, 'utf8')).toBe(baseline.bytes)
  })

  test('an unterminated toggle keeps its open and summary lines through a save (#1883)', async ({
    app,
    page,
    testVaultPath
  }) => {
    await vaultOpen(page)
    const title = `Toggle Unterminated ${Date.now()}`
    const absPath = seedVaultFile(testVaultPath, title, UNTERMINATED_BODY)
    const baseline = await indexedBaseline(page, title, absPath)
    // The app left the seeded markup alone.
    expect(baseline.bytes).toContain(UNTERMINATED_BODY)

    await openInEditor(page, title)
    await nudgeDocument(page)
    await waitForWritebackToSettle(app, baseline.id)

    await expect
      .poll(() => fs.readFileSync(absPath, 'utf8'), { timeout: 20_000 })
      .toBe(baseline.bytes)
    const saved = fs.readFileSync(absPath, 'utf8')
    // The open and summary lines the save used to drop, and the whole region byte for byte.
    expect(saved).toContain('<details data-memry-toggle>')
    expect(saved).toContain('<summary>Never closed</summary>')
    expect(saved).toContain(UNTERMINATED_BODY)
    expect((await writebackDebug(app, baseline.id))?.lastError).toBeNull()

    await reopenCold(page, title)

    // The summary text is on screen as the literal markup the author wrote, and a region with
    // no closing tag is declined, not claimed as a toggle.
    await expect(page.getByText('Never closed').first()).toBeVisible()
    expect((await documentShape(page)).some((block) => block.type === 'toggleListItem')).toBe(false)
    // The cold reopen rewrote nothing.
    expect(fs.readFileSync(absPath, 'utf8')).toBe(baseline.bytes)
  })
})
