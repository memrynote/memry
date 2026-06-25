import { describe, it, expect } from 'vitest'
import { resolveInboxFilter, inboxWidgetLimit, computeInboxFooter } from './inbox-widget-filter'

describe('resolveInboxFilter', () => {
  it('defaults to all types', () => {
    expect(resolveInboxFilter({})).toEqual({ kind: 'all' })
  })

  it('reads a configured type', () => {
    expect(resolveInboxFilter({ type: 'link' })).toEqual({ kind: 'type', type: 'link' })
  })

  it('falls back to all for a type the list query rejects or a non-string', () => {
    expect(resolveInboxFilter({ type: 'video' })).toEqual({ kind: 'all' })
    expect(resolveInboxFilter({ type: 42 })).toEqual({ kind: 'all' })
  })
})

describe('inboxWidgetLimit', () => {
  it('maps size to the body item cap', () => {
    expect(inboxWidgetLimit('S')).toBe(3)
    expect(inboxWidgetLimit('M')).toBe(6)
    expect(inboxWidgetLimit('L')).toBe(12)
  })
})

describe('computeInboxFooter', () => {
  it('counts items hidden beyond what is shown', () => {
    expect(computeInboxFooter({ total: 10, shown: 6, oldestDays: 4 })).toEqual({
      olderCount: 4,
      oldestDays: 4
    })
  })

  it('clamps olderCount at zero when nothing is hidden', () => {
    expect(computeInboxFooter({ total: 3, shown: 6, oldestDays: 0 })).toEqual({
      olderCount: 0,
      oldestDays: 0
    })
  })
})
