// `[[Note#Heading]]` links and links made from selected text, ported from Electron's
// `wiki-heading-links.e2e.ts` (A15, #1563; Step 14k, #3531). The scroll claim is measured in a
// real webview because jsdom has no layout: `scrollTop` and `scrollIntoView` are inert there.
import { expectSuggestionMenuOpen, noteBody, typeInEditor } from '../../harness/editor'
import { openNoteByTitle } from '../../harness/note-sync-helpers'
import { createNote, NOTE_EDITOR, NOTE_TITLE, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

const unique = (label: string): string => `${label} ${Math.random().toString(36).slice(2, 8)}`

/**
 * A heading far enough down to need scrolling, with a viewport of content below it: without
 * that content `scrollIntoView({ block: 'start' })` clamps at the bottom and the heading stops
 * partway down.
 */
function bodyWithHeadingFarDown(heading: string): string {
  const filler = (label: string): string =>
    Array.from({ length: 60 }, (_, i) => `${label} paragraph ${i + 1}.`).join('\n\n')
  return `Intro paragraph.\n\n${filler('Before')}\n\n## ${heading}\n\n${filler('After')}\n`
}

const firstChip = (page: Page) => page.locator('[data-wiki-link]').first()

interface Landed {
  headingTop: number
  scrollerTop: number
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  scroller: string | null
}

/** Where the heading sits against the note's real scroller, the first ancestor that scrolls. */
const landedAt = (page: Page, heading: string): Promise<Landed | null> =>
  page.evaluate((headingText: string) => {
    const editor = document.querySelector('.bn-editor')
    const node = Array.from(editor?.querySelectorAll('h2') ?? []).find(
      (el) => el.textContent?.trim() === headingText
    )
    if (!editor || !node) return null
    let scroller: HTMLElement | null = editor as HTMLElement
    while (scroller && scroller.scrollHeight - scroller.clientHeight <= 1) {
      scroller = scroller.parentElement
    }
    return {
      headingTop: Math.round(node.getBoundingClientRect().top),
      scrollerTop: Math.round(scroller?.getBoundingClientRect().top ?? 0),
      scrollTop: Math.round(scroller?.scrollTop ?? 0),
      scrollHeight: Math.round(scroller?.scrollHeight ?? 0),
      clientHeight: Math.round(scroller?.clientHeight ?? 0),
      scroller: scroller ? `${scroller.tagName}.${scroller.className}`.slice(0, 100) : null
    }
  }, heading)

test.describe('Linking selected text', () => {
  test('keeps the selected words as the label and links them to a note', async ({ page }) => {
    await vaultOpen(page)
    const targetTitle = unique('Continent')
    const sourceTitle = unique('Selection Source')
    const selected = 'kuzeyde bir yer'
    await createNote(page, { title: targetTitle, content: 'Bir kıta.\n' })
    const source = await createNote(page, { title: sourceTitle, content: `${selected}\n` })

    await openNoteByTitle(page, sourceTitle)

    // Selected with the pointer: BlockNote opens the formatting toolbar off the pointer gesture.
    const editor = page.locator(NOTE_EDITOR).first()
    await editor.click()
    await editor.getByText(selected, { exact: false }).first().click({ clickCount: 3 })

    const linkButton = page.locator('[data-test="link-to-note"]').first()
    await expect(linkButton).toBeEnabled()
    // The button acts on press and opens the link menu at the caret, which can open under the
    // pointer. A real click then goes to the element the press and the release share; the
    // driver's synthetic click goes to whatever is under the point, a menu row here, which picks
    // it and undoes the link. So the whole click is dispatched on the button.
    await linkButton.evaluate((button: HTMLElement) => {
      const { left, top, width, height } = button.getBoundingClientRect()
      const at = { bubbles: true, cancelable: true, composed: true, button: 0 }
      const point = { ...at, clientX: left + width / 2, clientY: top + height / 2 }
      const pointer = { ...point, pointerId: 1, pointerType: 'mouse', isPrimary: true }
      button.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, buttons: 1 }))
      button.dispatchEvent(new MouseEvent('mousedown', { ...point, buttons: 1, detail: 1 }))
      button.dispatchEvent(new PointerEvent('pointerup', pointer))
      button.dispatchEvent(new MouseEvent('mouseup', { ...point, detail: 1 }))
      button.dispatchEvent(new MouseEvent('click', { ...point, detail: 1 }))
    })

    await typeInEditor(page, targetTitle)
    const noteRow = page.locator('.wiki-link-menu [role="option"]').first()
    await expect(noteRow).toHaveText(targetTitle)
    await expectSuggestionMenuOpen(page)
    await noteRow.click()

    const chip = firstChip(page)
    await expect(chip).toBeVisible()
    await expect(chip).toHaveText(selected)
    await expect(chip).toHaveAttribute('data-target', targetTitle)
    await expect
      .poll(() => noteBody(page, source.id), { timeout: 15_000 })
      .toContain(`[[${targetTitle}|${selected}]]`)
  })
})

test.describe('Wiki heading links', () => {
  test('opens the note and scrolls to the heading instead of creating a note', async ({ page }) => {
    await vaultOpen(page)
    const targetTitle = unique('Heading Target')
    const sourceTitle = unique('Heading Source')
    const heading = 'Decisions'
    await createNote(page, { title: targetTitle, content: bodyWithHeadingFarDown(heading) })
    await createNote(page, {
      title: sourceTitle,
      content: `Jump to [[${targetTitle}#${heading}]].`
    })

    await openNoteByTitle(page, sourceTitle)
    await expect(firstChip(page)).toBeVisible()
    await firstChip(page).click()

    // The link opened the target note, not a new one named after the link.
    await expect(page.locator(NOTE_TITLE).first()).toHaveValue(targetTitle)

    // It landed on the heading: the scroller moved, and the heading sits near its top. Measured
    // against the scroller's own top, since the app chrome above it is not part of the note.
    await expect
      .poll(async () => ((await landedAt(page, heading))?.scrollTop ?? 0) > 0, { timeout: 20_000 })
      .toBe(true)
    const landed = await landedAt(page, heading)
    if (!landed || landed.headingTop - landed.scrollerTop >= 120) {
      throw new Error(`heading not near the top of the scroller: ${JSON.stringify(landed)}`)
    }

    // No note was created for the raw target, the file that used to be written and synced.
    expect(
      await invoke<unknown>(page, 'notes_resolve_by_title', { title: `${targetTitle}#${heading}` })
    ).toBeNull()
  })

  // A heading picked from the dropdown labels itself with the heading, and the file says so:
  // the alias is the only channel a display name survives a markdown round trip in.
  test('labels a heading picked from the dropdown with the heading alone', async ({ page }) => {
    await vaultOpen(page)
    const targetTitle = unique('Continent')
    const sourceTitle = unique('Label Source')
    const heading = 'North America'
    await createNote(page, { title: targetTitle, content: bodyWithHeadingFarDown(heading) })
    const source = await createNote(page, { title: sourceTitle, content: 'Bkz ' })

    await openNoteByTitle(page, sourceTitle)

    await page.locator(NOTE_EDITOR).first().click()
    await page.keyboard.press('End')
    // `[[` enters through the suggestion plugin's own trigger; an exact title then switches the
    // dropdown into heading mode.
    await typeInEditor(page, `[[${targetTitle}`)
    await typeInEditor(page, '#North')

    const headingRow = page.locator('.wiki-link-menu [role="option"]').first()
    await expect(headingRow).toHaveText(heading)
    // A closing menu keeps its last rows on screen with no handlers: a click there does nothing.
    await expectSuggestionMenuOpen(page)
    await headingRow.click()

    const chip = firstChip(page)
    await expect(chip).toBeVisible()
    await expect(chip).toHaveText(heading)
    await expect(chip).toHaveAttribute('data-target', `${targetTitle}#${heading}`)
    await expect(chip).toHaveAttribute('data-alias', heading)
    await expect
      .poll(() => noteBody(page, source.id), { timeout: 15_000 })
      .toContain(`[[${targetTitle}#${heading}|${heading}]]`)
  })

  // `#` is legal in a filename, so a split-only resolution would read this as heading `4…` of
  // note `Sprint` and strand a note that works today.
  test('still opens a note whose title really contains a hash', async ({ page }) => {
    await vaultOpen(page)
    const hashTitle = unique('Sprint #4')
    const sourceTitle = unique('Hash Source')
    await createNote(page, { title: hashTitle, content: 'Sprint body.' })
    await createNote(page, { title: sourceTitle, content: `See [[${hashTitle}]].` })

    await openNoteByTitle(page, sourceTitle)
    await expect(firstChip(page)).toBeVisible()
    await firstChip(page).click()

    await expect(page.locator(NOTE_TITLE).first()).toHaveValue(hashTitle)
  })
})
