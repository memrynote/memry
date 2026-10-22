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
  it('derives one row per readable fence and keeps ordinals stable around a broken one', () => {
    const md = [
      fence('{"note":"n1"}'),
      fence('{not json'),
      fence('{"note":"n2","block":"abc123","hidden":["x1y2z3","q9w8e7"]}'),
      fence('{"search":{"text":"exam","limit":10}}')
    ].join('\n\n')
    expect(derivePortalRefs('host', md)).toEqual([
      {
        hostNoteId: 'host',
        ordinal: 0,
        sourceNoteId: 'n1',
        anchor: null,
        hiddenCount: 0,
        kind: 'note'
      },
      {
        hostNoteId: 'host',
        ordinal: 2,
        sourceNoteId: 'n2',
        anchor: 'abc123',
        hiddenCount: 2,
        kind: 'block'
      },
      {
        hostNoteId: 'host',
        ordinal: 3,
        sourceNoteId: null,
        anchor: null,
        hiddenCount: 0,
        kind: 'search'
      }
    ])
  })
})
