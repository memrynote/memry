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

/**
 * A heading far enough down to need real scrolling, and with a viewport's worth
 * of content BELOW it.
 *
 * The filler after the heading is not padding. `scrollIntoView({block: 'start'})`
 * can only bring the heading to the top if there is enough content beneath it to
 * scroll past; otherwise the browser clamps at maximum scroll and the heading
 * stops partway down. The first version of this fixture put the heading at the
 * end of the note, so the page scrolled to its very bottom — `scrollTop` came
 * back as exactly `scrollHeight - clientHeight` — and the assertion read that
 * correct behaviour as a failure.
 */
function bodyWithHeadingFarDown(heading: string): string {
  const filler = (label: string): string =>
    Array.from({ length: 60 }, (_, i) => `${label} paragraph ${i + 1}.`).join('\n\n')
  return `Intro paragraph.\n\n${filler('Before')}\n\n## ${heading}\n\n${filler('After')}\n`
}

/**
 * #1563 E2 — selected text becomes the link's display name.
 *
 * The selection is the half the suggestion query cannot see: it is parked in the
 * raw `[[|…]]` run behind the caret, so this only holds if the run survives the
 * menu round trip. Nothing in jsdom exercises the selection toolbar's
 * pointer-down handoff either, which is the other reason this is here.
 */
test.describe('Linking selected text', () => {
  test('keeps the selected words as the label and links them to a note', async ({ page }) => {
    await ready(page)

    const targetTitle = uniqueLabel('Continent')
    const sourceTitle = uniqueLabel('Selection Source')
    const selected = 'kuzeyde bir yer'

    await page.evaluate(
      async ({ sourceTitle, targetTitle, selected }) => {
        const api = window.api
        const target = await api.notes.create({ title: targetTitle, content: 'Bir kıta.\n' })
        const source = await api.notes.create({ title: sourceTitle, content: `${selected}\n` })
        if (!target.success || !source.success) throw new Error('failed to seed selection notes')
      },
      { sourceTitle, targetTitle, selected }
    )

    await openNoteByTitle(page, sourceTitle)

    const editor = page.locator(SELECTORS.noteEditor).first()
    await editor.click()
    await page.keyboard.press('Home')
    await page.keyboard.press('Shift+End')

    const linkButton = page.locator('[data-test="link-to-note"]').first()
    await expect(linkButton).toBeEnabled()
    // Pointer-down, not click: by the time `click` fires the button has focus
    // and ProseMirror's selection is gone. Playwright's click sends both.
    await linkButton.click()

    await page.keyboard.type(targetTitle)
    const noteRow = page.locator('.wiki-link-menu [role="option"]').first()
    await expect(noteRow).toHaveText(targetTitle)
    await noteRow.click()

    const chip = page.locator('[data-wiki-link]').first()
    await expect(chip).toBeVisible()
    await expect(chip).toHaveText(selected)
    await expect(chip).toHaveAttribute('data-target', targetTitle)

    await expect
      .poll(
        async () =>
          page.evaluate(async (title) => {
            const found = await window.api.notes.resolveByTitle(title)
            if (!found?.id) return null
            const note = await window.api.notes.get(found.id)
            return note?.content ?? null
          }, sourceTitle),
        { message: 'source note body on disk', timeout: 15000 }
      )
      .toContain(`[[${targetTitle}|${selected}]]`)
  })
})

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
      .toMatchObject({ scrolled: true })

    // The offset is asserted on its own, and every input to it is carried in the
    // failure message. `toMatchObject` prints only the keys it compared, so the
    // diagnostic fields added for this went unreported and cost another cycle.
    const landed = await page.evaluate((headingText) => {
      const editor = document.querySelector('.bn-editor')
      const node = Array.from(editor?.querySelectorAll('h2') ?? []).find(
        (el) => el.textContent?.trim() === headingText
      )
      let scroller: HTMLElement | null = (editor as HTMLElement) ?? null
      while (scroller && scroller.scrollHeight - scroller.clientHeight <= 1) {
        scroller = scroller.parentElement
      }
      return {
        headingTop: Math.round(node?.getBoundingClientRect().top ?? Number.NaN),
        scrollerTop: Math.round(scroller?.getBoundingClientRect().top ?? Number.NaN),
        scrollTop: Math.round(scroller?.scrollTop ?? Number.NaN),
        scrollHeight: Math.round(scroller?.scrollHeight ?? Number.NaN),
        clientHeight: Math.round(scroller?.clientHeight ?? Number.NaN),
        scroller: scroller ? `${scroller.tagName}.${scroller.className}`.slice(0, 100) : null
      }
    }, heading)

    expect(
      landed.headingTop - landed.scrollerTop,
      `heading offset inside the scroller — ${JSON.stringify(landed)}`
    ).toBeLessThan(120)

    // 3. No note was created for the raw target. This is the file that used to
    //    be written into the vault and synced to every device.
    const junk = await page.evaluate(
      (title) => window.api.notes.resolveByTitle(title),
      `${targetTitle}#${heading}`
    )
    expect(junk).toBeNull()

    expect(seeded.targetId).toBeTruthy()
  })

  /**
   * #1563 D2 — a heading link picked from the dropdown labels itself with the
   * heading, and says so in the file.
   *
   * The label rides in the alias because that is the only channel a display name
   * survives a markdown round trip in; deriving it at render time would read
   * `[[Sprint #4]]` (a real title, covered by the test below) as a split. So the
   * assertion has two halves and both matter: what the chip shows, and what the
   * vault file holds.
   */
  test('labels a heading picked from the dropdown with the heading alone', async ({ page }) => {
    await ready(page)

    const targetTitle = uniqueLabel('Continent')
    const sourceTitle = uniqueLabel('Label Source')
    const heading = 'North America'

    await page.evaluate(
      async ({ sourceTitle, targetTitle, body }) => {
        const api = window.api
        const target = await api.notes.create({ title: targetTitle, content: body })
        const source = await api.notes.create({ title: sourceTitle, content: 'Bkz ' })
        if (!target.success || !source.success) throw new Error('failed to seed label notes')
      },
      { sourceTitle, targetTitle, body: bodyWithHeadingFarDown(heading) }
    )

    await openNoteByTitle(page, sourceTitle)

    const editor = page.locator(SELECTORS.noteEditor).first()
    await editor.click()
    await page.keyboard.press('End')
    // The `[[` has to enter the document through the suggestion plugin's own
    // trigger, so type it rather than pasting.
    await page.keyboard.type(`[[${targetTitle}`)
    // An exact title is what switches the dropdown into heading mode.
    await page.keyboard.type('#North')

    const headingRow = page.locator('.wiki-link-menu [role="option"]').first()
    await expect(headingRow).toHaveText(heading)
    await headingRow.click()

    const chip = page.locator('[data-wiki-link]').first()
    await expect(chip).toBeVisible()
    // The chip reads the heading alone — not `Continent#North America`.
    await expect(chip).toHaveText(heading)
    await expect(chip).toHaveAttribute('data-target', `${targetTitle}#${heading}`)
    await expect(chip).toHaveAttribute('data-alias', heading)

    // And the file says exactly what the screen does.
    await expect
      .poll(
        async () =>
          page.evaluate(async (title) => {
            const found = await window.api.notes.resolveByTitle(title)
            if (!found?.id) return null
            const note = await window.api.notes.get(found.id)
            return note?.content ?? null
          }, sourceTitle),
        { message: 'source note body on disk', timeout: 15000 }
      )
      .toContain(`[[${targetTitle}#${heading}|${heading}]]`)
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
