import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures/sync-auth-fixtures'
import { navigateTo } from './utils/electron-helpers'
import {
  appendToNoteBody,
  createNoteWithBody,
  expectNoteBody,
  getCrdtDocBodyById,
  getNoteFileBodyById,
  normalizeBodyText,
  openNoteByTitle
} from './utils/note-sync-helpers'
import {
  syncBothAndWait,
  waitForCrdtQueueIdle,
  waitForPendingCount,
  waitForSyncOnline
} from './utils/network-control'

/**
 * #2297 (P3.3 part a) live lane: note and journal bodies reach the peer through
 * GET /sync/changes alone. B's every other body path is switched off (the
 * `crdt_updated` pull, the pull after a record page, the reconnect pulls and the
 * vault sweeps), and B only runs plain record pulls, never a full sync. So the
 * only carrier left for A's edits is the `noteBodies` array of the change feed.
 */

const FEED_TIMEOUT = 60_000

interface FeedTestHooks {
  disableCrdtBodyPullsForTests(): Promise<void>
  pullSyncForTests(): Promise<boolean>
}

async function callHook<K extends keyof FeedTestHooks>(
  electronApp: ElectronApplication,
  name: K
): Promise<Awaited<ReturnType<FeedTestHooks[K]>>> {
  return electronApp.evaluate(async (_context, hookName) => {
    const hooks = (globalThis as typeof globalThis & { __memryTestHooks?: FeedTestHooks })
      .__memryTestHooks
    if (!hooks) throw new Error('Memry test hooks are not registered')
    return hooks[hookName as keyof FeedTestHooks]()
  }, name) as Promise<Awaited<ReturnType<FeedTestHooks[K]>>>
}

function todayLocalIso(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')}`
}

async function journalEntry(
  page: Page,
  date: string
): Promise<{ id: string; content: string } | null> {
  return page.evaluate(async (day) => {
    const entry = await window.api.journal.getEntry(day)
    return entry ? { id: entry.id, content: entry.content } : null
  }, date)
}

async function typeIntoJournal(page: Page, text: string): Promise<void> {
  await navigateTo(page, 'journal')
  await appendToNoteBody(page, text)
}

test.describe('Body CRDT delivery through the change feed (#2297)', () => {
  test.setTimeout(300_000)

  test('a note body edit and a journal body edit reach B with its CRDT pulls switched off', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair
    const title = `Feed Delivery ${Date.now()}`
    const initialBody = 'note body from A'
    const noteEdit = 'note edit through the feed'
    const expectedNoteBody = `${initialBody}\n\n${noteEdit}`
    const date = todayLocalIso()
    const journalLine = `journal line from A ${Date.now()}`
    const journalEdit = 'journal edit through the feed'

    // Seed both devices with every body path on.
    await Promise.all([waitForSyncOnline(pageA), waitForSyncOnline(pageB)])
    const note = await createNoteWithBody(pageA, title, initialBody)
    await typeIntoJournal(pageA, journalLine)
    await expect
      .poll(async () => (await journalEntry(pageA, date))?.content ?? '')
      .toContain(journalLine)
    const journalId = (await journalEntry(pageA, date))!.id
    await waitForCrdtQueueIdle(electronAppA)
    await syncBothAndWait(pageA, pageB)
    await openNoteByTitle(pageB, title)
    await expectNoteBody(pageB, initialBody)
    await expect
      .poll(async () => (await journalEntry(pageB, date))?.content ?? '', {
        timeout: FEED_TIMEOUT
      })
      .toContain(journalLine)
    expect((await journalEntry(pageB, date))!.id).toBe(journalId)

    // From here the change feed is B's only body path. B pulled A's note above,
    // so its cursor is past 0 and its pulls declare note_body (07 §7.17.5).
    await callHook(electronAppB, 'disableCrdtBodyPullsForTests')

    await openNoteByTitle(pageA, title)
    await appendToNoteBody(pageA, noteEdit)
    await expectNoteBody(pageA, expectedNoteBody)
    await typeIntoJournal(pageA, journalEdit)
    await expect
      .poll(async () => (await journalEntry(pageA, date))?.content ?? '')
      .toContain(journalEdit)
    await waitForCrdtQueueIdle(electronAppA)
    await waitForPendingCount(pageA, 0, FEED_TIMEOUT)

    await expect
      .poll(
        async () => {
          await callHook(electronAppB, 'pullSyncForTests')
          return getCrdtDocBodyById(electronAppB, note.id)
        },
        { timeout: FEED_TIMEOUT, intervals: [1_000, 2_000] }
      )
      .toBe(normalizeBodyText(expectedNoteBody))
    await expect
      .poll(() => getNoteFileBodyById(pageB, note.id), { timeout: FEED_TIMEOUT })
      .toBe(normalizeBodyText(expectedNoteBody))
    await expectNoteBody(pageB, expectedNoteBody)

    await expect
      .poll(
        async () => {
          await callHook(electronAppB, 'pullSyncForTests')
          return (await journalEntry(pageB, date))?.content ?? ''
        },
        { timeout: FEED_TIMEOUT, intervals: [1_000, 2_000] }
      )
      .toContain(journalEdit)
    console.log(`[#2297 live] B received note ${note.id} and journal ${journalId} via the feed`)
  })
})
