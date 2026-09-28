import { describe, it, expect } from 'vitest'
import { extractEntityEdgesFromScene, extractEntityRefsFromScene } from './scene-refs'

function scene(elements: unknown[]): string {
  return JSON.stringify({ type: 'excalidraw', version: 2, elements })
}

describe('extractEntityRefsFromScene', () => {
  it('returns [] for an empty string', () => {
    expect(extractEntityRefsFromScene('')).toEqual([])
  })

  it('returns [] for unparseable JSON (never throws inside apply)', () => {
    expect(extractEntityRefsFromScene('{not json')).toEqual([])
  })

  it('returns [] when elements is missing or not an array', () => {
    expect(extractEntityRefsFromScene(JSON.stringify({ type: 'excalidraw' }))).toEqual([])
    expect(extractEntityRefsFromScene(JSON.stringify({ elements: 'nope' }))).toEqual([])
  })

  it('extracts a card ref from a rectangle with customData', () => {
    const refs = extractEntityRefsFromScene(
      scene([{ id: 'r1', type: 'rectangle', customData: { entityType: 'note', entityId: 'n1' } }])
    )
    expect(refs).toEqual([{ entityType: 'note', entityId: 'n1' }])
  })

  it('supports all card entity types', () => {
    const refs = extractEntityRefsFromScene(
      scene([
        { id: 'r1', type: 'rectangle', customData: { entityType: 'note', entityId: 'n1' } },
        { id: 'r2', type: 'rectangle', customData: { entityType: 'task', entityId: 't1' } },
        {
          id: 'r3',
          type: 'rectangle',
          customData: { entityType: 'calendar_event', entityId: 'e1' }
        },
        { id: 'r4', type: 'rectangle', customData: { entityType: 'project', entityId: 'p1' } },
        { id: 'r5', type: 'rectangle', customData: { entityType: 'file', entityId: 'f1' } }
      ])
    )
    expect(refs).toEqual([
      { entityType: 'note', entityId: 'n1' },
      { entityType: 'task', entityId: 't1' },
      { entityType: 'calendar_event', entityId: 'e1' },
      { entityType: 'project', entityId: 'p1' },
      { entityType: 'file', entityId: 'f1' }
    ])
  })

  it('dedups by (entityType, entityId)', () => {
    const refs = extractEntityRefsFromScene(
      scene([
        { id: 'r1', type: 'rectangle', customData: { entityType: 'note', entityId: 'n1' } },
        { id: 'r2', type: 'rectangle', customData: { entityType: 'note', entityId: 'n1' } }
      ])
    )
    expect(refs).toEqual([{ entityType: 'note', entityId: 'n1' }])
  })

  it('ignores deleted elements, non-rectangles, and invalid/missing customData', () => {
    const refs = extractEntityRefsFromScene(
      scene([
        {
          id: 'del',
          type: 'rectangle',
          isDeleted: true,
          customData: { entityType: 'note', entityId: 'n1' }
        },
        { id: 'text', type: 'text', customData: { entityType: 'note', entityId: 'n2' } },
        { id: 'plain', type: 'rectangle' },
        { id: 'bad-type', type: 'rectangle', customData: { entityType: 'widget', entityId: 'n3' } },
        { id: 'empty-id', type: 'rectangle', customData: { entityType: 'note', entityId: '' } }
      ])
    )
    expect(refs).toEqual([])
  })
})

describe('extractEntityEdgesFromScene', () => {
  const card = (id: string, entityType: string, entityId: string, extra = {}): unknown => ({
    id,
    type: 'rectangle',
    customData: { entityType, entityId },
    ...extra
  })
  const arrow = (id: string, start: string | null, end: string | null, extra = {}): unknown => ({
    id,
    type: 'arrow',
    startBinding: start ? { elementId: start, focus: 0, gap: 4 } : null,
    endBinding: end ? { elementId: end, focus: 0, gap: 4 } : null,
    startArrowhead: null,
    endArrowhead: 'arrow',
    ...extra
  })

  it('returns [] for empty or unparseable scenes', () => {
    expect(extractEntityEdgesFromScene('')).toEqual([])
    expect(extractEntityEdgesFromScene('{not json')).toEqual([])
  })

  it('turns an arrow between two cards into an edge that follows the arrow', () => {
    const edges = extractEntityEdgesFromScene(
      scene([card('c1', 'note', 'n1'), card('c2', 'note', 'n2'), arrow('a1', 'c1', 'c2')])
    )
    expect(edges).toEqual([
      {
        arrowId: 'a1',
        source: { entityType: 'note', entityId: 'n1' },
        target: { entityType: 'note', entityId: 'n2' }
      }
    ])
  })

  it('keeps every card type, not only notes', () => {
    const edges = extractEntityEdgesFromScene(
      scene([card('c1', 'task', 't1'), card('c2', 'project', 'p1'), arrow('a1', 'c1', 'c2')])
    )
    expect(edges).toEqual([
      {
        arrowId: 'a1',
        source: { entityType: 'task', entityId: 't1' },
        target: { entityType: 'project', entityId: 'p1' }
      }
    ])
  })

  it('reverses an arrow whose only head is at the start', () => {
    const [edge] = extractEntityEdgesFromScene(
      scene([
        card('c1', 'note', 'n1'),
        card('c2', 'note', 'n2'),
        arrow('a1', 'c1', 'c2', { startArrowhead: 'arrow', endArrowhead: null })
      ])
    )
    expect(edge.source.entityId).toBe('n2')
    expect(edge.target.entityId).toBe('n1')
  })

  it('keeps drawing order for heads on both ends', () => {
    const [edge] = extractEntityEdgesFromScene(
      scene([
        card('c1', 'note', 'n1'),
        card('c2', 'note', 'n2'),
        arrow('a1', 'c1', 'c2', { startArrowhead: 'arrow', endArrowhead: 'arrow' })
      ])
    )
    expect(edge.source.entityId).toBe('n1')
  })

  it('ignores arrows ending on a plain shape or on nothing', () => {
    const edges = extractEntityEdgesFromScene(
      scene([
        card('c1', 'note', 'n1'),
        card('c2', 'note', 'n2'),
        { id: 's1', type: 'rectangle' },
        { id: 't1', type: 'text', text: 'hi' },
        arrow('a1', 'c1', 's1'),
        arrow('a2', 't1', 'c2'),
        arrow('a3', 'c1', null),
        arrow('a4', null, null)
      ])
    )
    expect(edges).toEqual([])
  })

  it('ignores deleted arrows and arrows bound to deleted cards', () => {
    const edges = extractEntityEdgesFromScene(
      scene([
        card('c1', 'note', 'n1'),
        card('c2', 'note', 'n2', { isDeleted: true }),
        card('c3', 'note', 'n3'),
        arrow('a1', 'c1', 'c2'),
        arrow('a2', 'c1', 'c3', { isDeleted: true })
      ])
    )
    expect(edges).toEqual([])
  })

  it('ignores an arrow that joins an entity to itself, even through two cards of it', () => {
    const edges = extractEntityEdgesFromScene(
      scene([card('c1', 'note', 'n1'), card('c2', 'note', 'n1'), arrow('a1', 'c1', 'c2')])
    )
    expect(edges).toEqual([])
  })

  it('ignores lines, which carry no binding semantics', () => {
    const edges = extractEntityEdgesFromScene(
      scene([
        card('c1', 'note', 'n1'),
        card('c2', 'note', 'n2'),
        { ...(arrow('l1', 'c1', 'c2') as object), type: 'line' }
      ])
    )
    expect(edges).toEqual([])
  })
})
