import fs from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures/sync-auth-fixtures'
import {
  syncBothAndWait,
  triggerSync,
  waitForCrdtQueueIdle,
  waitForSyncIdle,
  waitForSyncOnline
} from './utils/network-control'

/**
 * #1417 live lane: two desktop instances on one account against the real sync
 * Worker in Miniflare, a stateful Readwise stub in each main process (the same
 * library on both), and each device's own vault. Device A pulls from Readwise,
 * B shows that Readwise syncs on A, B takes over, and the vault ends with one
 * note per book.
 */

const SYNC_TIMEOUT = 90_000
const TOKEN = 'rw-e2e-token'

interface StubHighlight {
  id: number
  text: string
  location: number
  created_at: string
  updated_at: string
}

function stubBook(id: number, title: string, highlights: StubHighlight[]) {
  return {
    user_book_id: id,
    is_deleted: false,
    title,
    readable_title: title,
    author: 'Test Author',
    category: 'books',
    source: 'kindle',
    source_url: null,
    readwise_url: `https://readwise.io/bookreview/${id}`,
    cover_image_url: null,
    book_tags: [],
    document_note: '',
    summary: '',
    highlights: highlights.map((h) => ({
      is_deleted: false,
      is_discard: false,
      note: '',
      tags: [],
      location_type: 'location',
      highlighted_at: h.created_at,
      readwise_url: `https://readwise.io/open/${h.id}`,
      ...h
    }))
  }
}

const hl = (id: number, day: number): StubHighlight => ({
  id,
  text: `Highlight ${id}`,
  location: id,
  created_at: `2026-10-0${day}T10:00:00Z`,
  updated_at: `2026-10-0${day}T10:00:00Z`
})

function library(extra = false) {
  return [
    stubBook(1, 'Deep Work', [hl(11, 1), hl(12, 2), ...(extra ? [hl(13, 5)] : [])]),
    stubBook(2, 'Atomic Habits', [hl(21, 1)]),
    stubBook(3, 'Walden', [hl(31, 1)])
  ]
}

/** readwise.io in this process answers from `books`. Everything else goes to the real fetch. */
async function installReadwiseStub(app: ElectronApplication, books: unknown[]): Promise<void> {
  await app.evaluate((_ctx, data) => {
    const g = globalThis as unknown as {
      __readwise?: { books: Record<string, unknown>[]; requests: string[] }
      __realFetch?: typeof fetch
      fetch: typeof fetch
    }
    g.__readwise = { books: data as Record<string, unknown>[], requests: [] }
    g.__realFetch ??= g.fetch
    const realFetch = g.__realFetch
    g.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const url = new URL(raw)
      if (url.hostname !== 'readwise.io') return realFetch(input, init)
      g.__readwise!.requests.push(url.pathname + url.search)
      if (url.pathname === '/api/v2/auth/') return new Response(null, { status: 204 })
      const ids = url.searchParams.get('ids')?.split(',').map(Number)
      const after = url.searchParams.get('updatedAfter')
      const results = g.__readwise!.books.flatMap((book) => {
        if (ids && !ids.includes(book.user_book_id as number)) return []
        let highlights = book.highlights as { updated_at: string }[]
        if (after) {
          highlights = highlights.filter((h) => Date.parse(h.updated_at) > Date.parse(after))
          if (highlights.length === 0) return []
        }
        return [{ ...book, highlights }]
      })
      return new Response(JSON.stringify({ nextPageCursor: null, results }), { status: 200 })
    }
  }, books)
}

async function readwiseRequests(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(
    () => (globalThis as unknown as { __readwise: { requests: string[] } }).__readwise.requests
  )
}

function noteFiles(vaultPath: string): string[] {
  const root = path.join(vaultPath, 'Readwise')
  if (!fs.existsSync(root)) return []
  return (fs.readdirSync(root, { recursive: true }) as string[])
    .filter((file) => file.endsWith('.md'))
    .map((file) => path.join(root, file))
}

const bodies = (vaultPath: string): Record<string, string> =>
  Object.fromEntries(
    noteFiles(vaultPath).map((file) => [path.basename(file), fs.readFileSync(file, 'utf8')])
  )

async function startImport(page: Page): Promise<void> {
  const res = await page.evaluate(() =>
    window.api.import.start({
      importId: `rw-${Date.now()}`,
      importerId: 'readwise',
      sourcePaths: []
    })
  )
  expect(res).toBeTruthy()
}

async function syncBoth(pageA: Page, pageB: Page): Promise<void> {
  for (const page of [pageA, pageB]) {
    const result = await triggerSync(page)
    if (!result.success) throw new Error(result.error || 'Sync trigger failed')
  }
}

test.describe('Readwise: one pulling device (#1417)', () => {
  test.setTimeout(360_000)

  test('A pulls, B shows where Readwise syncs, B takes over, and no book is duplicated', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    vaultPathA,
    vaultPathB,
    bootstrappedSyncPair
  }) => {
    bootstrappedSyncPair
    await Promise.all([waitForSyncOnline(pageA), waitForSyncOnline(pageB)])
    await installReadwiseStub(electronAppA, library())
    await installReadwiseStub(electronAppB, library())
    // Both devices have pulled since launch, as in a running app.
    await syncBoth(pageA, pageB)

    // A connects: sync is on and nobody claims Readwise, so A claims it.
    const connected = await pageA.evaluate(
      (token) => window.api.import.readwise.connect({ token }),
      TOKEN
    )
    expect(connected).toMatchObject({ connected: true, thisDevicePulls: true })

    await startImport(pageA)
    await expect.poll(() => noteFiles(vaultPathA).length, { timeout: SYNC_TIMEOUT }).toBe(3)

    // Memry sync delivers A's notes and A's claim to B.
    await expect
      .poll(
        async () => {
          await syncBoth(pageA, pageB)
          const status = await pageB.evaluate(() => window.api.import.readwise.status())
          return {
            notes: noteFiles(vaultPathB).length,
            syncsOn: status.pullingDeviceName
          }
        },
        { timeout: SYNC_TIMEOUT, intervals: [1_000, 3_000] }
      )
      .toMatchObject({ notes: 3, syncsOn: expect.any(String) })
    const statusB = await pageB.evaluate(() => window.api.import.readwise.status())
    expect(statusB).toMatchObject({ connected: false })

    // B refuses to connect beside A, and has no token to run with.
    const refused = await pageB.evaluate(
      (token) => window.api.import.readwise.connect({ token }),
      TOKEN
    )
    expect(refused).toMatchObject({ success: false })

    // B takes over. The call returns once the claim is pushed.
    const before = bodies(vaultPathB)
    const taken = await pageB.evaluate(
      (token) => window.api.import.readwise.takeOver({ token }),
      TOKEN
    )
    expect(taken).toMatchObject({ connected: true, thisDevicePulls: true })

    // B's first run is a full export that adopts A's notes by readwise_url.
    await startImport(pageB)
    await expect
      .poll(async () => (await readwiseRequests(electronAppB)).length, { timeout: SYNC_TIMEOUT })
      .toBeGreaterThan(1)
    await waitForSyncIdle(pageB, SYNC_TIMEOUT)
    expect(noteFiles(vaultPathB)).toHaveLength(3)
    expect(bodies(vaultPathB)).toEqual(before)

    // A learns about the claim, stops, and drops its token.
    await expect
      .poll(
        async () => {
          await syncBoth(pageA, pageB)
          const status = await pageA.evaluate(() => window.api.import.readwise.status())
          return { connected: status.connected, syncsOn: !status.thisDevicePulls }
        },
        { timeout: SYNC_TIMEOUT, intervals: [1_000, 3_000] }
      )
      .toEqual({ connected: false, syncsOn: true })
    const fromA = await readwiseRequests(electronAppA)

    // A new highlight in Readwise is written by B, and reaches A through memry sync, once.
    await installReadwiseStub(electronAppB, library(true))
    const withHighlight = (vaultPath: string) =>
      Object.values(bodies(vaultPath)).filter((body) => body.includes('Highlight 13'))
    // A note that just arrived through memry sync is skipped while it is held
    // open (D6) and goes on the retry list, so the run is repeated until the
    // note is released, as the scheduler's next tick does.
    await expect
      .poll(
        async () => {
          await startImport(pageB)
          return withHighlight(vaultPathB).length
        },
        { timeout: SYNC_TIMEOUT, intervals: [2_000, 5_000] }
      )
      .toBe(1)
    await waitForCrdtQueueIdle(electronAppB)
    await expect
      .poll(
        async () => {
          await syncBothAndWait(pageA, pageB)
          return withHighlight(vaultPathA).length
        },
        { timeout: SYNC_TIMEOUT, intervals: [1_000, 3_000] }
      )
      .toBe(1)
    expect(noteFiles(vaultPathA)).toHaveLength(3)
    expect(noteFiles(vaultPathB)).toHaveLength(3)
    expect(withHighlight(vaultPathB)[0].match(/Highlight 13/g)).toHaveLength(1)
    expect(withHighlight(vaultPathA)[0].match(/Highlight 13/g)).toHaveLength(1)
    expect(await readwiseRequests(electronAppA)).toEqual(fromA)
  })
})
