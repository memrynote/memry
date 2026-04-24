import { describe, it, expect } from 'vitest'

import { inboxRoutes } from './inbox'

describe('inboxRoutes', () => {
  it('inbox_list returns at least 10 items with a mix of statuses', async () => {
    const list = (await inboxRoutes.inbox_list!(undefined)) as Array<{ status: string }>
    expect(list.length).toBeGreaterThanOrEqual(10)
    const statuses = new Set(list.map((i) => i.status))
    expect(statuses.size).toBeGreaterThanOrEqual(2)
  })

  it('inbox_list_archived returns only archived items', async () => {
    const list = (await inboxRoutes.inbox_list_archived!(undefined)) as Array<{
      status: string
    }>
    expect(list.every((i) => i.status === 'archived')).toBe(true)
  })

  it('inbox_get returns item by id', async () => {
    const item = (await inboxRoutes.inbox_get!({ id: 'inbox-1' })) as { id: string }
    expect(item.id).toBe('inbox-1')
  })

  it('inbox_get rejects unknown id', async () => {
    await expect(inboxRoutes.inbox_get!({ id: 'missing' })).rejects.toThrow(/not found/i)
  })

  it('inbox_capture_text creates a text capture', async () => {
    const created = (await inboxRoutes.inbox_capture_text!({
      text: 'Captured text'
    })) as { id: string; kind: string }
    expect(created.id).toMatch(/^inbox-\d+/)
    expect(created.kind).toBe('text')
  })

  it('inbox_archive archives the item', async () => {
    const updated = (await inboxRoutes.inbox_archive!({ id: 'inbox-2' })) as {
      status: string
    }
    expect(updated.status).toBe('archived')
  })

  it('inbox_snooze sets snoozedUntil', async () => {
    const until = Date.now() + 86_400_000
    const updated = (await inboxRoutes.inbox_snooze!({ id: 'inbox-3', until })) as {
      snoozedUntil: number
    }
    expect(updated.snoozedUntil).toBe(until)
  })

  it('inbox_file promotes an item to a note', async () => {
    const result = (await inboxRoutes.inbox_file!({
      id: 'inbox-4',
      folderId: 'folder-1'
    })) as { ok: boolean; noteId?: string }
    expect(result.ok).toBe(true)
    expect(result.noteId).toMatch(/^note-\d+/)
  })

  it('inbox_stats returns counts for the four buckets', async () => {
    const stats = (await inboxRoutes.inbox_stats!(undefined)) as {
      total: number
      unread: number
      snoozed: number
      archived: number
    }
    expect(stats.total).toBeGreaterThan(0)
    expect(typeof stats.unread).toBe('number')
    expect(typeof stats.snoozed).toBe('number')
    expect(typeof stats.archived).toBe('number')
  })
})
