import { generateId } from '../../src/main/lib/id'
import { NOTE_IDS } from './notes'
import { TASKS } from './tasks'
import { CALENDAR_EVENTS } from './calendar'

// ============================================================================
// Spatial canvases — two demo boards built from Excalidraw scene JSON.
//
// The scene string is serializeAsJSON-shaped ({ type, version, elements,
// appState, files }); Excalidraw's restore fills element defaults on load, so
// elements carry only the meaningful subset. Cards are rectangles with
// customData { entityType, entityId } (see renderer canvas-cards.ts
// makeCardSkeleton — stroke/fill values mirror it) referencing seeded notes,
// tasks and calendar events.
// ============================================================================

type CanvasEntityType = 'note' | 'task' | 'calendar_event'

export interface SeedCanvasEntityRef {
  entityType: CanvasEntityType
  entityId: string
}

export interface SeedCanvasData {
  id: string
  title: string
  scene: string
  entityRefs: SeedCanvasEntityRef[]
}

function taskId(title: string): string {
  const task = TASKS.find((t) => t.title === title)
  if (!task) throw new Error(`seed canvas: task not found: ${title}`)
  return task.id
}

function eventId(title: string): string {
  const event = CALENDAR_EVENTS.find((e) => e.title === title)
  if (!event) throw new Error(`seed canvas: calendar event not found: ${title}`)
  return event.id
}

// Excalidraw fractional index charset order: 0-9 < A-Z < a-z.
const INDEX_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

type SceneElement = Record<string, unknown>

const randomSeed = (): number => Math.floor(Math.random() * 2 ** 31)

function baseElement(
  index: number,
  partial: SceneElement & { type: string; x: number; y: number; width: number; height: number }
): SceneElement {
  if (index >= INDEX_CHARS.length) {
    throw new Error('seed canvas: too many elements for the single-char index scheme')
  }
  return {
    id: generateId(),
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: `a${INDEX_CHARS[index]}`,
    roundness: null,
    seed: randomSeed(),
    version: 1,
    versionNonce: randomSeed(),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    ...partial
  }
}

/** Card rectangle — geometry mirror of renderer makeCardSkeleton. */
function card(
  index: number,
  ref: SeedCanvasEntityRef,
  pos: { x: number; y: number }
): SceneElement {
  return baseElement(index, {
    type: 'rectangle',
    x: pos.x,
    y: pos.y,
    width: 260,
    height: 168,
    strokeColor: '#ced4da',
    backgroundColor: '#ffffff',
    strokeWidth: 1,
    roughness: 0,
    roundness: { type: 3 },
    customData: { entityType: ref.entityType, entityId: ref.entityId }
  })
}

function text(
  index: number,
  content: string,
  pos: { x: number; y: number },
  fontSize = 20
): SceneElement {
  return baseElement(index, {
    type: 'text',
    x: pos.x,
    y: pos.y,
    width: content.length * fontSize * 0.6,
    height: fontSize * 1.25,
    text: content,
    fontSize,
    fontFamily: 1,
    textAlign: 'left',
    verticalAlign: 'top',
    containerId: null,
    originalText: content,
    autoResize: true,
    lineHeight: 1.25
  })
}

function lane(
  index: number,
  pos: { x: number; y: number; width: number; height: number }
): SceneElement {
  return baseElement(index, {
    type: 'rectangle',
    ...pos,
    strokeColor: '#868e96',
    strokeStyle: 'dashed',
    roundness: { type: 3 }
  })
}

function arrow(
  index: number,
  from: { x: number; y: number },
  to: { x: number; y: number }
): SceneElement {
  return baseElement(index, {
    type: 'arrow',
    x: from.x,
    y: from.y,
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
    strokeColor: '#868e96',
    roundness: { type: 2 },
    points: [
      [0, 0],
      [to.x - from.x, to.y - from.y]
    ],
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: 'arrow',
    elbowed: false
  })
}

function scene(elements: SceneElement[]): string {
  return JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'memry-seed',
    elements,
    appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
    files: {}
  })
}

function dedupeRefs(refs: SeedCanvasEntityRef[]): SeedCanvasEntityRef[] {
  const seen = new Set<string>()
  return refs.filter((ref) => {
    const key = `${ref.entityType}:${ref.entityId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function buildIstanbulCanvas(): SeedCanvasData {
  const refs: SeedCanvasEntityRef[] = [
    { entityType: 'note', entityId: NOTE_IDS.travelIstanbul },
    { entityType: 'task', entityId: taskId('Confirm Bosphorus ferry plan') },
    { entityType: 'task', entityId: taskId('Pick Kadıköy dinner spot') },
    { entityType: 'task', entityId: taskId('Book airport transfer') }
  ]
  const elements: SceneElement[] = [
    text(0, 'Istanbul Weekend Plan', { x: 40, y: 8 }, 28),
    lane(1, { x: 0, y: 80, width: 620, height: 260 }),
    text(2, 'Saturday', { x: 24, y: 96 }, 16),
    lane(3, { x: 0, y: 380, width: 620, height: 260 }),
    text(4, 'Sunday', { x: 24, y: 396 }, 16),
    card(5, refs[1], { x: 40, y: 140 }),
    card(6, refs[2], { x: 330, y: 140 }),
    card(7, refs[3], { x: 40, y: 440 }),
    card(8, refs[0], { x: 700, y: 140 }),
    text(9, 'trip notes', { x: 740, y: 108 }, 16),
    arrow(10, { x: 700, y: 230 }, { x: 640, y: 210 }),
    text(11, 'ferry first, dinner after ✌️', { x: 340, y: 460 }, 16)
  ]
  return {
    id: generateId(),
    title: 'Istanbul Weekend Plan',
    scene: scene(elements),
    entityRefs: dedupeRefs(refs)
  }
}

function buildLaunchCanvas(): SeedCanvasData {
  const refs: SeedCanvasEntityRef[] = [
    { entityType: 'note', entityId: NOTE_IDS.projMemryLaunch },
    { entityType: 'note', entityId: NOTE_IDS.projMemryRoadmap },
    { entityType: 'task', entityId: taskId('Build public landing page') },
    { entityType: 'task', entityId: taskId('Decide on pricing') },
    { entityType: 'calendar_event', entityId: eventId('Sprint planning') }
  ]
  const elements: SceneElement[] = [
    text(0, 'memrynote Launch', { x: 40, y: 8 }, 28),
    card(1, refs[0], { x: 0, y: 80 }),
    card(2, refs[1], { x: 0, y: 300 }),
    baseElement(3, {
      type: 'diamond',
      x: 360,
      y: 130,
      width: 200,
      height: 120,
      strokeColor: '#e8590c',
      backgroundColor: '#fff4e6',
      roundness: { type: 2 }
    }),
    text(4, 'Beta ready?', { x: 402, y: 176 }, 16),
    card(5, refs[2], { x: 660, y: 60 }),
    card(6, refs[3], { x: 660, y: 260 }),
    card(7, refs[4], { x: 360, y: 340 }),
    arrow(8, { x: 260, y: 170 }, { x: 360, y: 185 }),
    arrow(9, { x: 560, y: 160 }, { x: 660, y: 140 }),
    arrow(10, { x: 560, y: 220 }, { x: 660, y: 320 })
  ]
  return {
    id: generateId(),
    title: 'memrynote Launch',
    scene: scene(elements),
    entityRefs: dedupeRefs(refs)
  }
}

export const CANVASES: SeedCanvasData[] = [buildIstanbulCanvas(), buildLaunchCanvas()]
