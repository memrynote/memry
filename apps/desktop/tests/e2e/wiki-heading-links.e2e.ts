/**
 * A15 — `[[Note#Heading]]`, the shape every Obsidian vault is full of.
 *
 * This lives in E2E rather than the renderer suite on purpose. The claim that
 * matters most here is "the target note is scrolled to the heading", and jsdom
 * cannot measure that: it has no layout, so `scrollTop`, `scrollHeight` and
 * `scrollIntoView` are all inert. A renderer test would report green while the
 * page sat at the top. The same lesson cost a round of scroll-restore work
 * (#1549); it is not repeated here.
 */

import { test, expect } from './fixtures'
import { ready, uniqueLabel } from './utils/desktop-test-helpers'
import { openNoteByTitle } from './utils/note-sync-helpers'
import { SELECTORS } from './utils/electron-helpers'

/** Enough filler above the heading that reaching it requires real scrolling. */
function bodyWithHeadingFarDown(heading: string): string {
  const filler = Array.from({ length: 60 }, (_, i) => `Filler paragraph ${i + 1}.`).join('\n\n')
  return `Intro paragraph.\n\n${filler}\n\n## ${heading}\n\nThe section body.\n`
}

test.describe('Wiki heading links', () => {
  test('opens the note and scrolls to the heading instead of creating a note', async ({ page }) => {
    await ready(page)

    const targetTitle = uniqueLabel('Heading Target')
    const sourceTitle = uniqueLabel('Heading Source')
    const heading = 'Decisions'

    const seeded = await page.evaluate(
      async ({ sourceTitle, targetTitle, body }) => {
        const api = window.api
        const target = await api.notes.create({ title: targetTitle, content: body })
        const source = await api.notes.create({
          title: sourceTitle,
          content: `Jump to [[${targetTitle}#Decisions]].`
        })
        if (!target.success || !target.note || !source.success || !source.note) {
          throw new Error('failed to seed heading-link notes')
        }
        return { targetId: target.note.id, sourceId: source.note.id }
      },
      { sourceTitle, targetTitle, body: bodyWithHeadingFarDown(heading) }
    )

    await openNoteByTitle(page, sourceTitle)

    const chip = page.locator('[data-wiki-link]').first()
    await expect(chip).toBeVisible()
    await chip.click()

    // 1. The link opened the TARGET note — not a new one named after the link.
    await expect(page.locator(SELECTORS.noteTitle).first()).toHaveValue(targetTitle)

    // 2. It landed on the heading rather than the top of the note. Asserted
    //    against the heading's own position, not a raw scroll offset: the
    //    latter would pass for any scroll at all.
    await expect
      .poll(
        async () =>
          page.evaluate((headingText) => {
            const editor = document.querySelector('.bn-editor')
            if (!editor) return null
            const node = Array.from(editor.querySelectorAll('h2')).find(
              (el) => el.textContent?.trim() === headingText
            )
            if (!node) return null
            const scroller = node.closest('.bn-editor')?.parentElement ?? null
            const top = node.getBoundingClientRect().top
            const frame = scroller?.getBoundingClientRect().top ?? 0
            return Math.round(top - frame)
          }, heading),
        { timeout: 20_000 }
      )
      // Near the top of the visible frame, in either direction by a line or so.
      .toBeLessThan(120)

    // 3. No note was created for the raw target. This is the file that used to
    //    be written into the vault and synced to every device.
    const junk = await page.evaluate(
      (title) => window.api.notes.resolveByTitle(title),
      `${targetTitle}#${heading}`
    )
    expect(junk).toBeNull()

    expect(seeded.targetId).toBeTruthy()
  })

  test('still opens a note whose title really contains a hash', async ({ page }) => {
    await ready(page)

    // `#` is legal in a filename, so split-only resolution would read this as
    // "heading `4` of note `Sprint …`" and strand a note that works today.
    const hashTitle = uniqueLabel('Sprint #4')
    const sourceTitle = uniqueLabel('Hash Source')

    await page.evaluate(
      async ({ hashTitle, sourceTitle }) => {
        const api = window.api
        const target = await api.notes.create({ title: hashTitle, content: 'Sprint body.' })
        const source = await api.notes.create({
          title: sourceTitle,
          content: `See [[${hashTitle}]].`
        })
        if (!target.success || !source.success) throw new Error('failed to seed hash-title notes')
      },
      { hashTitle, sourceTitle }
    )

    await openNoteByTitle(page, sourceTitle)

    const chip = page.locator('[data-wiki-link]').first()
    await expect(chip).toBeVisible()
    await chip.click()

    await expect(page.locator(SELECTORS.noteTitle).first()).toHaveValue(hashTitle)
  })
})
