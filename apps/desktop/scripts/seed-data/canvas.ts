import { generateId } from '../../src/main/lib/id'
import { NOTE_IDS } from './notes'
import { TASKS } from './tasks'
import { CALENDAR_EVENTS } from './calendar'

// ============================================================================
// Spatial canvases — six demo boards built from Excalidraw scene JSON.
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

function buildReadingCanvas(): SeedCanvasData {
  const refs: SeedCanvasEntityRef[] = [
    { entityType: 'note', entityId: NOTE_IDS.lifeOnReading },
    { entityType: 'note', entityId: NOTE_IDS.bookDune },
    { entityType: 'note', entityId: NOTE_IDS.bookProjectHailMary },
    { entityType: 'note', entityId: NOTE_IDS.bookSapiens },
    { entityType: 'note', entityId: NOTE_IDS.bookFourThousandWeeks },
    { entityType: 'note', entityId: NOTE_IDS.bookAtomicHabits },
    { entityType: 'task', entityId: taskId('Finish reading Sapiens') },
    { entityType: 'task', entityId: taskId('Read Dune Messiah') }
  ]
  const elements: SceneElement[] = [
    text(0, 'Reading Map 2026', { x: 40, y: 8 }, 28),
    text(1, 'the shelf, arranged by what it did to me', { x: 40, y: 46 }, 16),

    lane(2, { x: 0, y: 90, width: 620, height: 280 }),
    text(3, 'Fiction', { x: 24, y: 106 }, 16),
    card(4, refs[1], { x: 40, y: 150 }),
    card(5, refs[2], { x: 330, y: 150 }),

    lane(6, { x: 700, y: 90, width: 900, height: 280 }),
    text(7, 'Nonfiction', { x: 724, y: 106 }, 16),
    card(8, refs[3], { x: 740, y: 150 }),
    card(9, refs[4], { x: 1030, y: 150 }),
    card(10, refs[5], { x: 1320, y: 150 }),

    text(11, 'In flight', { x: 40, y: 420 }, 20),
    card(12, refs[6], { x: 40, y: 460 }),
    card(13, refs[7], { x: 330, y: 460 }),
    card(14, refs[0], { x: 740, y: 460 }),
    text(15, 'why I read at all', { x: 780, y: 428 }, 16),

    arrow(16, { x: 300, y: 234 }, { x: 740, y: 234 }),
    arrow(17, { x: 170, y: 318 }, { x: 170, y: 460 }),
    text(18, 'next up →', { x: 400, y: 200 }, 16)
  ]
  return {
    id: generateId(),
    title: 'Reading Map 2026',
    scene: scene(elements),
    entityRefs: dedupeRefs(refs)
  }
}

function buildCutCanvas(): SeedCanvasData {
  const refs: SeedCanvasEntityRef[] = [
    { entityType: 'note', entityId: NOTE_IDS.weightCut2026 },
    { entityType: 'note', entityId: NOTE_IDS.weightTrainingSplit },
    { entityType: 'note', entityId: NOTE_IDS.weightProteinTargets },
    { entityType: 'note', entityId: NOTE_IDS.weightCardioPlan },
    { entityType: 'note', entityId: NOTE_IDS.weightCuttingLog },
    { entityType: 'task', entityId: taskId('Sunday weigh-in') },
    { entityType: 'task', entityId: taskId('Sunday meal prep') },
    { entityType: 'calendar_event', entityId: eventId('🏋️ Lift — Lower') }
  ]
  const elements: SceneElement[] = [
    text(0, '2026 Cut — the loop', { x: 40, y: 8 }, 28),

    card(1, refs[0], { x: 480, y: 70 }),
    text(2, 'the plan', { x: 520, y: 40 }, 16),

    text(3, 'Three inputs', { x: 40, y: 300 }, 20),
    card(4, refs[1], { x: 40, y: 340 }),
    card(5, refs[2], { x: 330, y: 340 }),
    card(6, refs[3], { x: 620, y: 340 }),

    text(7, 'One feedback loop', { x: 960, y: 300 }, 20),
    card(8, refs[4], { x: 960, y: 340 }),
    card(9, refs[5], { x: 1250, y: 340 }),

    card(10, refs[6], { x: 620, y: 580 }),
    card(11, refs[7], { x: 330, y: 580 }),

    arrow(12, { x: 560, y: 240 }, { x: 300, y: 340 }),
    arrow(13, { x: 610, y: 240 }, { x: 700, y: 340 }),
    arrow(14, { x: 880, y: 424 }, { x: 960, y: 424 }),
    arrow(15, { x: 1090, y: 510 }, { x: 610, y: 200 }),
    text(16, 'measure, then adjust ↺', { x: 900, y: 540 }, 16)
  ]
  return {
    id: generateId(),
    title: '2026 Cut — the loop',
    scene: scene(elements),
    entityRefs: dedupeRefs(refs)
  }
}

function buildArchitectureCanvas(): SeedCanvasData {
  const refs: SeedCanvasEntityRef[] = [
    { entityType: 'note', entityId: NOTE_IDS.projMemryArchitecture },
    { entityType: 'note', entityId: NOTE_IDS.techCRDTArchitecture },
    { entityType: 'note', entityId: NOTE_IDS.techDrizzleORM },
    { entityType: 'note', entityId: NOTE_IDS.techSqliteVec },
    { entityType: 'note', entityId: NOTE_IDS.techElectronGotchas },
    { entityType: 'note', entityId: NOTE_IDS.techTypescriptPatterns },
    { entityType: 'task', entityId: taskId('CRDT sync v1') },
    { entityType: 'task', entityId: taskId('Graph view: lazy load > 500 nodes') }
  ]
  const elements: SceneElement[] = [
    text(0, 'How the app is put together', { x: 40, y: 8 }, 28),

    text(1, 'Renderer', { x: 40, y: 70 }, 20),
    lane(2, { x: 0, y: 100, width: 620, height: 250 }),
    card(3, refs[5], { x: 40, y: 140 }),
    card(4, refs[4], { x: 330, y: 140 }),

    text(5, 'Main process', { x: 700, y: 70 }, 20),
    lane(6, { x: 660, y: 100, width: 620, height: 250 }),
    card(7, refs[0], { x: 700, y: 140 }),
    card(8, refs[1], { x: 990, y: 140 }),

    text(9, 'Storage', { x: 40, y: 400 }, 20),
    lane(10, { x: 0, y: 430, width: 620, height: 250 }),
    card(11, refs[2], { x: 40, y: 470 }),
    card(12, refs[3], { x: 330, y: 470 }),

    text(13, 'In flight', { x: 700, y: 400 }, 20),
    card(14, refs[6], { x: 700, y: 470 }),
    card(15, refs[7], { x: 990, y: 470 }),

    arrow(16, { x: 620, y: 224 }, { x: 700, y: 224 }),
    arrow(17, { x: 830, y: 308 }, { x: 300, y: 470 }),
    text(18, 'IPC — every call is a contract', { x: 380, y: 360 }, 16)
  ]
  return {
    id: generateId(),
    title: 'How the app is put together',
    scene: scene(elements),
    entityRefs: dedupeRefs(refs)
  }
}

function buildTokyoCanvas(): SeedCanvasData {
  const refs: SeedCanvasEntityRef[] = [
    { entityType: 'note', entityId: NOTE_IDS.travelTokyoTrip },
    { entityType: 'note', entityId: NOTE_IDS.travelKyotoDayTrip },
    { entityType: 'note', entityId: NOTE_IDS.travelTokyoCafes },
    { entityType: 'note', entityId: NOTE_IDS.travelOsakaRamen },
    { entityType: 'note', entityId: NOTE_IDS.travelAirportLounges },
    { entityType: 'calendar_event', entityId: eventId('Tokyo flight') },
    { entityType: 'calendar_event', entityId: eventId('Tokyo — Ghibli Museum') },
    { entityType: 'calendar_event', entityId: eventId('Dinner — Tonkatsu Maisen') }
  ]
  const elements: SceneElement[] = [
    text(0, 'Tokyo, in order', { x: 40, y: 8 }, 28),
    text(1, 'eight days, laid out the way they happened', { x: 40, y: 46 }, 16),

    card(2, refs[5], { x: 40, y: 120 }),
    card(3, refs[4], { x: 330, y: 120 }),
    card(4, refs[0], { x: 620, y: 120 }),
    card(5, refs[2], { x: 910, y: 120 }),

    card(6, refs[1], { x: 330, y: 400 }),
    card(7, refs[6], { x: 620, y: 400 }),
    card(8, refs[7], { x: 910, y: 400 }),
    card(9, refs[3], { x: 1200, y: 400 }),

    arrow(10, { x: 300, y: 204 }, { x: 330, y: 204 }),
    arrow(11, { x: 590, y: 204 }, { x: 620, y: 204 }),
    arrow(12, { x: 880, y: 204 }, { x: 910, y: 204 }),
    arrow(13, { x: 750, y: 288 }, { x: 460, y: 400 }),
    arrow(14, { x: 590, y: 484 }, { x: 620, y: 484 }),
    arrow(15, { x: 880, y: 484 }, { x: 910, y: 484 }),
    arrow(16, { x: 1170, y: 484 }, { x: 1200, y: 484 }),
    text(17, 'the day that made the trip', { x: 340, y: 370 }, 16)
  ]
  return {
    id: generateId(),
    title: 'Tokyo, in order',
    scene: scene(elements),
    entityRefs: dedupeRefs(refs)
  }
}

export const CANVASES: SeedCanvasData[] = [
  buildIstanbulCanvas(),
  buildLaunchCanvas(),
  buildReadingCanvas(),
  buildCutCanvas(),
  buildArchitectureCanvas(),
  buildTokyoCanvas()
]
