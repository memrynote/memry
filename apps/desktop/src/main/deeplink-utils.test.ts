import { describe, expect, it } from 'vitest'
import { parseInboxOpenItemId } from './deeplink-utils'

describe('parseInboxOpenItemId', () => {
  it('returns itemId from a valid memry://open?item=<id> url', () => {
    expect(parseInboxOpenItemId('memry://open?item=abc-123')).toBe('abc-123')
  })

  it('returns null for a different hostname', () => {
    expect(parseInboxOpenItemId('memry://pair?item=abc-123')).toBeNull()
  })

  it('returns null when the item param is missing', () => {
    expect(parseInboxOpenItemId('memry://open')).toBeNull()
  })

  it('returns null for a non-memry protocol', () => {
    expect(parseInboxOpenItemId('https://open?item=abc-123')).toBeNull()
  })
})
