// CriticMarkup review comments, ported from Electron's `critic-markup-review.e2e.ts` (Step 14z,
// #3531): a comment needs an explicit action, resolve and delete keep the text and undo brings the
// card back, a mark and its card light each other on hover, the rail collapses on a narrow window,
// and the composer's format toolbar keeps the draft. The window starts at the harness's
// 1440x900 (Electron set 1440x960), wide enough for the rail; the narrow layout resizes the window
// through `e2e_set_window_rect`, as Electron's `setViewportSize` resized the page.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDayPanelClosed, navigateTo, SHORTCUTS } from '../../harness/app-helpers'
import { openNewNote, typeInEditor } from '../../harness/editor'
import { invokeTest } from '../../harness/invoke-test'
import { NOTE_EDITOR, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import type { TauriApp } from '../../harness/tauri-lifecycle'
import { test, expect } from '../../harness/test'
import { pollUntil } from '../../harness/wait'

type MarkKind = 'addition' | 'deletion' | 'substitution' | 'comment'

const label = (name: string): string => `${name} ${Date.now().toString(36)}`

const editor = (page: Page) => page.locator(NOTE_EDITOR).first()
const commentButton = (page: Page) => page.locator('[data-test="review-comment"]').last()
// The rail's aria-label is `comments.railAria` ("Comments").
const reviewRail = (page: Page) =>
  page.getByRole('complementary', { name: 'Comments', exact: true })
// The draft composer lives in the rail when it is expanded, or in a near-selection flyout when
// the rail has collapsed (`review-badge-layer.tsx`).
const commentComposer = (page: Page) => page.locator('.critic-comment-composer').first()
const commentCards = (page: Page) => page.locator('.critic-review-card-comment')
const inlineMark = (page: Page, kind: MarkKind) =>
  page.locator(`[data-critic-mark-kind="${kind}"]`).first()

const setWindowWidth = (app: TauriApp, width: number, height: number) =>
  invokeTest(app, 'e2e_set_window_rect', { label: 'main', x: 0, y: 0, width, height })

/** Opens a new note whose body is `lines`, one paragraph each, with the review rail's full width. */
async function openReviewNote(page: Page, name: string, lines: string[]): Promise<void> {
  await vaultOpen(page)
  // The day panel defaults open (#625) and would collapse the rail into the badge flyout.
  await ensureDayPanelClosed(page)
  await openNewNote(page, label(name), lines.join('\n\n'))
  await expect(editor(page)).toContainText(lines[lines.length - 1])
}

/**
 * Selects `text` in the editor through the DOM, as Electron's spec does, and waits for the
 * selection toolbar's comment button. A selection by mouse needs a driver with native input.
 */
async function selectEditorText(page: Page, text: string): Promise<void> {
  await editor(page).click()
  const selected = await page.evaluate(
    ([selector, target]: [string, string]) => {
      const root = document.querySelector(selector)
      if (!(root instanceof HTMLElement)) return false
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let node: Node | null
      while ((node = walker.nextNode())) {
        const index = (node.textContent ?? '').indexOf(target)
        if (index === -1) continue
        root.focus()
        const range = document.createRange()
        range.setStart(node, index)
        range.setEnd(node, index + target.length)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        root.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
        root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        document.dispatchEvent(new Event('selectionchange', { bubbles: true }))
        return true
      }
      return false
    },
    [NOTE_EDITOR, text]
  )
  expect(selected).toBe(true)
  await expect(commentButton(page)).toBeVisible()
}

/** Selects `text` inside the comment composer's own editor. */
async function selectComposerText(page: Page, text: string): Promise<void> {
  const selected = await page.evaluate((target: string) => {
    const root = document.querySelector('.critic-comment-editor .ProseMirror')
    if (!(root instanceof HTMLElement)) return false
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      const index = (node.textContent ?? '').indexOf(target)
      if (index === -1) continue
      root.focus()
      const range = document.createRange()
      range.setStart(node, index)
      range.setEnd(node, index + target.length)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      root.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
      root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      document.dispatchEvent(new Event('selectionchange', { bubbles: true }))
      return true
    }
    return false
  }, text)
  expect(selected).toBe(true)
}

/** The top of the selection's first line box. */
async function selectedTextTop(page: Page): Promise<number> {
  const top = await page.evaluate(() => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return null
    const range = selection.getRangeAt(0)
    const rect =
      Array.from(range.getClientRects()).find((item) => item.width > 0 && item.height > 0) ??
      range.getBoundingClientRect()
    return rect.width === 0 || rect.height === 0 ? null : rect.top
  })
  expect(top).not.toBeNull()
  return top as number
}

/** The flyout composer opens near the selection; the rail-hosted one sits in the aside. */
async function expectComposerNearSelectedTop(page: Page, selectedTop: number): Promise<void> {
  await expect(commentComposer(page)).toBeVisible()
  if ((await page.locator('.critic-review-flyout-draft .critic-comment-composer').count()) === 0)
    return
  await expect
    .poll(() =>
      commentComposer(page).evaluate(
        (element: HTMLElement, expected: number) =>
          Math.abs(element.getBoundingClientRect().top - expected) < 120,
        selectedTop
      )
    )
    .toBe(true)
}

async function submitComment(page: Page, body: string): Promise<void> {
  const draft = commentComposer(page)
  await expect(draft).toBeVisible()
  const input = draft.getByLabel('Add a comment...')
  await expect(input).toBeVisible()
  await input.fill(body)
  const send = draft.getByLabel('Send comment')
  await expect(send).toBeEnabled()
  await send.click()
}

const inlineBackground = (page: Page, kind: MarkKind): Promise<string> =>
  page.evaluate((markKind: string) => {
    const mark = document.querySelector(`[data-critic-mark-kind="${markKind}"]`)
    return mark ? window.getComputedStyle(mark).backgroundColor : ''
  }, kind)

/** Dispatches a mouse `pointerover` or `pointerout` on the first element `selector` matches. */
const pointer = (page: Page, selector: string, type: 'pointerover' | 'pointerout') =>
  page
    .locator(selector)
    .first()
    .evaluate(
      (element: HTMLElement, eventType: string) =>
        element.dispatchEvent(new PointerEvent(eventType, { bubbles: true, pointerType: 'mouse' })),
      type
    )

/** Presses a card's action button; the actions run on `pointerdown`. */
async function clickCardAction(page: Page, name: string): Promise<void> {
  const card = commentCards(page).first()
  await expect(card).toBeVisible()
  const action = card.getByRole('button', { name })
  await expect(action).toBeVisible()
  await action.evaluate((button: HTMLElement) =>
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }))
  )
}

test('note comments require explicit action and support resolve/delete with hover linkage', async ({
  page
}) => {
  await openReviewNote(page, 'Review Comments', [
    'review setup line',
    'second setup line',
    'third setup line',
    'fourth setup line',
    'comment target delete target hover target'
  ])

  await selectEditorText(page, 'comment target')
  await editor(page).click()
  await expect(commentComposer(page)).toHaveCount(0)

  await selectEditorText(page, 'comment target')
  const commentTargetTop = await selectedTextTop(page)
  await commentButton(page).click()
  await expectComposerNearSelectedTop(page, commentTargetTop)
  await submitComment(page, 'Tighten this sentence.')

  const rail = reviewRail(page)
  await expect(rail).toContainText('Tighten this sentence.')
  await expect(inlineMark(page, 'comment')).toBeVisible()
  await expect(editor(page)).toContainText('comment target')
  await expect(editor(page)).not.toContainText('{==')

  const commentCard = commentCards(page).first()
  await page.mouse.move(20, 20)
  await expect(commentCard).toHaveAttribute('data-hovered', 'false')
  const clearedCommentBackground = await inlineBackground(page, 'comment')

  const mark = '[data-critic-mark-kind="comment"]'
  await pointer(page, mark, 'pointerover')
  await expect(commentCard).toHaveAttribute('data-hovered', 'true')
  await pointer(page, mark, 'pointerout')
  await expect(commentCard).toHaveAttribute('data-hovered', 'false')

  await pointer(page, '.critic-review-card-comment', 'pointerover')
  await expect(commentCard).toHaveAttribute('data-hovered', 'true')
  await expect.poll(() => inlineBackground(page, 'comment')).not.toBe(clearedCommentBackground)

  await clickCardAction(page, 'Resolve')
  await expect(commentCards(page)).toHaveCount(0)
  await expect(editor(page)).toContainText('comment target')
  await page.keyboard.press(SHORTCUTS.undo)
  await expect(commentCards(page)).toHaveCount(1)
  await expect(rail).toContainText('Tighten this sentence.')
  await expect(inlineMark(page, 'comment')).toBeVisible()
  await clickCardAction(page, 'Resolve')
  await expect(commentCards(page)).toHaveCount(0)

  await selectEditorText(page, 'delete target')
  await commentButton(page).click()
  await submitComment(page, 'Remove only the review card.')
  await expect(rail).toContainText('Remove only the review card.')

  await clickCardAction(page, 'Delete')
  await expect(commentCards(page)).toHaveCount(0)
  await expect(editor(page)).toContainText('delete target')
  await page.keyboard.press(SHORTCUTS.undo)
  await expect(commentCards(page)).toHaveCount(1)
  await expect(rail).toContainText('Remove only the review card.')
  await expect(inlineMark(page, 'comment')).toBeVisible()
})

// Quarantined in Electron too (`test.fixme`, cd9864b8aa): the rail-hosted composer shows the
// mention and the attachment but does not write `mentions=` or `attachments=` to the note file.
test.skip('note comments persist mention and attachment metadata', () => {})
test.skip('journal comments persist mention and attachment metadata', () => {})

test('review rail collapses on narrow note and journal layouts', async ({ app, page }) => {
  await openReviewNote(page, 'Review Responsive', ['responsive note target'])
  await selectEditorText(page, 'responsive note target')
  await commentButton(page).click()
  await submitComment(page, 'Narrow note check.')

  await expect(page.locator('[data-note-layout-rail]')).toBeVisible()
  await setWindowWidth(app, 820, 900)
  await expect(page.locator('[data-note-layout-rail]')).toBeHidden()
  await expect(editor(page)).toBeVisible()

  await setWindowWidth(app, 1440, 900)
  await navigateTo(page, 'journal')
  await expect(editor(page)).toBeVisible({ timeout: 10_000 })
  await editor(page).click()
  await typeInEditor(page, 'responsive journal target')
  await selectEditorText(page, 'responsive journal target')
  await commentButton(page).click()
  await submitComment(page, 'Narrow journal check.')

  await expect(page.locator('[data-journal-review-rail]')).toBeVisible()
  await setWindowWidth(app, 820, 900)
  await expect(page.locator('[data-journal-review-rail]')).toBeHidden()
  await expect(editor(page)).toBeVisible()
})

// #4425: the day's window owns its comment marks in the document, and a day's save (no editor
// id) no longer sets them from its text. A resolved comment leaves the day's file, and text typed
// after the resolve, saved again, does not bring it back.
test('a resolved journal comment leaves the day file and stays out', async ({
  page,
  testVaultPath
}) => {
  await vaultOpen(page)
  await ensureDayPanelClosed(page)
  await navigateTo(page, 'journal')
  await expect(editor(page)).toBeVisible({ timeout: 10_000 })
  const date = await page.evaluate(() => {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  })
  const file = join(testVaultPath, 'journal', `${date}.md`)
  const dayText = () => (existsSync(file) ? readFileSync(file, 'utf8') : '')
  await editor(page).click()
  await typeInEditor(page, 'journal resolve target')
  await selectEditorText(page, 'journal resolve target')
  await commentButton(page).click()
  await submitComment(page, 'Journal resolve check.')
  await expect(reviewRail(page)).toContainText('Journal resolve check.')
  expect(
    await pollUntil(() => dayText().includes('Journal resolve check.'), { timeoutMs: 20_000 })
  ).toBe(true)

  await clickCardAction(page, 'Resolve')
  await expect(commentCards(page)).toHaveCount(0)
  expect(
    await pollUntil(() => !dayText().includes('Journal resolve check.'), { timeoutMs: 20_000 })
  ).toBe(true)

  await editor(page).click()
  await page.keyboard.press('End')
  await typeInEditor(page, ' and after')
  expect(await pollUntil(() => dayText().includes('and after'), { timeoutMs: 20_000 })).toBe(true)
  expect(dayText()).not.toContain('Journal resolve check.')
  await expect(commentCards(page)).toHaveCount(0)
})

test('formats a comment draft from the selection toolbar without cancelling the draft', async ({
  page
}) => {
  await openReviewNote(page, 'Review Format', [
    'format setup line',
    'second setup line',
    'format target line'
  ])

  await selectEditorText(page, 'format target line')
  await commentButton(page).click()

  const draft = commentComposer(page)
  await expect(draft).toBeVisible()
  const input = draft.getByLabel('Add a comment...')
  await input.click()
  await typeInEditor(page, 'needs a source')

  await selectComposerText(page, 'source')
  await expect(page.locator('[data-comment-format-toolbar]').first()).toBeVisible()
  await page.locator('[data-test="comment-format-bold"]').click()

  // The bubble is portalled to the body, so clicking it must not trip the composer's
  // outside-pointerdown auto-cancel.
  await expect(draft).toBeVisible()
  await expect(input.locator('strong')).toHaveText('source')

  await draft.getByLabel('Send comment').click()
  await expect(reviewRail(page)).toContainText('needs a source')
  await expect(reviewRail(page).locator('.critic-review-body strong')).toHaveText('source')
})
