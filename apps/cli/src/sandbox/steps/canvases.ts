// Canvases have no CLI service. Desktop owns them as files: on every vault open,
// reconcileCanvasFiles (apps/desktop/src/main/canvas/reconcile.ts) adopts each
// canvases/**/*.excalidraw without a row, keeps the id from its `memry` sidecar,
// indexes its cards and arrows, and leaves clock NULL so the first sync pushes it.
// Writing the file is therefore the whole creation path.
import fs from 'node:fs/promises'
import path from 'node:path'

import { canvasSpecs, type CanvasCard, type CanvasSpec } from '../content/canvases.ts'
import { canvasId, need, type SandboxContext, type SandboxStep } from '../context.ts'

type Element = Record<string, unknown>

const CARD = { w: 260, h: 168 }
const FILE_CARD = { w: 260, h: 240 }

function base(
  id: string,
  type: string,
  x: number,
  y: number,
  w: number,
  h: number,
  seed: number
): Element {
  return {
    id,
    type,
    x,
    y,
    width: w,
    height: h,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed,
    version: 1,
    versionNonce: seed,
    isDeleted: false,
    boundElements: [],
    updated: 0,
    link: null,
    locked: false
  }
}

function text(
  id: string,
  value: string,
  x: number,
  y: number,
  size: number,
  seed: number,
  containerId: string | null = null
): Element {
  const lines = value.split('\n')
  return {
    ...base(
      id,
      'text',
      x,
      y,
      Math.max(...lines.map((line) => line.length)) * size * 0.55,
      lines.length * size * 1.25,
      seed
    ),
    text: value,
    originalText: value,
    fontSize: size,
    fontFamily: 5,
    textAlign: containerId ? 'center' : 'left',
    verticalAlign: containerId ? 'middle' : 'top',
    containerId,
    autoResize: true,
    lineHeight: 1.25
  }
}

function entityId(ctx: SandboxContext, card: CanvasCard): string {
  switch (card.entity) {
    case 'note':
      return need(ctx.notes, card.key, 'note').id
    case 'task':
      return need(ctx.tasks, card.key, 'task').id
    case 'calendar_event':
      return need(ctx.events, card.key, 'event')
    case 'project':
      return need(ctx.projects, card.key, 'project').id
    case 'file':
      return need(ctx.files, card.key, 'file').id
  }
}

/** Excalidraw scene with entity cards (canvas-cards.ts makeCardSkeleton style), frames, arrows and links. */
function buildScene(ctx: SandboxContext, spec: CanvasSpec): Element[] {
  let seed = 1
  const next = (): number => seed++
  const cards = new Map<string, Element>()
  const elements: Element[] = [text('heading', spec.heading, 0, -110, 28, next())]

  for (const card of spec.cards) {
    const size = card.entity === 'file' ? FILE_CARD : CARD
    const element: Element = {
      ...base(card.id, 'rectangle', card.x, card.y, size.w, size.h, next()),
      strokeColor: '#ced4da',
      backgroundColor: '#ffffff',
      roundness: { type: 3 },
      frameId: card.frame ?? null,
      customData: { entityType: card.entity, entityId: entityId(ctx, card) }
    }
    cards.set(card.id, element)
  }

  const arrows = spec.arrows.map((arrow) => {
    const from = cards.get(arrow.from)!
    const to = cards.get(arrow.to)!
    const start = {
      x: (from.x as number) + (from.width as number) / 2,
      y: (from.y as number) + (from.height as number) / 2
    }
    const end = {
      x: (to.x as number) + (to.width as number) / 2,
      y: (to.y as number) + (to.height as number) / 2
    }
    // Restore does not add arrows to a card's boundElements; without this the arrow would not follow a dragged card.
    for (const card of [from, to])
      (card.boundElements as Element[]).push({ type: 'arrow', id: arrow.id })
    return {
      ...base(
        arrow.id,
        'arrow',
        start.x,
        start.y,
        Math.abs(end.x - start.x),
        Math.abs(end.y - start.y),
        next()
      ),
      strokeWidth: 2,
      strokeStyle: arrow.dashed ? 'dashed' : 'solid',
      roundness: { type: 2 },
      points: [
        [0, 0],
        [end.x - start.x, end.y - start.y]
      ],
      lastCommittedPoint: null,
      startBinding: { elementId: arrow.from, focus: 0, gap: 4 },
      endBinding: { elementId: arrow.to, focus: 0, gap: 4 },
      startArrowhead: null,
      endArrowhead: 'arrow',
      elbowed: false
    }
  })

  // A frame's children sit directly before it in the element array (canvas-frame-binding.ts placeInFrame).
  for (const frame of spec.frames) {
    elements.push(
      ...spec.cards.filter((card) => card.frame === frame.id).map((card) => cards.get(card.id)!)
    )
    elements.push({
      ...base(frame.id, 'frame', frame.x, frame.y, frame.w, frame.h, next()),
      strokeColor: '#bbb',
      strokeWidth: 2,
      name: frame.name,
      ...(frame.tag ? { customData: { memryBinding: { kind: 'tag', tag: frame.tag } } } : {})
    })
  }
  elements.push(...spec.cards.filter((card) => !card.frame).map((card) => cards.get(card.id)!))

  for (const note of spec.notes) {
    const labelId = `${note.id}-label`
    elements.push({
      ...base(note.id, 'rectangle', note.x, note.y, 300, 90, next()),
      backgroundColor: note.color,
      strokeColor: note.href ? '#1971c2' : '#e67700',
      roughness: 1,
      roundness: { type: 3 },
      link: note.href ?? null,
      boundElements: [{ type: 'text', id: labelId }]
    })
    elements.push(text(labelId, note.text, note.x + 10, note.y + 20, 18, next(), note.id))
  }

  return [...elements, ...arrows]
}

export const writeCanvases: SandboxStep = async (ctx) => {
  const createdAt = ctx.clock.now.getTime()
  for (const spec of canvasSpecs(ctx.clock)) {
    const scene = {
      type: 'excalidraw',
      version: 2,
      source: 'memry',
      memry: { id: canvasId(ctx, spec.key), createdAt, updatedAt: createdAt },
      elements: buildScene(ctx, spec),
      appState: { gridSize: 20, viewBackgroundColor: '#ffffff' },
      files: {}
    }
    const file = path.join(ctx.vaultPath, 'canvases', spec.folder, `${spec.title}.excalidraw`)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, `${JSON.stringify(scene, null, 2)}\n`)
  }
}
