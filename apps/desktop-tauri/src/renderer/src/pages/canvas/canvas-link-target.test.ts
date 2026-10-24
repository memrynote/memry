import { describe, expect, it } from 'vitest'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { resolveLinkTarget } from './canvas-link-target'

function sceneWith(
  selected: string[],
  elements: { id: string; customData?: { entityType?: string } }[]
): ExcalidrawImperativeAPI {
  return {
    getAppState: () => ({
      selectedElementIds: Object.fromEntries(selected.map((id) => [id, true]))
    }),
    getSceneElements: () => elements
  } as unknown as ExcalidrawImperativeAPI
}

describe('resolveLinkTarget', () => {
  it('names the one selected shape', () => {
    expect(resolveLinkTarget(sceneWith(['a'], [{ id: 'a' }, { id: 'b' }]))).toEqual({
      kind: 'shape',
      elementId: 'a'
    })
  })

  it('refuses an empty or multiple selection', () => {
    const elements = [{ id: 'a' }, { id: 'b' }]
    expect(resolveLinkTarget(sceneWith([], elements))).toEqual({ kind: 'none' })
    expect(resolveLinkTarget(sceneWith(['a', 'b'], elements))).toEqual({ kind: 'none' })
  })

  it('refuses a selection that left the scene', () => {
    expect(resolveLinkTarget(sceneWith(['gone'], [{ id: 'a' }]))).toEqual({ kind: 'none' })
  })

  it('refuses a card, which opens its own item', () => {
    const card = { id: 'c', customData: { entityType: 'note' } }
    expect(resolveLinkTarget(sceneWith(['c'], [card]))).toEqual({ kind: 'card' })
  })
})
