import { describe, expect, it } from 'vitest'

import { MAX_ELEMENT_VIEWS, readSceneElements } from './elements'

function scene(elements: unknown[]): string {
  return JSON.stringify({ type: 'excalidraw', elements })
}

describe('readSceneElements', () => {
  it('returns an empty read for an empty or unparseable scene', () => {
    expect(readSceneElements('')).toEqual({ elements: [], elementCount: 0, truncated: false })
    expect(readSceneElements('{not json')).toEqual({
      elements: [],
      elementCount: 0,
      truncated: false
    })
  })

  it('reports geometry and the fields an agent binds to', () => {
    const result = readSceneElements(
      scene([
        {
          id: 'r1',
          type: 'rectangle',
          x: 10,
          y: 20,
          width: 100,
          height: 50,
          strokeColor: '#1e1e1e',
          backgroundColor: '#ffec99',
          link: 'https://example.com',
          // Bookkeeping an agent must never have to read or reproduce.
          seed: 12345,
          version: 8,
          versionNonce: 99,
          index: 'a1'
        }
      ])
    )

    expect(result.elements).toEqual([
      {
        id: 'r1',
        type: 'rectangle',
        x: 10,
        y: 20,
        width: 100,
        height: 50,
        strokeColor: '#1e1e1e',
        backgroundColor: '#ffec99',
        link: 'https://example.com'
      }
    ])
    expect(result.elementCount).toBe(1)
  })

  it('surfaces a card’s entity so an agent can tell cards from shapes', () => {
    const result = readSceneElements(
      scene([
        {
          id: 'card',
          type: 'rectangle',
          x: 0,
          y: 0,
          width: 260,
          height: 168,
          customData: { entityType: 'note', entityId: 'note-1' }
        }
      ])
    )

    expect(result.elements[0]).toMatchObject({ entityType: 'note', entityId: 'note-1' })
  })

  it('ignores customData that is not a real entity ref', () => {
    const result = readSceneElements(
      scene([
        {
          id: 'x',
          type: 'rectangle',
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          customData: { entityType: 'wallet', entityId: 'w1' }
        }
      ])
    )

    expect(result.elements[0].entityType).toBeUndefined()
  })

  it('folds a caption into its container instead of reporting two elements', () => {
    const result = readSceneElements(
      scene([
        { id: 'box', type: 'rectangle', x: 0, y: 0, width: 100, height: 40 },
        {
          id: 'cap',
          type: 'text',
          x: 5,
          y: 5,
          width: 90,
          height: 20,
          containerId: 'box',
          text: 'Hi'
        }
      ])
    )

    expect(result.elements).toHaveLength(1)
    expect(result.elements[0]).toMatchObject({ id: 'box', label: 'Hi' })
  })

  it('keeps a standalone text element as its own element', () => {
    const result = readSceneElements(
      scene([{ id: 't', type: 'text', x: 0, y: 0, width: 50, height: 20, text: 'Loose' }])
    )

    expect(result.elements[0]).toMatchObject({ id: 't', type: 'text', text: 'Loose' })
  })

  it('reports arrow bindings by element id', () => {
    const result = readSceneElements(
      scene([
        {
          id: 'a',
          type: 'arrow',
          x: 0,
          y: 0,
          width: 100,
          height: 0,
          startBinding: { elementId: 'one', focus: 0, gap: 4 },
          endBinding: { elementId: 'two', focus: 0, gap: 4 }
        }
      ])
    )

    expect(result.elements[0]).toMatchObject({ startElementId: 'one', endElementId: 'two' })
  })

  it('skips deleted elements', () => {
    const result = readSceneElements(
      scene([
        { id: 'gone', type: 'rectangle', x: 0, y: 0, width: 1, height: 1, isDeleted: true },
        { id: 'here', type: 'rectangle', x: 0, y: 0, width: 1, height: 1 }
      ])
    )

    expect(result.elements.map((el) => el.id)).toEqual(['here'])
    expect(result.elementCount).toBe(1)
  })

  it('caps the read and says so', () => {
    const many = Array.from({ length: MAX_ELEMENT_VIEWS + 5 }, (_, i) => ({
      id: `e${i}`,
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 1,
      height: 1
    }))

    const result = readSceneElements(scene(many))
    expect(result.elements).toHaveLength(MAX_ELEMENT_VIEWS)
    expect(result.elementCount).toBe(MAX_ELEMENT_VIEWS + 5)
    expect(result.truncated).toBe(true)
  })
})
