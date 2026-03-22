import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createTestDataDb,
  seedInboxItems,
  seedInboxItemTags,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { createInboxQueryHandlers, type InboxQueryHandlerDeps } from './inbox-query-handlers'
import { inboxItemTags } from '@memry/db-schema/schema/inbox'
import { eq } from 'drizzle-orm'

describe('inbox-query-handlers › handleGetPatterns', () => {
  let testDb: TestDatabaseResult
  let deps: InboxQueryHandlerDeps

  beforeEach(() => {
    testDb = createTestDataDb()
    deps = {
      requireDatabase: () => testDb.db as ReturnType<InboxQueryHandlerDeps['requireDatabase']>,
      getItemTags: (db, itemId) => {
        return db
          .select({ tag: inboxItemTags.tag })
          .from(inboxItemTags)
          .where(eq(inboxItemTags.itemId, itemId))
          .all()
          .map((r) => r.tag)
      },
      toListItem: (row, tags) => ({ ...row, tags }) as never
    }
  })

  afterEach(() => {
    testDb.close()
  })

  it('returns 24x7 heatmap grid with correct counts for captured items', async () => {
    // #given — 3 items captured on a Wednesday at 14:xx (hour 14, dow 3 in SQLite = Wednesday)
    const wed14 = '2026-03-18T14:30:00.000Z' // Wednesday March 18 2026 at 14:30 UTC
    seedInboxItems(testDb.db, [
      { id: 'item-1', type: 'note', title: 'Note 1', createdAt: wed14 },
      {
        id: 'item-2',
        type: 'link',
        title: 'Link 1',
        createdAt: wed14,
        sourceUrl: 'https://example.com/page'
      },
      { id: 'item-3', type: 'note', title: 'Note 2', createdAt: '2026-03-18T10:00:00.000Z' }
    ])

    // #when
    const handlers = createInboxQueryHandlers(deps)
    const result = await handlers.handleGetPatterns()

    // #then — timeHeatmap should be 24 rows × 7 cols
    expect(result.timeHeatmap).toHaveLength(24)
    expect(result.timeHeatmap[0]).toHaveLength(7)

    // Wednesday = SQLite %w 3 → index (3+6)%7 = 2
    const wedIdx = 2
    expect(result.timeHeatmap[14][wedIdx]).toBe(2) // 2 items at hour 14
    expect(result.timeHeatmap[10][wedIdx]).toBe(1) // 1 item at hour 10

    // All other slots should be 0
    expect(result.timeHeatmap[0][0]).toBe(0)
    expect(result.timeHeatmap[23][6]).toBe(0)
  })

  it('returns empty 24x7 grid when no items exist', async () => {
    // #given — empty database

    // #when
    const handlers = createInboxQueryHandlers(deps)
    const result = await handlers.handleGetPatterns()

    // #then — still returns 24x7 grid, all zeros
    expect(result.timeHeatmap).toHaveLength(24)
    expect(result.timeHeatmap[0]).toHaveLength(7)
    const allZero = result.timeHeatmap.every((row) => row.every((v) => v === 0))
    expect(allZero).toBe(true)
  })

  it('returns type distribution with correct percentages', async () => {
    // #given — 3 notes and 2 links
    seedInboxItems(testDb.db, [
      { type: 'note', title: 'N1' },
      { type: 'note', title: 'N2' },
      { type: 'note', title: 'N3' },
      { type: 'link', title: 'L1' },
      { type: 'link', title: 'L2' }
    ])

    // #when
    const handlers = createInboxQueryHandlers(deps)
    const result = await handlers.handleGetPatterns()

    // #then
    expect(result.typeDistribution).toHaveLength(2)
    const noteType = result.typeDistribution.find((t) => t.type === 'note')
    const linkType = result.typeDistribution.find((t) => t.type === 'link')
    expect(noteType?.count).toBe(3)
    expect(noteType?.percentage).toBe(60)
    expect(linkType?.count).toBe(2)
    expect(linkType?.percentage).toBe(40)
  })

  it('returns top tags sorted by count', async () => {
    // #given — 2 items tagged "work", 1 tagged "urgent"
    const ids = seedInboxItems(testDb.db, [
      { id: 'tagged-1', type: 'note', title: 'Tagged 1' },
      { id: 'tagged-2', type: 'note', title: 'Tagged 2' }
    ])
    seedInboxItemTags(testDb.db, ids[0], ['work', 'urgent'])
    seedInboxItemTags(testDb.db, ids[1], ['work'])

    // #when
    const handlers = createInboxQueryHandlers(deps)
    const result = await handlers.handleGetPatterns()

    // #then
    expect(result.topTags.length).toBeGreaterThan(0)
    expect(result.topTags[0].tag).toBe('work')
    expect(result.topTags[0].count).toBe(2)
  })

  it('returns top domains extracted from sourceUrl', async () => {
    // #given
    seedInboxItems(testDb.db, [
      { type: 'link', title: 'L1', sourceUrl: 'https://github.com/foo' },
      { type: 'link', title: 'L2', sourceUrl: 'https://github.com/bar' },
      { type: 'link', title: 'L3', sourceUrl: 'https://www.example.com/page' }
    ])

    // #when
    const handlers = createInboxQueryHandlers(deps)
    const result = await handlers.handleGetPatterns()

    // #then
    expect(result.topDomains).toHaveLength(2)
    expect(result.topDomains[0]).toEqual({ domain: 'github.com', count: 2 })
    expect(result.topDomains[1]).toEqual({ domain: 'example.com', count: 1 })
  })

  it('excludes items older than 12 weeks', async () => {
    // #given — item from 13 weeks ago
    const old = new Date()
    old.setDate(old.getDate() - 91)
    seedInboxItems(testDb.db, [{ type: 'note', title: 'Old', createdAt: old.toISOString() }])

    // #when
    const handlers = createInboxQueryHandlers(deps)
    const result = await handlers.handleGetPatterns()

    // #then — should not appear in heatmap
    const allZero = result.timeHeatmap.every((row) => row.every((v) => v === 0))
    expect(allZero).toBe(true)
    expect(result.typeDistribution).toHaveLength(0)
  })
})
