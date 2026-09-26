import { describe, expect, it } from 'vitest'
import type { RecordChangesResponse } from '@memry/contracts/sync-api'
import { planPullSlices } from './changes-page'

const ref = (id: string) => ({ id, type: 'task' as const, version: 1, modifiedAt: 1, size: 10 })
const pullItem = (id: string) => ({ id, type: 'task', operation: 'update' })

const page = (
  ids: string[],
  extra: Partial<RecordChangesResponse> = {}
): RecordChangesResponse => ({
  items: ids.map(ref),
  deleted: [],
  hasMore: false,
  nextCursor: 1,
  ...extra
})

describe('planPullSlices', () => {
  // #2292: an old server, or a page that did not ask, plans the pre-inline slices.
  it('chunks a page without inline into POST /sync/pull slices of 100', () => {
    const ids = Array.from({ length: 250 }, (_, i) => `t-${i}`)

    const slices = planPullSlices(page(ids))

    expect(slices.map((slice) => slice.fetchIds.length)).toEqual([100, 100, 50])
    expect(slices.flatMap((slice) => slice.fetchIds)).toEqual(ids)
    expect(slices.every((slice) => slice.inline.length === 0)).toBe(true)
  })

  // #2292
  it('plans one fetch-free slice for a page that arrived fully inline', () => {
    const inline = [pullItem('t-1'), pullItem('t-2')]

    expect(planPullSlices(page(['t-1', 't-2'], { inline }))).toEqual([{ fetchIds: [], inline }])
  })

  // #2292
  it('fetches only the ids no inline element names, in the same slice as the inline items', () => {
    const inline = [pullItem('t-1'), pullItem('t-3')]

    expect(planPullSlices(page(['t-1', 't-big', 't-3'], { inline }))).toEqual([
      { fetchIds: ['t-big'], inline }
    ])
  })

  // #2292: tombstones have no ref row; an inlined one must cover its deleted id.
  it('covers a deleted id with its inline tombstone', () => {
    const inline = [{ ...pullItem('t-gone'), operation: 'delete', deletedAt: 5 }]

    expect(planPullSlices(page([], { deleted: ['t-gone'], inline }))).toEqual([
      { fetchIds: [], inline }
    ])
  })

  it('dedupes ids across items and deleted, keeping page order', () => {
    const slices = planPullSlices(page(['b', 'a', 'b'], { deleted: ['c', 'a'] }))

    expect(slices).toEqual([{ fetchIds: ['b', 'a', 'c'], inline: [] }])
  })

  // #2292: getFromServer is an unchecked cast; a malformed `inline` must not cover anything.
  it('ignores an inline value that is not an array', () => {
    const changes = { ...page(['t-1']), inline: { id: 't-1' } } as unknown as RecordChangesResponse

    expect(planPullSlices(changes)).toEqual([{ fetchIds: ['t-1'], inline: [] }])
  })

  it('plans nothing for an empty page', () => {
    expect(planPullSlices(page([]))).toEqual([])
  })
})
