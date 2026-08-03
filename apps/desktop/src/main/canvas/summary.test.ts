import { describe, expect, it } from 'vitest'
import { summarizeScene, MAX_SUMMARY_TEXTS } from './summary'

function scene(elements: unknown[]): string {
  return JSON.stringify({ type: 'excalidraw', elements })
}

const card = (
  entityType: string,
  entityId: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  id: `rect-${entityId}`,
  type: 'rectangle',
  customData: { entityType, entityId },
  ...extra
})

describe('summarizeScene', () => {
  it('returns an empty summary for an empty or unparseable scene', () => {
    expect(summarizeScene('')).toEqual({
      items: [],
      texts: [],
      elementCount: 0,
      textsTruncated: false
    })
    expect(summarizeScene('{not json')).toEqual({
      items: [],
      texts: [],
      elementCount: 0,
      textsTruncated: false
    })
  })

  it('collects deduped entity refs and text, ignoring deleted elements', () => {
    const result = summarizeScene(
      scene([
        card('note', 'n1'),
        card('note', 'n1'),
        card('task', 't1', { isDeleted: true }),
        { id: 'x', type: 'text', text: 'Q3 planning' },
        { id: 'y', type: 'text', text: 'gone', isDeleted: true },
        { id: 'z', type: 'arrow' }
      ])
    )

    expect(result.items).toEqual([{ entityType: 'note', entityId: 'n1' }])
    expect(result.texts).toEqual(['Q3 planning'])
    expect(result.elementCount).toBe(4)
    expect(result.textsTruncated).toBe(false)
  })

  it('ignores rectangles without a valid entity ref', () => {
    const result = summarizeScene(
      scene([
        { id: 'a', type: 'rectangle' },
        { id: 'b', type: 'rectangle', customData: { entityType: 'wat', entityId: 'x' } },
        { id: 'c', type: 'rectangle', customData: { entityType: 'note', entityId: '' } }
      ])
    )
    expect(result.items).toEqual([])
  })

  it('skips blank text and trims what it keeps', () => {
    const result = summarizeScene(
      scene([
        { id: 'a', type: 'text', text: '   ' },
        { id: 'b', type: 'text', text: '  spaced  ' },
        { id: 'c', type: 'text' }
      ])
    )
    expect(result.texts).toEqual(['spaced'])
  })

  it('caps the number of texts and flags truncation', () => {
    const many = Array.from({ length: MAX_SUMMARY_TEXTS + 5 }, (_, i) => ({
      id: `t${i}`,
      type: 'text',
      text: `line ${i}`
    }))
    const result = summarizeScene(scene(many))

    expect(result.texts).toHaveLength(MAX_SUMMARY_TEXTS)
    expect(result.textsTruncated).toBe(true)
  })

  it('caps total text characters and flags truncation', () => {
    const result = summarizeScene(
      scene([
        { id: 'a', type: 'text', text: 'x'.repeat(19_990) },
        { id: 'b', type: 'text', text: 'y'.repeat(100) }
      ])
    )

    expect(result.texts).toHaveLength(1)
    expect(result.textsTruncated).toBe(true)
  })
})
