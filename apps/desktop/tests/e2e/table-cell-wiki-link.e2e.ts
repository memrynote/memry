// @ts-nocheck - E2E test; window.api typing lives in the renderer bundle
/**
 * Wiki links inside table cells — the real app (#1865).
 *
 * BlockNote's external-HTML exporter never reaches inside a table. A table
 * block's `tableContent` becomes `tableRow` NODES, a row is not registered
 * inline content, so `serializeBlocksExternalHTML` falls through to
 * `DOMSerializer.serializeFragment` — and that one call resolves the whole
 * subtree through ProseMirror's `NodeSpec.toDOM`, which `createInlineContentSpec`
 * builds from `render`, the editor's rich chip. A `[[Roadmap]]` in a cell was
 * written back to the vault as bare `Roadmap`, and the marker was gone for good.
 *
 * `packages/editor-schema/src/conformance.ts` already drives markdown → blocks →
 * markdown through both process pipelines and pins the bytes. What it cannot do
 * is answer the question a user actually asks: does the app I am typing in still
 * have my link in it afterwards. That needs the surface, not the pipeline — a
 * real editor, the real debounced save, and the real file the save lands in.
 *
 * ## Which surface, and why it is the template editor
 *
 * The broken serializer is the RENDERER's (`serializeBlocksPreservingBlanks`),
 * and on the note surface it is dead code. `use-editor-sync.ts` only runs the
 * markdown save when `!yjsFragment`, and `isLocalCrdtDocLive` returns
 * `Boolean(noteId)` — so a real note always has CRDT live and the main process's
 * converter, which was never affected, owns the write-back. A note-surface test
 * therefore cannot go red on the broken build, no matter what it asserts.
 *
 * The one surface that still persists through the renderer serializer is the
 * template editor: `pages/template-editor.tsx` renders `<ContentArea>` with no
 * `noteId`, and `onMarkdownChange` is the only thing that carries the body into
 * `templates.update`. That is what test 1 drives, and it is the test that goes
 * red without the fix.
 */

import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { SELECTORS } from './utils/electron-helpers'
import { ready, uniqueLabel } from './utils/desktop-test-helpers'
import { getNoteFileBodyByTitle, openNoteByTitle } from './utils/note-sync-helpers'

function tableRowLines(markdown: string): string[] {
  return markdown.split('\n').filter((line) => line.trimStart().startsWith('|'))
}

/**
 * The persisted body, read back out of main.
 *
 * A template has no vault file to read: custom templates live in the vault's
 * `data.db`, and `.memry/templates/<id>.md` is only the pre-sync legacy path
 * `templates.ts` keeps around as a downgrade artifact. `templates.get` crosses
 * IPC into main and selects the row, so this is the stored bytes and not the
 * renderer's own copy of them.
 */
async function templateContent(page: Page, id: string): Promise<string> {
  return page.evaluate(async (templateId) => {
    const template = await window.api.templates.get(templateId)
    return template?.content ?? ''
  }, id)
}

/**
 * Open a template through Settings → Templates, the way a user reaches it.
 *
 * The row is what `templates-section.tsx` pushes the `template-editor` tab
 * from, and the tab is the only host that mounts the editor without a `noteId`.
 * Calling `openTab` directly would skip the wiring that decides that.
 */
async function openTemplateEditor(page: Page, name: string): Promise<void> {
  await page.evaluate(() => window.api.quickCapture.openSettings('templates'))
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 15_000 })

  const row = page.locator(`[role="button"][aria-label="${name}"]`)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.click()

  await page.locator(SELECTORS.noteEditor).first().waitFor({ state: 'visible', timeout: 15_000 })
}

test.describe('Wiki links in table cells', () => {
  test('editing a template does not strip the wiki link out of its table', async ({ page }) => {
    await ready(page)

    // #given a template whose table cell holds a wiki link, and a paragraph
    // below the table to type into. The link and the edit are deliberately in
    // different blocks: the wiki-link edit plugin un-promotes the chip under the
    // caret, so typing in the cell itself would test the plugin, not the
    // serializer.
    const target = uniqueLabel('Some Target')
    const templateName = uniqueLabel('Table Template')
    const marker = 'edited-in-e2e'
    const seeded = [
      '| Area | Owner |',
      '| --- | --- |',
      `| Q3 | [[${target}]] |`,
      '',
      'Notes below.'
    ].join('\n')

    const templateId = await page.evaluate(
      async ({ templateName, seeded }) => {
        const created = await window.api.templates.create({
          name: templateName,
          content: seeded
        })
        if (!created.success || !created.template) {
          throw new Error(created.error ?? 'template create failed')
        }
        return created.template.id
      },
      { templateName, seeded }
    )

    await openTemplateEditor(page, templateName)

    // The link really did become a node — without this the rest of the test
    // would pass on plain text that was never at risk.
    await expect(
      page.locator(`${SELECTORS.noteEditor} td [data-wiki-link][data-target="${target}"]`)
    ).toBeVisible({ timeout: 15_000 })

    // #when the user types anywhere in the template, which is all it takes: the
    // change handler serializes the WHOLE document and hands it to
    // `onMarkdownChange`, so an edit in the paragraph rewrites the table too.
    const paragraph = page.locator(SELECTORS.noteEditor).getByText('Notes below.')
    await paragraph.click()
    await page.keyboard.press('End')
    await page.keyboard.type(` ${marker}`)

    // #then the edit reaches the persisted template. Polling on the MARKER
    // rather than on the link is what makes the failure legible: it proves the
    // debounced save actually ran, so the assertions below read a fresh body
    // instead of timing out against a stale one.
    await expect
      .poll(() => templateContent(page, templateId), { timeout: 30_000 })
      .toContain(marker)

    // #and the link survived that same save. On the build before #1865 this is
    // the line that fails: the cell comes back as the chip's display text, so
    // the body holds a bare `Some Target` and the `[[…]]` marker is gone.
    const content = await templateContent(page, templateId)
    expect(content).toContain(`[[${target}]]`)
    expect(content).toMatch(new RegExp(`\\|\\s*Q3\\s*\\|\\s*\\[\\[${target}\\]\\]\\s*\\|`))

    // Still one table: a chip serialized as block-level HTML would have split
    // the row or swallowed the table whole.
    expect(tableRowLines(content)).toHaveLength(3)
  })

  /**
   * The user-visible half, on the surface people actually use.
   *
   * This test passes on the pre-fix build too, and saying so is better than
   * letting someone discover it later. The note surface never runs the broken
   * serializer: a real note always has a live CRDT doc, so main's converter owns
   * the write-back, and main's inline specs already pass their serialization
   * function as `render` — there was no rich chip in that process to leak. What
   * this pins is the OUTCOME the report is made of, on a path that had no
   * coverage for links inside a table at all: the cell holds a chip and not
   * plain text, and pressing it goes to the note it names.
   */
  test('a wiki link in a note table is a chip and follows to its target', async ({ page }) => {
    await ready(page)

    // #given a target note, and a source note whose table cell links to it
    const target = uniqueLabel('Table Target')
    const source = uniqueLabel('Table Source')
    await page.evaluate(
      async ({ target, source }) => {
        const created = await window.api.notes.create({ title: target, content: 'A target.\n' })
        const linking = await window.api.notes.create({
          title: source,
          content: ['| Area | Owner |', '| --- | --- |', `| Q3 | [[${target}]] |`, ''].join('\n')
        })
        if (!created.success || !linking.success) throw new Error('failed to seed the table case')
      },
      { target, source }
    )

    // Read back rather than assumed: if `notes.create` had already flattened the
    // link, everything below would be green about nothing.
    const stored = await getNoteFileBodyByTitle(page, source)
    expect(stored).toContain(`[[${target}]]`)

    // #when the note is opened
    await openNoteByTitle(page, source)
    await page.locator(SELECTORS.noteEditor).first().waitFor({ state: 'visible', timeout: 15_000 })

    // #then the cell holds a real chip — `td` scoped, because a chip rendered
    // beside the table instead of inside it is the failure worth catching
    const chip = page.locator(
      `${SELECTORS.noteEditor} td [data-wiki-link][data-target="${target}"]`
    )
    await expect(chip).toBeVisible({ timeout: 20_000 })

    // #and pressing it opens the note it names.
    //
    // Held, not clicked. Playwright's `.click()` presses and releases in one
    // tick; a hand holds for 80-150ms, and in that window the wiki-link edit
    // plugin paints the raw `[[…]]` over the chip and hides the chip itself, so
    // the click retargets to the paragraph and lands nowhere (52c6cd07f, and
    // `wiki-link-open-promotion.e2e.ts`). `hover()` rather than a
    // `boundingBox()` read: it waits for the box to hold still, and a raw read
    // taken while the editor is settling lands a line off.
    //
    // Snapshot, release, then assert: a failing assertion must not leave the
    // mouse button held down for the rest of the file.
    await chip.hover()
    await page.mouse.down()
    await page.waitForTimeout(150)
    const chipStillRendered = await chip.isVisible()
    await page.mouse.up()

    expect(chipStillRendered).toBe(true)
    await expect(page.locator(SELECTORS.noteTitle).first()).toHaveValue(target)
  })
})
