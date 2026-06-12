import { describe, it, expect } from 'vitest'
import { createDateMentionContent, formatDateMentionLabel } from './date-mention'

describe('date-mention content', () => {
  it('builds inline content from token data', () => {
    const c = createDateMentionContent({
      anchorId: 'dm_1',
      dateISO: '2026-06-20T09:00:00.000Z',
      hasTime: true,
      remind: true,
      lead: '1h'
    })
    expect(c.type).toBe('dateMention')
    expect(c.props.anchorId).toBe('dm_1')
    expect(c.props.remind).toBe(true)
  })

  it('formats a date-only label without time', () => {
    const label = formatDateMentionLabel('2026-06-20T00:00:00.000Z', false)
    expect(label).toMatch(/Jun 20/)
    expect(label).not.toMatch(/:/)
  })
})
