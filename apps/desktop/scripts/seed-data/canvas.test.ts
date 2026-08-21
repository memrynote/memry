import { describe, expect, it } from 'vitest'

import { CANVASES } from './canvas'
import { TASKS } from './tasks'
import { CALENDAR_EVENTS } from './calendar'
import { NOTE_IDS } from './notes'

interface SceneShape {
  type: string
  version: number
  elements: Array<{
    type: string
    index: string
    customData?: { entityType: string; entityId: string }
  }>
  appState: Record<string, unknown>
  files: Record<string, unknown>
}

const KNOWN_IDS = new Set<string>([
  ...Object.values(NOTE_IDS),
  ...TASKS.map((t) => t.id),
  ...CALENDAR_EVENTS.map((e) => e.id)
])

describe('canvas seed data', () => {
  it('seeds six populated canvases', () => {
    expect(CANVASES).toHaveLength(6)
    for (const canvas of CANVASES) {
      const scene = JSON.parse(canvas.scene) as SceneShape
      expect(scene.type).toBe('excalidraw')
      expect(scene.version).toBe(2)
      expect(scene.elements.length).toBeGreaterThan(5)
      expect(canvas.entityRefs.length).toBeGreaterThan(0)
    }
  })

  it('cards reference seeded entities and match the advisory refs', () => {
    for (const canvas of CANVASES) {
      const scene = JSON.parse(canvas.scene) as SceneShape
      const cardRefs = scene.elements
        .filter((el) => el.type === 'rectangle' && el.customData)
        .map((el) => el.customData!)

      expect(cardRefs.length).toBeGreaterThan(0)
      for (const ref of cardRefs) {
        expect(KNOWN_IDS.has(ref.entityId)).toBe(true)
      }

      const sceneKeys = new Set(cardRefs.map((r) => `${r.entityType}:${r.entityId}`))
      const advisoryKeys = new Set(canvas.entityRefs.map((r) => `${r.entityType}:${r.entityId}`))
      expect(advisoryKeys).toEqual(sceneKeys)
    }
  })

  it('elements carry unique, ordered fractional indices', () => {
    for (const canvas of CANVASES) {
      const scene = JSON.parse(canvas.scene) as SceneShape
      const indices = scene.elements.map((el) => el.index)
      expect(new Set(indices).size).toBe(indices.length)
      expect([...indices].sort()).toEqual(indices)
    }
  })
})
