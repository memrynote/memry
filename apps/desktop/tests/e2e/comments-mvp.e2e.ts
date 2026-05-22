// @ts-nocheck - E2E exercises new comments API before generated preload types catch up
import * as fs from 'fs'
import * as path from 'path'
import { test, expect } from './fixtures'
import { navigateTo, SELECTORS, waitForAppReady, waitForVaultReady } from './utils/electron-helpers'

async function createNoteViaApi(page, title: string, content: string) {
  const note = await page.evaluate(
    async ({ title, content }) => {
      const result = await window.api.notes.create({ title, content })
      if (!result.success || !result.note) {
        throw new Error(result.error ?? `Failed to create note "${title}"`)
      }
      return {
        id: result.note.id,
        title: result.note.title,
        path: result.note.path,
        emoji: result.note.emoji ?? null
      }
    },
    { title, content }
  )

  await expect
    .poll(async () =>
      page.evaluate(
        async ({ id, content }) => {
          const loaded = await window.api.notes.get(id)
          return loaded?.content.includes(content) ?? false
        },
        { id: note.id, content }
      )
    )
    .toBe(true)

  return note
}

async function openNoteInUi(page, note: { id: string; title: string; emoji?: string | null }) {
  await page.evaluate((detail) => {
    window.dispatchEvent(new CustomEvent('memry:test-open-note', { detail }))
  }, note)

  await expect(page.getByRole('tab', { name: note.title })).toBeVisible()
  await expect(page.locator(SELECTORS.noteTitle).first()).toHaveValue(note.title)
}

async function getCurrentJournalDate(page): Promise<string> {
  return page.evaluate(() => {
    const today = new Date()
    const year = today.getFullYear()
    const month = String(today.getMonth() + 1).padStart(2, '0')
    const day = String(today.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  })
}

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

async function createSelectionComment(
  page,
  quote: string,
  body: string,
  options: { mentionTitle?: string; attachmentPath?: string } = {}
): Promise<void> {
  await selectEditorText(page, quote)
  await expect(page.getByTestId('comment-composer')).toBeVisible()
  await expect(page.getByTestId('comment-composer-quote')).toContainText(quote)
  await page.getByLabel('Comment body').fill(body)

  if (options.mentionTitle) {
    await page.getByRole('button', { name: 'Mention' }).click()
    await page.keyboard.type(options.mentionTitle.split(' ')[0] ?? options.mentionTitle)
    const option = page.getByRole('option', { name: options.mentionTitle }).first()
    await expect(option).toBeVisible({ timeout: 10000 })
    await option.click()
  }

  if (options.attachmentPath) {
    await page.getByTestId('comment-attachment-input').setInputFiles(options.attachmentPath)
    await expect(page.getByTestId('comment-attachment-row')).toContainText(
      path.basename(options.attachmentPath)
    )
  }

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
    const mentionTitle = `Mention Target ${Date.now()}`
    const attachmentPath = path.join(testVaultPath, 'comment-proof.png')
    fs.writeFileSync(
      attachmentPath,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p94AAAAASUVORK5CYII=',
        'base64'
      )
    )

    const mentionNote = await createNoteViaApi(
      page,
      mentionTitle,
      'A note that can be mentioned from a comment.'
    )
    const note = await createNoteViaApi(page, title, `This paragraph has a ${quote} for the MVP.`)
    await openNoteInUi(page, note)

    await expect
      .poll(async () =>
        page.evaluate(async (expectedTitle) => {
          const result = await window.api.search.query({ text: expectedTitle, limit: 20 })
          return result.groups.some((group) =>
            group.results.some((candidate) => candidate.title === expectedTitle)
          )
        }, mentionTitle)
      )
      .toBe(true)

    await createSelectionComment(page, quote, body, { mentionTitle, attachmentPath })

    await expect(page.getByTestId('comments-panel')).toHaveCount(0)
    await expect(page.getByTestId('comments-rail')).toBeVisible()
    await expect(page.getByTestId('comment-card').filter({ hasText: body })).toBeVisible()

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
    expect(comments[0].mentionRefs).toEqual([
      { kind: 'note', refId: mentionNote.id, label: mentionTitle }
    ])
    expect(comments[0].attachmentRefs).toHaveLength(1)

    await page.getByRole('button', { name: /comment-proof\.png/ }).click()
    await expect(page.getByTestId('comment-attachment-preview-dialog')).toBeVisible()

    const notePath = path.join(testVaultPath, note.path)
    await expect
      .poll(() => (fs.existsSync(notePath) ? fs.readFileSync(notePath, 'utf8') : ''))
      .toContain(quote)
    const markdown = fs.readFileSync(notePath, 'utf8')
    expect(markdown).not.toContain(body)
    expect(markdown).not.toContain(mentionTitle)
    expect(markdown).not.toContain('comment-proof.png')
    expect(markdown).not.toContain('data-comment')
  })

  test('creates a sidecar journal comment from selected text and keeps it in the rail', async ({
    page,
    testVaultPath
  }) => {
    const date = await getCurrentJournalDate(page)
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

    await expect(page.getByTestId('comments-panel')).toHaveCount(0)
    await expect(page.getByTestId('comments-rail')).toBeVisible()
    await expect(page.getByTestId('comment-card').filter({ hasText: body })).toBeVisible()
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
