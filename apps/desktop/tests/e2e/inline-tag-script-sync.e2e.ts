/**
 * A `#tag` in a script other than Latin, typed through an input method, is a
 * tag on both devices (#5716): the chip, the file header and the body bytes
 * reach the peer, and the peer's later edit loses none of them.
 *
 * The composition goes through Chromium's own IME path (`Input.imeSetComposition`
 * then `Input.insertText`), the events a Korean keyboard sends.
 */
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures/sync-auth-fixtures'
import { SELECTORS } from './utils/electron-helpers'
import {
  appendToNoteBody,
  createNoteWithBody,
  getNoteFileBodyByTitle,
  getNoteHandleByTitle,
  openNoteByTitle
} from './utils/note-sync-helpers'
import { syncBothAndWait, waitForSyncOnline } from './utils/network-control'

async function compose(page: Page, steps: string[], commit: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  for (const text of steps) {
    await cdp.send('Input.imeSetComposition', {
      text,
      selectionStart: text.length,
      selectionEnd: text.length
    })
  }
  await cdp.send('Input.insertText', { text: commit })
  await cdp.detach()
}

const chips = (page: Page): Promise<string[]> =>
  page.$$eval('.inline-hash-tag', (els) => els.map((el) => el.getAttribute('data-hash-tag') ?? ''))

async function headerTags(page: Page, title: string): Promise<string[]> {
  const note = await getNoteHandleByTitle(page, title)
  const tags = await page.evaluate(
    async (id) => (await window.api.notes.get(id))?.headerTags ?? [],
    note.id
  )
  return tags.toSorted()
}

test.describe('Inline tags in every script across two devices', () => {
  test('a Korean tag typed through an input method syncs as a tag and survives a peer edit', async ({
    pageA,
    pageB,
    bootstrappedSyncPair: _bootstrappedSyncPair
  }) => {
    const title = `Script tags ${Date.now()}`
    await Promise.all([waitForSyncOnline(pageA), waitForSyncOnline(pageB)])
    await createNoteWithBody(pageA, title, 'Meeting')

    const editor = pageA.locator(SELECTORS.noteEditor).first()
    await editor.click()
    await pageA.keyboard.press('End')
    await pageA.keyboard.type(' #')
    await compose(pageA, ['ㅍ', '퓨'], '퓨')
    await compose(pageA, ['ㄹ', '리'], '리')
    await pageA.keyboard.type(' #привет ')

    await expect.poll(() => chips(pageA)).toEqual(['퓨리', 'привет'])
    const body = 'Meeting #퓨리 #привет'
    await expect.poll(() => getNoteFileBodyByTitle(pageA, title)).toBe(body)
    await expect.poll(() => headerTags(pageA, title)).toEqual(['привет', '퓨리'])

    await syncBothAndWait(pageA, pageB)
    await openNoteByTitle(pageB, title)
    await expect.poll(() => getNoteFileBodyByTitle(pageB, title), { timeout: 30_000 }).toBe(body)
    await expect.poll(() => headerTags(pageB, title)).toEqual(['привет', '퓨리'])
    await expect.poll(() => chips(pageB)).toEqual(['퓨리', 'привет'])

    await appendToNoteBody(pageB, 'reply from B')
    const replied = `${body}\n\nreply from B`
    await expect.poll(() => getNoteFileBodyByTitle(pageB, title)).toBe(replied)
    await syncBothAndWait(pageA, pageB)

    await expect.poll(() => getNoteFileBodyByTitle(pageA, title), { timeout: 30_000 }).toBe(replied)
    await expect.poll(() => headerTags(pageA, title)).toEqual(['привет', '퓨리'])
    await expect.poll(() => chips(pageA)).toEqual(['퓨리', 'привет'])
  })
})
