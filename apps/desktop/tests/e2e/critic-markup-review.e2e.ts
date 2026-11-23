import * as fs from 'fs'
import * as path from 'path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import {
  createNote,
  ensureDayPanelClosed,
  navigateTo,
  SHORTCUTS,
  waitForAppReady,
  waitForVaultReady
} from './utils/electron-helpers'
import { ready } from './utils/desktop-test-helpers'
import { destroyLaunchedElectron, launchElectronWithWindow } from './utils/electron-lifecycle'
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
    // The review rail needs the full note width; the day panel now defaults open
    // (#625) and would otherwise collapse the rail into the badge flyout.
    await ensureDayPanelClosed(page)
  })

  test('note comments require explicit action and support resolve/delete with hover linkage', async ({
    page
  }) => {
    await createNote(
      page,
      `Review Comments ${Date.now()}`,
      'review setup line\n\nsecond setup line\n\nthird setup line\n\nfourth setup line\n\ncomment target delete target hover target'
    )

    await selectEditorText(page, 'comment target')
    await page.locator(EDITOR_SELECTOR).first().click()
    await expect(commentComposer(page)).toHaveCount(0)

    await selectEditorText(page, 'comment target')
    const commentTargetTop = await selectedTextTop(page)
    await page.locator('[data-test="review-comment"]').last().click()
    await expectComposerNearSelectedTop(page, commentTargetTop)
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

  // An outside change to the file left the review state holding the body from
  // that moment. The next comment saved that copy over the note and erased
  // everything typed after the outside change, and a comment on words typed
  // after it found no place and was dropped (#5568).
  test('a comment keeps text typed after the file changed outside the app', async ({ page }) => {
    const note = await createNoteWithBody(
      page,
      `Review Keeps Typing ${Date.now()}`,
      'first line comment anchor'
    )
    const file = await page.evaluate(async (id) => {
      const vault = (await window.api.vault.getStatus())?.path
      const notePath = (await window.api.notes.get(id))?.path
      return vault && notePath ? { vault, notePath } : null
    }, note.id)
    if (!file) throw new Error('the note has no file')
    // The watcher skips a file for 5 s after the app writes it
    // (`IGNORED_WRITE_TTL_MS`), so the outside change waits that out.
    await page.waitForTimeout(5500)
    fs.appendFileSync(path.join(file.vault, file.notePath), '\n\noutside line\n')
    const editor = page.locator(EDITOR_SELECTOR).first()
    await expect(editor).toContainText('outside line', { timeout: 15000 })

    await editor.click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type(' typed after')
    await expect
      .poll(async () => getNoteFileBodyById(page, note.id), { timeout: 10000 })
      .toContain('typed after')

    await selectEditorText(page, 'comment anchor')
    await page.locator('[data-test="review-comment"]').last().click()
    await submitComment(page, 'Keep the typing.')
    await expect
      .poll(async () => getNoteFileBodyById(page, note.id), { timeout: 10000 })
      .toContain('Keep the typing.')
    // The lost write came from the note page's 1000 ms save debounce, so the
    // body has to stay whole past it.
    await page.waitForTimeout(2500)

    const body = await getNoteFileBodyById(page, note.id)
    expect(body).toContain('typed after')
    expect(body).toContain('Keep the typing.')
    await expect(editor).toContainText('typed after')

    await selectEditorText(page, 'typed after')
    await page.locator('[data-test="review-comment"]').last().click()
    await submitComment(page, 'On new words.')
    await expect(reviewRail(page)).toContainText('On new words.')
    await expect
      .poll(async () => getNoteFileBodyById(page, note.id), { timeout: 10000 })
      .toContain('{==typed after==}')

    await clickCardAction(
      page,
      '.critic-review-card-comment:has-text("Keep the typing.")',
      'Resolve'
    )
    await expect
      .poll(async () => getNoteFileBodyById(page, note.id), { timeout: 10000 })
      .not.toContain('Keep the typing.')
    expect(await getNoteFileBodyById(page, note.id)).toContain('On new words.')
  })

  // Resolving the last comment empties the doc's marks. The review state already
  // held that empty list, so ContentArea's flag that skips writing back what the
  // doc just sent stayed set, and swallowed the next comment: it showed in the
  // rail, never reached the doc or the file, and was gone after a note switch.
  test('a comment added after resolving the last one is saved', async ({ page }) => {
    const note = await createNoteWithBody(
      page,
      `Review Resolve Then Add ${Date.now()}`,
      'alpha target one\nbeta target two'
    )
    const other = await createNoteWithBody(page, `Review Other ${Date.now()}`, 'other note')
    await openNoteByHandle(page, note)

    await addComment(page, 'alpha target', 'First comment.')
    await expect
      .poll(async () => getNoteFileBodyById(page, note.id), { timeout: 10000 })
      .toContain('First comment.')
    await clickCardAction(page, '.critic-review-card-comment', 'Resolve')
    await expect
      .poll(async () => getNoteFileBodyById(page, note.id), { timeout: 10000 })
      .not.toContain('First comment.')

    await addComment(page, 'beta target', 'Second comment.')
    await expect
      .poll(async () => getNoteFileBodyById(page, note.id), { timeout: 10000 })
      .toContain('Second comment.')
    await openNoteByHandle(page, other)
    await openNoteByHandle(page, note)
    await expect(reviewRail(page)).toContainText('Second comment.')
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

  test('formats a comment draft from the selection toolbar without cancelling the draft', async ({
    page
  }) => {
    await createNote(
      page,
      `Review Format ${Date.now()}`,
      'format setup line\n\nsecond setup line\n\nformat target line'
    )

    await selectEditorText(page, 'format target line')
    await page.locator('[data-test="review-comment"]').last().click()

    const draft = commentComposer(page)
    await expect(draft).toBeVisible()
    const commentInput = draft.getByLabel('Add a comment...')
    await commentInput.click()
    await page.keyboard.type('needs a source')

    await selectComposerText(page, 'source')

    const toolbar = page.locator('[data-comment-format-toolbar]').first()
    await expect(toolbar).toBeVisible()

    await page.locator('[data-test="comment-format-bold"]').click()

    // The bubble is portalled to the body, so clicking it must not trip the
    // composer's outside-pointerdown auto-cancel.
    await expect(draft).toBeVisible()
    await expect(commentInput.locator('strong')).toHaveText('source')

    await draft.getByLabel('Send comment').click()
    await expect(reviewRail(page)).toContainText('needs a source')
    await expect(reviewRail(page).locator('.critic-review-body strong')).toHaveText('source')
  })
})

// The doc's `criticMarkupMarks` owns the comments while the note is open. The
// write-back placed each one in the file by its old offsets and text. One whose
// words were edited, or whose word another comment took once the text above
// moved, was left out of the file, came back missing from its refetch, and the
// review state deleted it from the doc. A comment across formatting was never
// placed at all: it held the rendered words, not the markdown (`start **bold`).
// It launches the app twice itself, so it runs outside the describe's fixture app.
test('comments follow edits to their words and survive a restart', async ({ testVaultPath }) => {
  test.setTimeout(240000)
  const comments = [
    'On formatting.',
    'On edited words.',
    'On the second TODO.',
    'On the first TODO.'
  ]
  const first = await launchElectronWithWindow({ testVaultPath })
  let note: Awaited<ReturnType<typeof createNoteWithBody>>
  try {
    const page = await openReviewWindow(first.page)
    note = await createNoteWithBody(page, `Review Marks Restart ${Date.now()}`, 'draft')
    await page.evaluate(() => {
      const editor = (window as unknown as { __memryActiveEditor?: any }).__memryActiveEditor
      const paragraph = (text: string) => ({
        type: 'paragraph',
        content: [{ type: 'text', text, styles: {} }]
      })
      editor.replaceBlocks(editor.document, [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'plain start ', styles: {} },
            { type: 'text', text: 'bold middle', styles: { bold: true } },
            { type: 'text', text: ' plain end', styles: {} }
          ]
        },
        paragraph('alpha target one'),
        paragraph('first TODO item'),
        paragraph('second TODO item')
      ])
    })
    await expect
      .poll(async () => getNoteFileBodyById(page, note.id), { timeout: 10000 })
      .toContain('**bold middle**')

    await addComment(page, 'start ', comments[0], { through: 'bold' })
    await addComment(page, 'alpha target', comments[1])
    await addComment(page, 'TODO', comments[2], { nth: 1 })
    await addComment(page, 'TODO', comments[3])
    await expect
      .poll(async () => getNoteFileBodyById(page, note.id), { timeout: 10000 })
      .toContain('{==start **bold==}')

    // Inside `alpha target`, and above both TODO comments.
    await putCursorInBlock(page, 1, 'start')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type('X')
    await expect
      .poll(async () => getNoteFileBodyById(page, note.id), { timeout: 10000 })
      .toContain('{==alXpha target==}')
    await page.waitForTimeout(2000)
    for (const body of comments) await expect(reviewRail(page)).toContainText(body)
  } finally {
    await destroyLaunchedElectron(first)
  }

  const second = await launchElectronWithWindow({ testVaultPath })
  try {
    const page = await openReviewWindow(second.page)
    await openNoteByHandle(page, note)
    for (const body of comments) await expect(reviewRail(page)).toContainText(body)

    // The first edit writes the file back, and the review state refetches it.
    await putCursorInBlock(page, 3, 'end')
    await page.keyboard.type(' typed after restart')
    await expect
      .poll(async () => getNoteFileBodyById(page, note.id), { timeout: 10000 })
      .toContain('typed after restart')
    await page.waitForTimeout(2000)
    for (const body of comments) await expect(reviewRail(page)).toContainText(body)
    expect((await docCommentBodies(page)).toSorted()).toEqual(comments.toSorted())
    const file = await getNoteFileBodyById(page, note.id)
    expect(file).toMatch(/plain \{==start \*\*bold==\}\{>>[^<]*On formatting\.<<\} middle\*\*/)
    expect(file).toMatch(/\{==alXpha target==\}\{>>[^<]*On edited words\.<<\} one/)
    expect(file).toMatch(/first \{==TODO==\}\{>>[^<]*On the first TODO\.<<\} item/)
    expect(file).toMatch(/second \{==TODO==\}\{>>[^<]*On the second TODO\.<<\} item/)
    await expect
      .poll(async () => highlightedTexts(page))
      .toEqual(['TODO', 'TODO', 'alXpha target', 'start bold'])
  } finally {
    await destroyLaunchedElectron(second)
  }
})

// The journal page binds its review state to the day's doc as the note page
// does, and the day's file has its own write-back.
test('journal comments follow edits, resolve, and survive a restart', async ({ testVaultPath }) => {
  test.setTimeout(240000)
  const first = await launchElectronWithWindow({ testVaultPath })
  try {
    const page = await openJournal(
      first.page,
      'journal start **bold middle** end\n\njournal target words'
    )
    await addComment(page, 'start ', 'On journal formatting.', { through: 'bold' })
    await addComment(page, 'target words', 'Resolve me.')
    await expect.poll(async () => currentJournalEntryContent(page)).toContain('Resolve me.')
    await clickCardAction(page, '.critic-review-card-comment:has-text("Resolve me.")', 'Resolve')
    await expect.poll(async () => currentJournalEntryContent(page)).not.toContain('Resolve me.')
    await addComment(page, 'journal target', 'On the journal target.')

    await putCursorInBlock(page, 1, 'start')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type('X')
    await expect
      .poll(async () => currentJournalEntryContent(page), { timeout: 10000 })
      .toContain('{==joXurnal target==}')
  } finally {
    await destroyLaunchedElectron(first)
  }

  const second = await launchElectronWithWindow({ testVaultPath })
  try {
    const page = await openJournal(second.page, null)
    await putCursorInBlock(page, 1, 'end')
    await page.keyboard.type(' after restart')
    await expect
      .poll(async () => currentJournalEntryContent(page), { timeout: 10000 })
      .toContain('after restart')
    await page.waitForTimeout(2000)
    const rail = reviewRail(page)
    await expect(rail).toContainText('On journal formatting.')
    await expect(rail).toContainText('On the journal target.')
    await expect(rail).not.toContainText('Resolve me.')
    const file = await currentJournalEntryContent(page)
    expect(file).toMatch(
      /journal \{==start \*\*bold==\}\{>>[^<]*On journal formatting\.<<\} middle/
    )
    expect(file).toMatch(/\{==joXurnal target==\}\{>>[^<]*On the journal target\.<<\} words/)
    await expect.poll(async () => highlightedTexts(page)).toEqual(['joXurnal target', 'start bold'])
  } finally {
    await destroyLaunchedElectron(second)
  }
})

/** Today's journal page, after writing `content` to it unless null. */
async function openJournal(window: Page, content: string | null): Promise<Page> {
  const page = await openReviewWindow(window)
  if (content !== null) await writeCurrentJournalEntry(page, content)
  await navigateTo(page, 'journal')
  await expect(page.locator(EDITOR_SELECTOR).first()).toContainText('target words')
  return page
}

/** The window the describe's `beforeEach` prepares, for a test that launches its own app. */
async function openReviewWindow(page: Page): Promise<Page> {
  await page.setViewportSize({ width: 1440, height: 960 })
  await ready(page)
  await ensureDayPanelClosed(page)
  return page
}

/**
 * Selects `targetText` in the `nth` text node holding it, or from its start to
 * the end of `through` in a later text node.
 */
async function selectEditorText(
  page: Page,
  targetText: string,
  { nth = 0, through }: { nth?: number; through?: string } = {}
): Promise<void> {
  const editor = page.locator(EDITOR_SELECTOR).first()
  await editor.waitFor({ state: 'visible', timeout: 10000 })
  await editor.click()

  const didSelect = await page.evaluate(
    ({ editorSelector, text, occurrence, endText }) => {
      const root = document.querySelector(editorSelector)
      if (!root) return false

      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let start: { node: Node; offset: number } | null = null
      let end: { node: Node; offset: number } | null = null
      let seen = 0
      let node: Node | null
      while (!end && (node = walker.nextNode())) {
        const value = node.textContent ?? ''
        if (!start) {
          const index = value.indexOf(text)
          if (index === -1 || seen++ < occurrence) continue
          start = { node, offset: index }
          if (endText === null) end = { node, offset: index + text.length }
          continue
        }
        const index = value.indexOf(endText ?? '')
        if (index !== -1) end = { node, offset: index + (endText ?? '').length }
      }
      if (!start || !end) return false

      if (root instanceof HTMLElement) root.focus()

      const range = document.createRange()
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset)

      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)

      root.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
      root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      document.dispatchEvent(new Event('selectionchange', { bubbles: true }))
      return true
    },
    { editorSelector: EDITOR_SELECTOR, text: targetText, occurrence: nth, endText: through ?? null }
  )

  expect(didSelect).toBe(true)
  await expect(page.locator('[data-test="review-comment"]').last()).toBeVisible()
}

async function addComment(
  page: Page,
  targetText: string,
  body: string,
  options?: { nth?: number; through?: string }
): Promise<void> {
  await selectEditorText(page, targetText, options)
  await page.locator('[data-test="review-comment"]').last().click()
  await submitComment(page, body)
  await expect(reviewRail(page)).toContainText(body)
}

async function putCursorInBlock(page: Page, index: number, at: 'start' | 'end'): Promise<void> {
  await page.evaluate(
    ({ blockIndex, placement }) => {
      const editor = (window as unknown as { __memryActiveEditor?: any }).__memryActiveEditor
      editor.setTextCursorPosition(editor.document[blockIndex], placement)
      editor.focus()
    },
    { blockIndex: index, placement: at }
  )
}

/** Comment bodies in the `criticMarkupMarks` array of the doc the open editor is bound to. */
async function docCommentBodies(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const editor = (window as unknown as { __memryActiveEditor?: any }).__memryActiveEditor
    const state = editor?._tiptapEditor?.state
    if (!state) throw new Error('no active editor')
    for (const plugin of state.plugins) {
      const pluginState = plugin.getState?.(state)
      if (pluginState?.doc?.getArray && pluginState.type) {
        const marks = pluginState.doc.getArray('criticMarkupMarks').toJSON() as Array<{
          kind: string
          body?: string
        }>
        return marks.filter((mark) => mark.kind === 'comment').map((mark) => mark.body ?? '')
      }
    }
    throw new Error('the editor is not bound to a Y.Doc')
  })
}

async function selectedTextTop(page: Page): Promise<number> {
  const top = await page.evaluate(() => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return null

    const range = selection.getRangeAt(0)
    const rect =
      Array.from(range.getClientRects()).find((item) => item.width > 0 && item.height > 0) ??
      range.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    return rect.top
  })

  expect(top).not.toBeNull()
  return top!
}

async function submitComment(page: Page, body: string): Promise<void> {
  const draft = commentComposer(page)
  await expect(draft).toBeVisible()

  const commentInput = draft.getByLabel('Add a comment...')
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
  const draft = commentComposer(page)
  await expect(draft).toBeVisible()

  const commentInput = draft.getByLabel('Add a comment...')
  await expect(commentInput).toBeVisible()
  await commentInput.click()
  await page.keyboard.type(`See @${mention.title}`)

  const option = page.locator('[role="option"]').filter({ hasText: mention.title }).first()
  await expect(option).toBeVisible({ timeout: 10000 })
  await expect(option).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(option).toBeHidden()

  const attachButton = draft.locator('button[aria-label="Attach file"]')
  await expect(attachButton).toBeEnabled()
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

async function selectComposerText(page: Page, targetText: string): Promise<void> {
  const didSelect = await page.evaluate((text) => {
    const root = document.querySelector('.critic-comment-editor .ProseMirror')
    if (!(root instanceof HTMLElement)) return false

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      const index = (node.textContent ?? '').indexOf(text)
      if (index === -1) continue

      root.focus()
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
  }, targetText)

  expect(didSelect).toBe(true)
}

function reviewRail(page: Page) {
  // The rail's aria-label is `comments.railAria` ("Comments"). It used to read
  // "Comments and suggestions"; #507 removed the suggestion feature and renamed
  // it, but this helper wasn't updated, so every rail lookup silently missed.
  return page.getByRole('complementary', { name: 'Comments', exact: true })
}

function commentComposer(page: Page) {
  // The draft composer lives in the review rail when it is expanded, or in a
  // near-selection floating flyout when the rail has responsive-collapsed
  // (review-badge-layer.tsx). Match it in either place.
  return page.locator('.critic-comment-composer').first()
}

async function expectComposerNearSelectedTop(page: Page, selectedTop: number): Promise<void> {
  const composer = commentComposer(page)
  await expect(composer).toBeVisible()

  // Only the flyout variant is anchored near the selection; the rail-hosted
  // composer sits in the aside, so skip the positional check there.
  const inFlyout = await page
    .locator('.critic-review-flyout-draft .critic-comment-composer')
    .count()
  if (inFlyout === 0) return

  await expect
    .poll(async () => {
      return composer.evaluate((element, expectedTop) => {
        return Math.abs(element.getBoundingClientRect().top - expectedTop)
      }, selectedTop)
    })
    .toBeLessThan(120)
}

/** The words each review mark highlights in the editor, sorted. */
async function highlightedTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const texts = new Map<string, string>()
    for (const element of document.querySelectorAll<HTMLElement>(
      '.critic-mark-inline[data-critic-mark-id]'
    )) {
      const id = element.dataset.criticMarkId ?? ''
      texts.set(id, (texts.get(id) ?? '') + element.textContent)
    }
    return [...texts.values()].toSorted()
  })
}

function inlineMark(page: Page, kind: 'addition' | 'deletion' | 'substitution' | 'comment') {
  return page.locator(`[data-critic-mark-kind="${kind}"]`).first()
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

async function clickCardAction(page: Page, cardSelector: string, name: string): Promise<void> {
  const card = page.locator(cardSelector).first()
  await expect(card).toBeVisible()
  const action = card.getByRole('button', { name })
  await expect(action).toBeVisible()
  await action.dispatchEvent('pointerdown', { bubbles: true, pointerType: 'mouse' })
}
