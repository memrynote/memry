import { describe, expect, it } from 'vitest'
import { highlight } from './fixtures.ts'
import { linkedHighlightIds } from './highlights.ts'
import { planAppend } from './plan-append.ts'

const LAST = '2026-10-10T00:00:00.000Z'
const base = { last: LAST, linkedIds: new Set<number>(), timeZone: 'UTC' }

describe('planAppend', () => {
  it('skips highlights older than last and ids already in the note', () => {
    const plan = planAppend(
      [
        highlight(1, { created_at: '2026-10-09T23:59:59Z' }),
        highlight(2, { created_at: '2026-10-11T00:00:00Z' }),
        highlight(3, { created_at: '2026-10-12T00:00:00Z' })
      ],
      { ...base, linkedIds: new Set([2]) }
    )
    expect(plan.markdown).toBe(
      '- Highlight 3 ([Location 30](https://readwise.io/open/3), 2026-10-22)'
    )
    expect(plan.last).toBe('2026-10-12T00:00:00.000Z')
  })

  it('keeps a highlight created exactly at last when its id is not in the note', () => {
    const plan = planAppend([highlight(1, { created_at: LAST })], base)
    expect(plan.markdown).toContain('open/1)')
    expect(plan.last).toBe(LAST)
  })

  it('appends nothing and keeps last when nothing is new', () => {
    expect(planAppend([highlight(1, { created_at: '2026-01-01T00:00:00Z' })], base)).toEqual({
      markdown: '',
      last: LAST
    })
  })

  it('leaves out deleted highlights and heading highlights', () => {
    const plan = planAppend(
      [
        highlight(1, { is_deleted: true, created_at: '2026-10-12T00:00:00Z' }),
        highlight(2, { tags: [{ name: '.h1' }], created_at: '2026-10-12T00:00:00Z' })
      ],
      base
    )
    expect(plan.markdown).toBe('')
  })

  it('orders appended highlights by location and escapes their text', () => {
    const plan = planAppend(
      [
        highlight(2, { location: 50, text: 'late', created_at: '2026-10-12T00:00:00Z' }),
        highlight(1, { location: 5, text: '#tweet', created_at: '2026-10-12T00:00:00Z' })
      ],
      base
    )
    expect(plan.markdown.split('\n').map((l) => l.slice(0, 9))).toEqual([
      '- #\u200btweet',
      '- late (['
    ])
  })

  it('reads highlight ids back out of a note body', () => {
    const body =
      'x [Location 1](https://readwise.io/open/41) y\n- z ([Page 2](https://readwise.io/open/42), 2026-01-01)'
    expect([...linkedHighlightIds(body)]).toEqual([41, 42])
  })
})
