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

    // 2. It landed on the heading rather than the top of the note.
    //
    // Measured against the VIEWPORT, and cross-checked against the scroller's
    // own offset. An earlier version of this subtracted the editor wrapper's
    // rect from the heading's — but both move together when the page scrolls,
    // so the difference is the heading's offset within the content and is the
    // same number scrolled or not. It reported an identical 2095 across two
    // builds, which is what a scroll-invariant measurement looks like.
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

            // The page's real scroller. Every surface here is `h-full`
            // `overflow-hidden` wrapping an inner element that actually
            // scrolls, so walk up until one of them can.
            let scroller: HTMLElement | null = editor as HTMLElement
            while (scroller && scroller.scrollHeight - scroller.clientHeight <= 1) {
              scroller = scroller.parentElement
            }

            const headingTop = node.getBoundingClientRect().top
            const scrollerTop = scroller?.getBoundingClientRect().top ?? 0

            return {
              // Two independent signals: the page moved, and the heading is
              // where the user would look for it.
              scrolled: (scroller?.scrollTop ?? 0) > 0,
              // Within a line or two of the top of the scrolling area. Measured
              // against the scroller's own top rather than the window's,
              // because the app chrome above it is not part of the note.
              nearTop: headingTop - scrollerTop < 120,
              // Reported, not asserted. A boolean-only failure says "it landed
              // in the wrong place" and nothing about where, which cost a
              // 30-minute CI cycle to learn once already.
              headingTop: Math.round(headingTop),
              scrollerTop: Math.round(scrollerTop),
              scrollTop: Math.round(scroller?.scrollTop ?? 0),
              scrollerTag: scroller
                ? `${scroller.tagName}.${scroller.className}`.slice(0, 80)
                : null
            }
          }, heading),
        { timeout: 20_000 }
      )
      .toMatchObject({ scrolled: true, nearTop: true })

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
