// @ts-nocheck - E2E exercises new comments API before generated preload types catch up
import * as fs from 'fs'
import * as path from 'path'
import { test, expect } from './fixtures'
import {
  createNote,
  navigateTo,
  SELECTORS,
  waitForAppReady,
  waitForVaultReady
} from './utils/electron-helpers'

async function selectEditorText(page, text: string): Promise<void> {
  await page.evaluate((selectedText) => {
    const root = document.querySelector('[aria-label="Rich text editor"]')
    if (!root) throw new Error('rich text editor not found')

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node: Text | null = null
    let start = -1
    while ((node = walker.nextNode() as Text | null)) {
      start = node.data.indexOf(selectedText)
      if (start >= 0) break
    }
    if (!node || start < 0) throw new Error(`text not found: ${selectedText}`)

    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, start + selectedText.length)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  }, text)
}

async function createSelectionComment(page, quote: string, body: string): Promise<void> {
  await selectEditorText(page, quote)
  await page.getByRole('button', { name: 'Add comment' }).click()
  await expect(page.getByTestId('comment-composer')).toBeVisible()
  await expect(page.getByTestId('comment-composer-quote')).toContainText(quote)
  await page.getByLabel('Comment body').fill(body)
  await page.getByRole('button', { name: 'Save comment' }).click()
}

test.describe('Comments MVP', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
  })

  test('creates a sidecar note comment from selected text without changing markdown', async ({
    page,
    testVaultPath
  }) => {
    const quote = 'personal comment target'
    const body = 'Review [[Getting Started]] and https://example.com/reference'
    const title = `Comments Note ${Date.now()}`

    await createNote(page, title, `This paragraph has a ${quote} for the MVP.`)

    const note = await page.evaluate(async (expectedTitle) => {
      const result = await window.api.notes.list({ limit: 100 })
      return result.notes.find((candidate) => candidate.title === expectedTitle)
    }, title)
    expect(note?.id).toBeTruthy()

    await createSelectionComment(page, quote, body)

    const panel = page.getByTestId('comments-panel')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText(quote)
    await expect(panel).toContainText(body)

    const highlight = page.locator('[data-comment-highlight="true"]').filter({ hasText: quote })
    await expect(highlight).toBeVisible()
    await highlight.click()
    await expect(page.getByTestId('comment-card').filter({ hasText: body })).toHaveAttribute(
      'data-active',
      'true'
    )

    const comments = await page.evaluate(
      (targetId) => window.api.comments.list({ targetType: 'note', targetId }),
      note.id
    )
    expect(comments).toHaveLength(1)
    expect(comments[0]).toMatchObject({
      targetType: 'note',
      targetId: note.id,
      selectedQuote: quote,
      body,
      status: 'open'
    })

    const notePath = path.join(testVaultPath, note.path)
    await expect
      .poll(() => (fs.existsSync(notePath) ? fs.readFileSync(notePath, 'utf8') : ''))
      .toContain(quote)
    const markdown = fs.readFileSync(notePath, 'utf8')
    expect(markdown).not.toContain(body)
    expect(markdown).not.toContain('data-comment')
  })

  test('creates a sidecar journal comment from selected text and keeps it in the panel', async ({
    page,
    testVaultPath
  }) => {
    const date = '2026-05-22'
    const quote = 'journal comment target'
    const body = 'Journal margin note with https://example.com/journal'

    await page.evaluate(
      ({ date, quote }) =>
        window.api.journal.createEntry({
          date,
          content: `Today has a ${quote} for the MVP.`,
          tags: []
        }),
      { date, quote }
    )
    await navigateTo(page, 'journal')

    await createSelectionComment(page, quote, body)

    const entry = await page.evaluate((date) => window.api.journal.getEntry(date), date)
    expect(entry?.id).toBeTruthy()

    await expect(page.getByTestId('comments-panel')).toContainText(body)
    await expect(
      page.locator('[data-comment-highlight="true"]').filter({ hasText: quote })
    ).toBeVisible()

    const comments = await page.evaluate(
      ({ targetId }) => window.api.comments.list({ targetType: 'journal', targetId }),
      { targetId: entry.id }
    )
    expect(comments).toHaveLength(1)
    expect(comments[0]).toMatchObject({
      targetType: 'journal',
      targetId: entry.id,
      selectedQuote: quote,
      body
    })

    const journalMarkdown = fs.readFileSync(
      path.join(testVaultPath, 'journal', `${date}.md`),
      'utf8'
    )
    expect(journalMarkdown).toContain(quote)
    expect(journalMarkdown).not.toContain(body)
    expect(journalMarkdown).not.toContain('data-comment')
  })
})
