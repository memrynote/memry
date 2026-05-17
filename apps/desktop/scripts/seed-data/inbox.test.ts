import { describe, expect, it } from 'vitest'

import { INBOX_ITEMS } from './inbox'

function hasSourceHostname(hostname: string): boolean {
  return INBOX_ITEMS.some((item) => {
    if (item.archivedAt || !item.sourceUrl) {
      return false
    }

    try {
      const itemHostname = new URL(item.sourceUrl).hostname.toLowerCase()
      return itemHostname === hostname || itemHostname.endsWith(`.${hostname}`)
    } catch {
      return false
    }
  })
}

describe('inbox seed data', () => {
  it('uses real-world capture examples for landing screenshots', () => {
    const activeItems = INBOX_ITEMS.filter((item) => !item.archivedAt)
    const activeText = activeItems
      .flatMap((item) => [
        item.title,
        item.content ?? '',
        item.sourceUrl ?? '',
        item.sourceTitle ?? '',
        ...(item.tags ?? [])
      ])
      .join(' ')

    expect(hasSourceHostname('youtube.com')).toBe(true)
    expect(hasSourceHostname('x.com')).toBe(true)
    expect(hasSourceHostname('reddit.com')).toBe(true)
    expect(activeItems.some((item) => item.type === 'pdf')).toBe(true)
    expect(activeItems.some((item) => item.type === 'image')).toBe(true)

    for (const technicalTerm of [
      'CRDT',
      'GitHub',
      'Bun',
      'E2EE',
      'Drizzle',
      'Synthetic Data',
      'Astro',
      'Local-First',
      'programming book',
      'build pipeline',
      'memrynote export',
      'tech/'
    ]) {
      expect(activeText).not.toContain(technicalTerm)
    }
  })
})
