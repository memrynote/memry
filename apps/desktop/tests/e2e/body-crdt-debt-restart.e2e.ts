import type { ElectronApplication } from '@playwright/test'
import { test, expect } from './fixtures/sync-auth-fixtures'
import { navigateTo } from './utils/electron-helpers'
import {
  appendToNoteBody,
  createNoteWithBody,
  expectNoteBody,
  getNoteFileBodyById,
  normalizeBodyText,
  openNoteByHandle,
  waitForNoteById
} from './utils/note-sync-helpers'
import {
  goOffline,
  goOnline,
  syncAndWait,
  syncBothAndWait,
  waitForCrdtQueueIdle,
  waitForPendingCount,
  waitForSyncIdle,
  waitForSyncOffline,
  waitForSyncOnline
} from './utils/network-control'

/**
 * #2297 part b live lane: a record page owes B a note's whole body, and the
 * CRDT batch that would pay it is rate limited, through the real failure path.
 * The page commits and moves the cursor with the body unpaid, and the feed
 * skips that note's bodies because its record is on the page. The sync runtime then
 * restarts, which drops everything in memory, as a crash would. Only a durable
 * debt makes the next engine pull the body: no sweep is due, A has stopped
 * writing so no broadcast names the note, and no editor or cached doc holds it.
 */

const TIMEOUT = 60_000

interface DebtTestHooks {
  rateLimitCrdtBodyPullsForTests(): Promise<void>
  restartSyncRuntimeForTests(): Promise<void>
  getSyncStateValueForTests(key: string): Promise<string | null>
  getCrdtBodyDebtsForTests(): Promise<DebtRow[] | null>
}

interface DebtRow {
  noteId: string
  reason: string
  generation: number
  failures: number
  lastFailedAt: number | null
}

async function callHook<K extends keyof DebtTestHooks>(
  electronApp: ElectronApplication,
  name: K,
  ...args: Parameters<DebtTestHooks[K]>
): Promise<Awaited<ReturnType<DebtTestHooks[K]>>> {
  return electronApp.evaluate(
    async (_context, { hookName, hookArgs }) => {
      const hooks = (globalThis as typeof globalThis & { __memryTestHooks?: DebtTestHooks })
        .__memryTestHooks
      if (!hooks) throw new Error('Memry test hooks are not registered')
      const hook = hooks[hookName as keyof DebtTestHooks] as (...a: unknown[]) => unknown
      return hook(...hookArgs)
    },
    { hookName: name, hookArgs: args as unknown[] }
  ) as Promise<Awaited<ReturnType<DebtTestHooks[K]>>>
}

test.describe('Body CRDT durable debts (#2297)', () => {
  test.setTimeout(300_000)

  test('a record debt the CRDT batch never paid is paid after the runtime restarts', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair
    const title = `Debt Restart ${Date.now()}`
    const renamed = `${title} renamed`
    const initialBody = 'note body from A'
    const edit = 'edit B owes after the record page'
    const expectedBody = normalizeBodyText(`${initialBody}\n\n${edit}`)

    await Promise.all([waitForSyncOnline(pageA), waitForSyncOnline(pageB)])
    // In this harness the first runtime restart after the device bootstrap
    // opens a CRDT store with no sync marker and no docs, and re-seeds them
    // from markdown. Take that restart now, so the one below reopens the store
    // it closed.
    await callHook(electronAppB, 'restartSyncRuntimeForTests')
    await waitForSyncOnline(pageB)
    const note = await createNoteWithBody(pageA, title, initialBody)
    await waitForCrdtQueueIdle(electronAppA)
    await syncBothAndWait(pageA, pageB)
    await expect
      .poll(() => getNoteFileBodyById(pageB, note.id), { timeout: TIMEOUT })
      .toBe(normalizeBodyText(initialBody))

    // The one-time legacy sweep must be done on B, or B's next full sync would
    // sweep the vault anyway and pay the body without any debt.
    await expect
      .poll(
        async () => {
          await syncAndWait(pageB)
          return callHook(electronAppB, 'getSyncStateValueForTests', 'noteBodyLegacySweep')
        },
        { timeout: TIMEOUT, intervals: [2_000, 5_000] }
      )
      .toBe('done')
    await expect
      .poll(() => callHook(electronAppB, 'getCrdtBodyDebtsForTests'), { timeout: TIMEOUT })
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ noteId: note.id })]))

    // B never opens the note, so neither an editor nor a cached doc pulls it
    // on the reconnect after the restart.
    await navigateTo(pageB, 'journal')
    await callHook(electronAppB, 'rateLimitCrdtBodyPullsForTests')
    await goOffline(electronAppB)
    await waitForSyncOffline(pageB)

    // A edits the body and renames the note: B's next page carries the record,
    // so the feed leaves that note's bodies to the record's CRDT batch.
    await openNoteByHandle(pageA, note)
    await appendToNoteBody(pageA, edit)
    await expectNoteBody(pageA, `${initialBody}\n\n${edit}`)
    await waitForCrdtQueueIdle(electronAppA)
    await pageA.evaluate(async ({ id, t }) => window.api.notes.rename(id, t), {
      id: note.id,
      t: renamed
    })
    await waitForPendingCount(pageA, 0, TIMEOUT)
    // A's snapshot pushes fire after 30 s of quiet and broadcast crdt_updated,
    // which B's restarted engine would answer with a pull of its own. Close
    // the note on A and let that window pass while B is still offline.
    await navigateTo(pageA, 'journal')
    await pageA.waitForTimeout(40_000)
    await waitForCrdtQueueIdle(electronAppA)

    await goOnline(electronAppB)
    await waitForSyncOnline(pageB)
    await waitForNoteById(pageB, note.id, renamed)
    await waitForSyncIdle(pageB, TIMEOUT)
    // The page committed and the batch paid nothing: B's file is stale, and
    // the record's debt stands.
    expect(await getNoteFileBodyById(pageB, note.id)).toBe(normalizeBodyText(initialBody))
    const debtRow = async (): Promise<DebtRow | undefined> =>
      (await callHook(electronAppB, 'getCrdtBodyDebtsForTests'))?.find(
        (row) => row.noteId === note.id
      )
    const afterPage = await debtRow()
    expect(afterPage).toMatchObject({ reason: 'record' })
    expect(await callHook(electronAppB, 'getCrdtBodyDebtsForTests')).toHaveLength(1)
    // #2297 round 2 (a-L5, b-L5): the next rate-limited batch re-owes the
    // row, a new generation, and counts no failure: a 429 is not evidence.
    await expect
      .poll(
        async () => {
          await syncAndWait(pageB)
          return (await debtRow())?.generation ?? 0
        },
        { timeout: TIMEOUT, intervals: [2_000, 5_000] }
      )
      .toBeGreaterThan(afterPage!.generation)
    expect(await debtRow()).toMatchObject({ reason: 'record', failures: 0, lastFailedAt: null })

    await callHook(electronAppB, 'restartSyncRuntimeForTests')

    await expect
      .poll(() => getNoteFileBodyById(pageB, note.id), { timeout: TIMEOUT })
      .toBe(expectedBody)
    await expect
      .poll(() => callHook(electronAppB, 'getCrdtBodyDebtsForTests'), { timeout: TIMEOUT })
      .toEqual([])
    console.log(`[#2297 debt lane] B paid note ${note.id} after the restart`)
  })
})
