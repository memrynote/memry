import { describe, it, expect } from 'vitest'
import { extractEntityRefsFromScene } from './scene-refs'

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
        }
      ])
    )
    expect(refs).toEqual([
      { entityType: 'note', entityId: 'n1' },
      { entityType: 'task', entityId: 't1' },
      { entityType: 'calendar_event', entityId: 'e1' }
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
