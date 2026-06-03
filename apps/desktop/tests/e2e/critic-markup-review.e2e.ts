import * as fs from 'fs'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import {
  createNote,
  navigateTo,
  SHORTCUTS,
  waitForAppReady,
  waitForVaultReady
} from './utils/electron-helpers'
import {
  createNoteWithBody,
  getNoteFileBodyById,
  openNoteByHandle
} from './utils/note-sync-helpers'

const EDITOR_SELECTOR =
  '[aria-label="Rich text editor"] [contenteditable="true"], .bn-editor[contenteditable="true"], .bn-editor'

test.describe('CriticMarkup review flows', () => {
  test.setTimeout(120000)

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 })
    await waitForAppReady(page)
    await waitForVaultReady(page)
  })

  test('note comments require explicit action and support resolve/delete with hover linkage', async ({
    page
  }) => {
    await createNote(
      page,
      `Review Comments ${Date.now()}`,
      'comment target delete target hover target'
    )

    await selectEditorText(page, 'comment target')
    await page.locator(EDITOR_SELECTOR).first().click()
    await expect(page.locator('.critic-review-card-draft')).toHaveCount(0)

    await selectEditorText(page, 'comment target')
    await page.locator('[data-test="review-comment"]').last().click()
    await submitComment(page, 'Tighten this sentence.')

    const rail = reviewRail(page)
    await expect(rail).toContainText('Tighten this sentence.')
    await expect(inlineMark(page, 'comment')).toBeVisible()
    await expect(page.locator(EDITOR_SELECTOR).first()).toContainText('comment target')
    await expect(page.locator(EDITOR_SELECTOR).first()).not.toContainText('{==')

    const commentCard = page.locator('.critic-review-card-comment').first()
    await page.mouse.move(20, 20)
    await expect(commentCard).toHaveAttribute('data-hovered', 'false')
    const clearedCommentBackground = await inlineBackground(page, 'comment')

    await inlineMark(page, 'comment').dispatchEvent('pointerover', {
      bubbles: true,
      pointerType: 'mouse'
    })
    await expect(commentCard).toHaveAttribute('data-hovered', 'true')

    await inlineMark(page, 'comment').dispatchEvent('pointerout', {
      bubbles: true,
      pointerType: 'mouse'
    })
    await expect(commentCard).toHaveAttribute('data-hovered', 'false')

    await commentCard.dispatchEvent('pointerover', { bubbles: true, pointerType: 'mouse' })
    await expect(commentCard).toHaveAttribute('data-hovered', 'true')
    await expect
      .poll(async () => inlineBackground(page, 'comment'))
      .not.toBe(clearedCommentBackground)

    await clickCardAction(page, '.critic-review-card-comment', 'Resolve')
    await expect(page.locator('.critic-review-card-comment')).toHaveCount(0)
    await expect(page.locator(EDITOR_SELECTOR).first()).toContainText('comment target')
    await page.keyboard.press(SHORTCUTS.undo)
    await expect(page.locator('.critic-review-card-comment')).toHaveCount(1)
    await expect(rail).toContainText('Tighten this sentence.')
    await expect(inlineMark(page, 'comment')).toBeVisible()
    await clickCardAction(page, '.critic-review-card-comment', 'Resolve')
    await expect(page.locator('.critic-review-card-comment')).toHaveCount(0)

    await selectEditorText(page, 'delete target')
    await page.locator('[data-test="review-comment"]').last().click()
    await submitComment(page, 'Remove only the review card.')
    await expect(rail).toContainText('Remove only the review card.')

    await clickCardAction(page, '.critic-review-card-comment', 'Delete')
    await expect(page.locator('.critic-review-card-comment')).toHaveCount(0)
    await expect(page.locator(EDITOR_SELECTOR).first()).toContainText('delete target')
    await page.keyboard.press(SHORTCUTS.undo)
    await expect(page.locator('.critic-review-card-comment')).toHaveCount(1)
    await expect(rail).toContainText('Remove only the review card.')
    await expect(inlineMark(page, 'comment')).toBeVisible()
  })

  test('note comments persist mention and attachment metadata', async ({ page }, testInfo) => {
    const mentionTarget = await createNoteWithBody(
      page,
      `Review Mention Target ${Date.now()}`,
      'mentionable target body'
    )
    await waitForRefPickerResult(page, mentionTarget.title)

    const reviewedNote = await createNoteWithBody(
      page,
      `Review Mention Host ${Date.now()}`,
      'mention comment target'
    )
    const attachmentPath = testInfo.outputPath('note-comment-attachment.txt')
    fs.writeFileSync(attachmentPath, 'note comment attachment')

    await selectEditorText(page, 'mention comment target')
    await page.locator('[data-test="review-comment"]').last().click()
    await submitCommentWithMentionAndAttachment(page, mentionTarget, attachmentPath)

    const rail = reviewRail(page)
    await expect(rail.getByRole('link', { name: `@${mentionTarget.title}` })).toHaveAttribute(
      'href',
      `memry://note/${mentionTarget.id}`
    )
    await expect(rail).toContainText('note-comment-attachment.txt')
    await expect
      .poll(async () => getNoteFileBodyById(page, reviewedNote.id), { timeout: 5000 })
      .toContain('mentions=')
    await expect
      .poll(async () => getNoteFileBodyById(page, reviewedNote.id), { timeout: 5000 })
      .toContain('attachments=')
  })

  test('note suggestion mode handles pill lifecycle, additions, substitutions, and alignment', async ({
    page
  }) => {
    await createNote(
      page,
      `Review Suggestions ${Date.now()}`,
      'addition anchor wrong rejectwrong align target'
    )

    await selectEditorText(page, 'addition anchor')
    await page.locator('[data-test="review-suggest"]').last().click()
    await expect(page.getByText('Suggesting')).toBeVisible()

    await placeCursorAtEditorEnd(page)
    await page.keyboard.type('RejectMe')
    await expect(expectCard(page, 'addition')).toContainText('RejectMe')
    await clickCardAction(page, '.critic-review-card-addition', 'Reject')
    await expect(page.locator('.critic-review-card-addition')).toHaveCount(0)
    await expect(page.locator(EDITOR_SELECTOR).first()).not.toContainText('RejectMe')
    await page.keyboard.press(SHORTCUTS.undo)
    await expect(expectCard(page, 'addition')).toContainText('RejectMe')
    await expect(page.locator(EDITOR_SELECTOR).first()).toContainText('RejectMe')
    await clickCardAction(page, '.critic-review-card-addition', 'Reject')
    await expect(page.locator('.critic-review-card-addition')).toHaveCount(0)

    await placeCursorAtEditorEnd(page)
    await page.keyboard.type('KeepMe')
    await expect(expectCard(page, 'addition')).toContainText('KeepMe')
    await clickCardAction(page, '.critic-review-card-addition', 'Accept')
    await expect(page.locator('.critic-review-card-addition')).toHaveCount(0)
    await expect(page.locator(EDITOR_SELECTOR).first()).toContainText('KeepMe')
    await page.keyboard.press(SHORTCUTS.undo)
    await expect(expectCard(page, 'addition')).toContainText('KeepMe')
    await expect(page.locator(EDITOR_SELECTOR).first()).toContainText('KeepMe')
    await clickCardAction(page, '.critic-review-card-addition', 'Accept')
    await expect(page.locator('.critic-review-card-addition')).toHaveCount(0)

    await selectEditorText(page, 'wrong')
    await page.keyboard.insertText('right')
    await expect(expectCard(page, 'substitution')).toContainText('wrong -> right')
    await clickCardAction(page, '.critic-review-card-substitution', 'Accept')
    await expect(page.locator('.critic-review-card-substitution')).toHaveCount(0)
    await expect(page.locator(EDITOR_SELECTOR).first()).toContainText('right')
    await page.keyboard.press(SHORTCUTS.undo)
    await expect(expectCard(page, 'substitution')).toContainText('wrong -> right')
    await expect(page.locator(EDITOR_SELECTOR).first()).toContainText('right')
    await clickCardAction(page, '.critic-review-card-substitution', 'Accept')
    await expect(page.locator('.critic-review-card-substitution')).toHaveCount(0)

    await selectEditorText(page, 'rejectwrong')
    await page.keyboard.insertText('rejectright')
    await expect(expectCard(page, 'substitution')).toContainText('rejectwrong -> rejectright')
    await clickCardAction(page, '.critic-review-card-substitution', 'Reject')
    await expect(page.locator('.critic-review-card-substitution')).toHaveCount(0)
    await expect(page.locator(EDITOR_SELECTOR).first()).toContainText('rejectwrong')
    await expect(page.locator(EDITOR_SELECTOR).first()).not.toContainText('rejectright')
    await page.keyboard.press(SHORTCUTS.undo)
    await expect(expectCard(page, 'substitution')).toContainText('rejectwrong -> rejectright')
    await expect(page.locator(EDITOR_SELECTOR).first()).toContainText('rejectright')
    await clickCardAction(page, '.critic-review-card-substitution', 'Reject')
    await expect(page.locator('.critic-review-card-substitution')).toHaveCount(0)

    await selectEditorText(page, 'align target')
    await page.locator('[data-test="review-comment"]').last().click()
    await submitComment(page, 'Alignment check.')
    await expectRailNearInlineMark(page, 'comment')

    await page.getByRole('button', { name: 'Exit suggestion mode' }).click()
    await expect(page.getByText('Suggesting')).toHaveCount(0)
    await placeCursorAtEditorEnd(page)
    await page.keyboard.type(' PlainText')
    await expect(page.locator('.critic-review-card-addition')).toHaveCount(0)
    await expect(page.locator(EDITOR_SELECTOR).first()).toContainText('PlainText')
  })

  test('note suggestion mode anchors repeated one-letter edits to the target text', async ({
    page
  }) => {
    await createNote(
      page,
      `Review Repeated Letter ${Date.now()}`,
      `## Why I keep at it

Three reasons, in increasing order of importance:

1. **Information** — useful, but Wikipedia handles this

2. **Empathy** — fiction is a flight simulator for other lives`
    )

    await selectEditorText(page, 'Wikipedia')
    await page.locator('[data-test="review-suggest"]').last().click()
    await expect(page.getByText('Suggesting')).toBeVisible()

    await placeCursorInEditorText(page, 'flight', 3)
    await page.keyboard.press('Backspace')
    await expect(expectCard(page, 'deletion')).toContainText('i')
    await expect(inlineMark(page, 'deletion')).toBeVisible()
    await expect.poll(async () => inlineMarkContext(page, 'deletion')).toContain('flight')
    await expect.poll(async () => inlineMarkContext(page, 'deletion')).not.toContain('Why I keep')

    await placeCursorInEditorText(page, 'Wikipedia', 'Wikip'.length)
    await page.keyboard.type('p')
    await expect(expectCard(page, 'addition')).toContainText('p')
    await expect(inlineMark(page, 'addition')).toBeVisible()
    await expect.poll(async () => inlineMarkContext(page, 'addition')).toContain('Wikippedia')
    await expect.poll(async () => inlineMarkContext(page, 'addition')).not.toContain('Why I keep')
  })

  test('note suggestion mode merges repeated deletions and persists after reopening', async ({
    page
  }) => {
    const note = await createNoteWithBody(
      page,
      `Review Persistence ${Date.now()}`,
      'book Wikipedia'
    )

    await selectEditorText(page, 'book')
    await page.locator('[data-test="review-suggest"]').last().click()
    await expect(page.getByText('Suggesting')).toBeVisible()

    await placeCursorInEditorText(page, 'book', 'book'.length)
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Backspace')
    await expect(page.locator('.critic-review-card-deletion')).toHaveCount(1)
    await expect(expectCard(page, 'deletion')).toContainText('ook')

    await placeCursorInEditorText(page, 'Wikipedia', 'Wikip'.length)
    await page.keyboard.type('p')
    await expect(expectCard(page, 'addition')).toContainText('p')

    await expect
      .poll(async () => getNoteFileBodyById(page, note.id))
      .toContain('b{--ook--} Wikip{++p++}edia')
    await expect(page.locator(EDITOR_SELECTOR).first()).not.toContainText('{--')
    await expect(page.locator(EDITOR_SELECTOR).first()).not.toContainText('{++')

    await navigateTo(page, 'journal')
    await openNoteByHandle(page, note)

    await expect(page.locator('.critic-review-card-deletion')).toHaveCount(1)
    await expect(expectCard(page, 'deletion')).toContainText('ook')
    await expect(expectCard(page, 'addition')).toContainText('p')
    await expect(inlineMark(page, 'deletion')).toBeVisible()
    await expect(inlineMark(page, 'addition')).toBeVisible()
    await expect(page.locator(EDITOR_SELECTOR).first()).not.toContainText('{--')
    await expect(page.locator(EDITOR_SELECTOR).first()).not.toContainText('{++')
  })

  test('note suggestion mode keeps same-location delete and add marks after autosave', async ({
    page
  }) => {
    const note = await createNoteWithBody(page, `Review Same Spot ${Date.now()}`, 'still this')

    await selectEditorText(page, 'still')
    await page.locator('[data-test="review-suggest"]').last().click()
    await expect(page.getByText('Suggesting')).toBeVisible()

    await selectEditorText(page, 'still')
    await page.keyboard.press('Backspace')
    await placeCursorInEditorText(page, 'still', 'still'.length)
    await page.keyboard.type('here')

    await expect(expectCard(page, 'deletion')).toContainText('still')
    await expect(expectCard(page, 'addition')).toContainText('here')

    await expect
      .poll(async () => getNoteFileBodyById(page, note.id), { timeout: 4000 })
      .toContain('{--still--}{++here++}')

    await page.waitForTimeout(1400)
    await expect(expectCard(page, 'deletion')).toContainText('still')
    await expect(expectCard(page, 'addition')).toContainText('here')
    await expect
      .poll(async () => getNoteFileBodyById(page, note.id), { timeout: 4000 })
      .toContain('{--still--}{++here++}')

    await placeCursorInEditorText(page, 'this', 'this'.length)
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Backspace')
    await placeCursorInEditorText(page, 'this', 'this'.length)
    await page.keyboard.type('at')

    await expect(reviewCardWithText(page, 'deletion', 'is')).toBeVisible()
    await expect(reviewCardWithText(page, 'addition', 'at')).toBeVisible()

    await page.waitForTimeout(1400)
    await expect(reviewCardWithText(page, 'deletion', 'is')).toBeVisible()
    await expect(reviewCardWithText(page, 'addition', 'at')).toBeVisible()
    await expect
      .poll(async () => getNoteFileBodyById(page, note.id), { timeout: 4000 })
      .toContain('th{--is--}{++at++}')
  })

  test('journal comments and deletion suggestions cover accept and reject paths', async ({
    page
  }) => {
    await navigateTo(page, 'journal')

    const editor = page.locator(EDITOR_SELECTOR).first()
    await editor.waitFor({ state: 'visible', timeout: 10000 })
    await editor.click()
    await page.keyboard.type('journal comment target keep deletion remove deletion')
    await page.waitForTimeout(300)

    await selectEditorText(page, 'journal comment target')
    await page.locator('[data-test="review-comment"]').last().click()

    await submitComment(page, 'Journal comment.')
    await expect(reviewRail(page)).toContainText('Journal comment.')

    await selectEditorText(page, 'journal comment target')
    await page.locator('[data-test="review-suggest"]').last().click()
    await expect(page.getByText('Suggesting')).toBeVisible()

    await selectEditorText(page, 'keep deletion')
    await page.keyboard.press('Backspace')
    await expect(expectCard(page, 'deletion')).toContainText('keep deletion')
    await expect(editor).toContainText('keep deletion')
    await clickCardAction(page, '.critic-review-card-deletion', 'Reject')
    await expect(page.locator('.critic-review-card-deletion')).toHaveCount(0)
    await expect(editor).toContainText('keep deletion')

    await selectEditorText(page, 'remove deletion')
    await page.keyboard.press('Backspace')
    await expect(expectCard(page, 'deletion')).toContainText('remove deletion')
    await expect(editor).toContainText('remove deletion')

    await clickCardAction(page, '.critic-review-card-deletion', 'Accept')
    await expect(editor).not.toContainText('remove deletion')
    await page.keyboard.press(SHORTCUTS.undo)
    await expect(editor).toContainText('remove deletion')
    await expect(expectCard(page, 'deletion')).toContainText('remove deletion')
  })

  test('journal comments persist mention and attachment metadata', async ({ page }, testInfo) => {
    const mentionTarget = await createNoteWithBody(
      page,
      `Journal Mention Target ${Date.now()}`,
      'journal mention target body'
    )
    await waitForRefPickerResult(page, mentionTarget.title)

    const journalContent = 'journal mention comment target'
    await writeCurrentJournalEntry(page, journalContent)
    await navigateTo(page, 'journal')
    const editor = page.locator(EDITOR_SELECTOR).first()
    await editor.waitFor({ state: 'visible', timeout: 10000 })
    await expect(editor).toContainText(journalContent)

    const attachmentPath = testInfo.outputPath('journal-comment-attachment.txt')
    fs.writeFileSync(attachmentPath, 'journal comment attachment')

    await selectEditorText(page, journalContent)
    await page.locator('[data-test="review-comment"]').last().click()
    await submitCommentWithMentionAndAttachment(page, mentionTarget, attachmentPath)

    const rail = reviewRail(page)
    await expect(rail.getByRole('link', { name: `@${mentionTarget.title}` })).toHaveAttribute(
      'href',
      `memry://note/${mentionTarget.id}`
    )
    await expect(rail).toContainText('journal-comment-attachment.txt')
    await expect
      .poll(async () => currentJournalEntryContent(page), { timeout: 5000 })
      .toContain('mentions=')
    await expect
      .poll(async () => currentJournalEntryContent(page), { timeout: 5000 })
      .toContain('attachments=')
  })

  test('review rail collapses on narrow note and journal layouts', async ({ page }) => {
    await createNote(page, `Review Responsive ${Date.now()}`, 'responsive note target')
    await selectEditorText(page, 'responsive note target')
    await page.locator('[data-test="review-comment"]').last().click()
    await submitComment(page, 'Narrow note check.')

    await expect(page.locator('[data-note-layout-rail]')).toBeVisible()
    await page.setViewportSize({ width: 820, height: 900 })
    await expect(page.locator('[data-note-layout-rail]')).toBeHidden()
    await expect(page.locator(EDITOR_SELECTOR).first()).toBeVisible()

    await page.setViewportSize({ width: 1440, height: 960 })
    await navigateTo(page, 'journal')
    const editor = page.locator(EDITOR_SELECTOR).first()
    await editor.waitFor({ state: 'visible', timeout: 10000 })
    await editor.click()
    await page.keyboard.type('responsive journal target')
    await selectEditorText(page, 'responsive journal target')
    await page.locator('[data-test="review-comment"]').last().click()
    await submitComment(page, 'Narrow journal check.')

    await expect(page.locator('[data-journal-review-rail]')).toBeVisible()
    await page.setViewportSize({ width: 820, height: 900 })
    await expect(page.locator('[data-journal-review-rail]')).toBeHidden()
    await expect(editor).toBeVisible()
  })
})

async function selectEditorText(page: Page, targetText: string): Promise<void> {
  const editor = page.locator(EDITOR_SELECTOR).first()
  await editor.waitFor({ state: 'visible', timeout: 10000 })
  await editor.click()

  const didSelect = await page.evaluate(
    ({ editorSelector, text }) => {
      const root = document.querySelector(editorSelector)
      if (!root) return false

      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let node: Node | null
      while ((node = walker.nextNode())) {
        const value = node.textContent ?? ''
        const index = value.indexOf(text)
        if (index === -1) continue

        if (root instanceof HTMLElement) root.focus()

        const range = document.createRange()
        range.setStart(node, index)
        range.setEnd(node, index + text.length)

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
    { editorSelector: EDITOR_SELECTOR, text: targetText }
  )

  expect(didSelect).toBe(true)
  await expect(page.locator('[data-test="review-comment"]').last()).toBeVisible()
}

async function placeCursorAtEditorEnd(page: Page): Promise<void> {
  const didPlaceCursor = await page.evaluate((editorSelector) => {
    const root = document.querySelector(editorSelector)
    if (!root) return false

    if (root instanceof HTMLElement) root.focus()

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let lastTextNode: Node | null = null
    let node: Node | null
    while ((node = walker.nextNode())) {
      if ((node.textContent ?? '').length > 0) lastTextNode = node
    }

    const range = document.createRange()
    if (lastTextNode) {
      range.setStart(lastTextNode, (lastTextNode.textContent ?? '').length)
    } else {
      range.setStart(root, root.childNodes.length)
    }
    range.collapse(true)

    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    document.dispatchEvent(new Event('selectionchange', { bubbles: true }))
    return true
  }, EDITOR_SELECTOR)

  expect(didPlaceCursor).toBe(true)
}

async function placeCursorInEditorText(
  page: Page,
  targetText: string,
  targetOffset: number
): Promise<void> {
  const didPlaceCursor = await page.evaluate(
    ({ editorSelector, text, offset }) => {
      const root = document.querySelector(editorSelector)
      if (!root) return false

      const chunks: Array<{ node: Node; start: number; end: number }> = []
      let visibleText = ''
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let node: Node | null
      while ((node = walker.nextNode())) {
        const value = node.textContent ?? ''
        chunks.push({ node, start: visibleText.length, end: visibleText.length + value.length })
        visibleText += value
      }

      const index = visibleText.indexOf(text)
      if (index === -1) return false

      const target = index + offset
      const chunk = chunks.find((item) => target >= item.start && target <= item.end)
      if (!chunk) return false

      if (root instanceof HTMLElement) root.focus()

      const range = document.createRange()
      range.setStart(chunk.node, target - chunk.start)
      range.collapse(true)

      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      document.dispatchEvent(new Event('selectionchange', { bubbles: true }))
      return true
    },
    { editorSelector: EDITOR_SELECTOR, text: targetText, offset: targetOffset }
  )

  expect(didPlaceCursor).toBe(true)
}

async function submitComment(page: Page, body: string): Promise<void> {
  const draft = page.locator('.critic-review-card-draft').first()
  await expect(draft).toBeVisible()

  const commentInput = draft.getByLabel('Write a comment...')
  await expect(commentInput).toBeVisible()
  await commentInput.fill(body)

  const sendButton = draft.getByLabel('Send comment')
  await expect(sendButton).toBeEnabled()
  await sendButton.click()
}

async function submitCommentWithMentionAndAttachment(
  page: Page,
  mention: { id: string; title: string },
  attachmentPath: string
): Promise<void> {
  const draft = page.locator('.critic-review-card-draft').first()
  await expect(draft).toBeVisible()

  const commentInput = draft.getByLabel('Write a comment...')
  await expect(commentInput).toBeVisible()
  await commentInput.click()
  await page.keyboard.type(`See @${mention.title}`)

  const option = page.locator('[role="option"]').filter({ hasText: mention.title }).first()
  await expect(option).toBeVisible({ timeout: 10000 })
  await expect(option).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(option).toBeHidden()

  await expect(draft.getByLabel('Attach file')).toBeEnabled()
  await draft.locator('input[type="file"]').setInputFiles(attachmentPath)
  const attachmentName = attachmentPath.split('/').pop()!
  await expect(draft).toContainText(attachmentName)

  const sendButton = draft.getByLabel('Send comment')
  await expect(sendButton).toBeEnabled()
  await sendButton.click()
}

async function waitForRefPickerResult(page: Page, title: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async (query) => {
          const response = await window.api.search.query({ text: query, limit: 20 })
          return response.groups.some((group) => group.results.some((item) => item.title === query))
        }, title),
      { timeout: 15000 }
    )
    .toBe(true)
}

async function writeCurrentJournalEntry(page: Page, content: string): Promise<void> {
  const date = await currentLocalDate(page)
  await page.evaluate(
    async ({ date: journalDate, content: journalContent }) => {
      await window.api.journal.updateEntry({ date: journalDate, content: journalContent })
    },
    { date, content }
  )
}

async function currentJournalEntryContent(page: Page): Promise<string | null> {
  const date = await currentLocalDate(page)
  return page.evaluate(async (journalDate) => {
    const entry = await window.api.journal.getEntry(journalDate)
    return entry?.content ?? null
  }, date)
}

async function currentLocalDate(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const now = new Date()
    return [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0')
    ].join('-')
  })
}

function reviewRail(page: Page) {
  return page.getByRole('complementary', { name: 'Comments and suggestions' })
}

function inlineMark(page: Page, kind: 'addition' | 'deletion' | 'substitution' | 'comment') {
  return page.locator(`[data-critic-mark-kind="${kind}"]`).first()
}

async function inlineMarkContext(
  page: Page,
  kind: 'addition' | 'deletion' | 'substitution' | 'comment'
): Promise<string> {
  return page.evaluate((markKind) => {
    const mark = document.querySelector(`[data-critic-mark-kind="${markKind}"]`)
    const block = mark?.closest('.bn-block-content, p, li, h1, h2, h3, h4, h5, h6')
    return block?.textContent ?? mark?.textContent ?? ''
  }, kind)
}

async function inlineBackground(
  page: Page,
  kind: 'addition' | 'deletion' | 'substitution' | 'comment'
): Promise<string> {
  return page.evaluate((markKind) => {
    const mark = document.querySelector(`[data-critic-mark-kind="${markKind}"]`)
    return mark ? window.getComputedStyle(mark).backgroundColor : ''
  }, kind)
}

function expectCard(page: Page, kind: 'addition' | 'deletion' | 'substitution' | 'comment') {
  return page.locator(`.critic-review-card-${kind}`).first()
}

function reviewCardWithText(
  page: Page,
  kind: 'addition' | 'deletion' | 'substitution' | 'comment',
  text: string
) {
  return page.locator(`.critic-review-card-${kind}`).filter({ hasText: text }).first()
}

async function clickCardAction(page: Page, cardSelector: string, name: string): Promise<void> {
  const card = page.locator(cardSelector).first()
  await expect(card).toBeVisible()
  const action = card.getByRole('button', { name })
  await expect(action).toBeVisible()
  await action.dispatchEvent('pointerdown', { bubbles: true, pointerType: 'mouse' })
}

async function expectRailNearInlineMark(
  page: Page,
  kind: 'addition' | 'deletion' | 'substitution' | 'comment'
): Promise<void> {
  await expect(inlineMark(page, kind)).toBeVisible()
  await expect(page.locator(`.critic-review-card-${kind}`).first()).toBeVisible()

  await expect
    .poll(async () => {
      return page.evaluate((markKind) => {
        const inline = document.querySelector(`[data-critic-mark-kind="${markKind}"]`)
        const card = document.querySelector(`.critic-review-card-${markKind}`)
        if (!inline || !card) return null

        const inlineBox = inline.getBoundingClientRect()
        const cardBox = card.getBoundingClientRect()
        if (inlineBox.width === 0 || cardBox.width === 0) return null

        return {
          deltaY: Math.abs(inlineBox.y - cardBox.y),
          deltaX: cardBox.x - inlineBox.x
        }
      }, kind)
    })
    .toMatchObject({
      deltaY: expect.any(Number),
      deltaX: expect.any(Number)
    })

  const geometry = await page.evaluate((markKind) => {
    const inline = document.querySelector(`[data-critic-mark-kind="${markKind}"]`)
    const card = document.querySelector(`.critic-review-card-${markKind}`)
    const inlineBox = inline?.getBoundingClientRect()
    const cardBox = card?.getBoundingClientRect()
    return {
      deltaY: Math.abs((inlineBox?.y ?? 0) - (cardBox?.y ?? 0)),
      deltaX: (cardBox?.x ?? 0) - (inlineBox?.x ?? 0)
    }
  }, kind)

  expect(geometry.deltaY).toBeLessThan(220)
  expect(geometry.deltaX).toBeGreaterThan(80)
}
