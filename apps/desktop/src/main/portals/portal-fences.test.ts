import { describe, expect, it } from 'vitest'
import { derivePortalRefs, scanPortalFences } from './portal-fences'

const fence = (body: string, info = 'memry-portal'): string => '```' + info + '\n' + body + '\n```'

describe('scanPortalFences', () => {
  it('returns each portal fence body in document order', () => {
    const md = ['intro', fence('{"note":"a"}'), 'between', fence('{"note":"b"}')].join('\n\n')
    expect(scanPortalFences(md)).toEqual(['{"note":"a"}', '{"note":"b"}'])
  })

  it('ignores portal text inside another fence', () => {
    const md = fence('```memry-portal\n{"note":"a"}\n```', 'markdown')
    const quoted = '````markdown\n```memry-portal\n{"note":"a"}\n```\n````'
    expect(scanPortalFences(md)).toEqual([])
    expect(scanPortalFences(quoted)).toEqual([])
  })

  it('reads a fence inside a list item or quote', () => {
    expect(scanPortalFences('- item\n  ```memry-portal\n  {"note":"a"}\n  ```')).toEqual([
      '{"note":"a"}'
    ])
    expect(scanPortalFences('> ```memry-portal\n> {"note":"a"}\n> ```')).toEqual(['{"note":"a"}'])
  })

  it('treats an unclosed fence as running to the end', () => {
    expect(scanPortalFences('```memry-portal\n{"note":"a"}')).toEqual(['{"note":"a"}'])
  })
})

describe('derivePortalRefs', () => {
  it('derives a row per fence, and one per root anchor, keeping ordinals stable around a broken fence', () => {
    const md = [
      fence('{"v":1,"note":"n1"}'),
      fence('{not json'),
      fence(
        '{"v":1,"note":"n2","blocks":["abc123","def456"],"open":{"abc123":{"show":["x1y2z3"]}}}'
      ),
      fence('{"v":1,"search":{"text":"exam","limit":10}}')
    ].join('\n\n')
    expect(derivePortalRefs('host', md)).toEqual([
      { hostNoteId: 'host', ordinal: 0, root: 0, sourceNoteId: 'n1', anchor: null, kind: 'note' },
      {
        hostNoteId: 'host',
        ordinal: 2,
        root: 0,
        sourceNoteId: 'n2',
        anchor: 'abc123',
        kind: 'blocks'
      },
      {
        hostNoteId: 'host',
        ordinal: 2,
        root: 1,
        sourceNoteId: 'n2',
        anchor: 'def456',
        kind: 'blocks'
      },
      {
        hostNoteId: 'host',
        ordinal: 3,
        root: 0,
        sourceNoteId: null,
        anchor: null,
        kind: 'search'
      }
    ])
  })

  it('does not index anchors that are only open or hidden entries', () => {
    const rows = derivePortalRefs(
      'host',
      fence('{"note":"n2","blocks":["abc123"],"open":{"abc123":{"hide":["zzzz11"]}}}')
    )
    expect(rows.map((row) => row.anchor)).toEqual(['abc123'])
  })
})
