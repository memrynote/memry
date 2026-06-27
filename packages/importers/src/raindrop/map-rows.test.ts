import { describe, expect, it } from 'vitest'
import { parseRaindropCsv } from './parse-csv'
import { mapRows } from './map-rows'

const NOW = '2026-06-27T00:00:00.000Z'
const HEADER = 'id,title,note,excerpt,url,folder,tags,created,cover,highlights,favorite'

function plan(csv: string) {
  return mapRows(parseRaindropCsv(`${HEADER}\n${csv}`), { now: NOW })
}

describe('parseRaindropCsv', () => {
  it('parses quoted fields with embedded commas and tags', () => {
    const rows = parseRaindropCsv(
      `${HEADER}\n1,"Hello, world","a note","an excerpt",https://x.com,Reading,"tag1, Tag2",2024-01-02T03:04:05.000Z,https://img,,true`
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      title: 'Hello, world',
      url: 'https://x.com',
      folder: 'Reading',
      tags: ['tag1', 'tag2'],
      favorite: true
    })
  })

  it('throws when the header lacks a url column', () => {
    expect(() => parseRaindropCsv('a,b,c\n1,2,3')).toThrow(/url/)
  })
})

describe('mapRows', () => {
  it('maps a full row to a link inbox item', () => {
    const p = plan(
      '1,My Title,My note,My excerpt,https://example.com,Reading,"a,b",2024-05-01T10:00:00.000Z,https://cover,some highlight,true'
    )
    expect(p.items).toHaveLength(1)
    expect(p.items[0]).toEqual({
      title: 'My Title',
      content: 'My note\n\nMy excerpt',
      sourceUrl: 'https://example.com',
      createdAt: '2024-05-01T10:00:00.000Z',
      tags: ['a', 'b', 'reading'],
      metadata: {
        url: 'https://example.com',
        excerpt: 'My excerpt',
        note: 'My note',
        folder: 'Reading',
        favorite: true,
        heroImage: 'https://cover',
        highlights: 'some highlight'
      }
    })
  })

  it('falls back to the url when title is empty', () => {
    const p = plan('1,,,,https://no-title.com,Unsorted,,2024-05-01T10:00:00.000Z,,,false')
    expect(p.items[0].title).toBe('https://no-title.com')
  })

  it('drops the Unsorted collection but keeps real folders as tags, deduped', () => {
    const p = plan('1,t,,,https://u.com,Unsorted,unsorted,2024-05-01T10:00:00.000Z,,,false')
    expect(p.items[0].tags).toEqual(['unsorted']) // explicit tag kept; folder "Unsorted" dropped
    const p2 = plan('1,t,,,https://u.com,Reading,reading,2024-05-01T10:00:00.000Z,,,false')
    expect(p2.items[0].tags).toEqual(['reading']) // folder-as-tag deduped against tag
  })

  it('content is null when note and excerpt are both empty', () => {
    const p = plan('1,t,,,https://c.com,Unsorted,,2024-05-01T10:00:00.000Z,,,false')
    expect(p.items[0].content).toBeNull()
  })

  it('skips rows without a url and counts them', () => {
    const p = plan(
      [
        '1,has url,,,https://ok.com,Unsorted,,2024-05-01T10:00:00.000Z,,,false',
        '2,no url,,,,Unsorted,,2024-05-01T10:00:00.000Z,,,false'
      ].join('\n')
    )
    expect(p.stats.bookmarks).toBe(1)
    expect(p.stats.skipped).toBe(1)
    expect(p.warnings).toHaveLength(1)
  })

  it('falls back to now for an invalid created timestamp', () => {
    const p = plan('1,t,,,https://d.com,Unsorted,,not-a-date,,,false')
    expect(p.items[0].createdAt).toBe(NOW)
  })

  it('reports stats and sample titles', () => {
    const p = plan(
      [
        '1,A,,,https://a.com,Reading,x,2024-05-01T10:00:00.000Z,,,false',
        '2,B,,,https://b.com,Unsorted,,2024-05-01T10:00:00.000Z,,,false'
      ].join('\n')
    )
    expect(p.stats).toEqual({ bookmarks: 2, withTags: 1, skipped: 0 })
    expect(p.sampleTitles).toEqual(['A', 'B'])
  })
})
