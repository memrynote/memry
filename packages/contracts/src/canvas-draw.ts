/**
 * Agent-authored canvas drawing.
 *
 * The canvas MCP surface shipped able to place entity CARDS and nothing else
 * (see docs/superpowers/specs/2026-08-03-mcp-canvas-coverage-design.md §8): an
 * agent could put a note on a canvas but could not draw a box around it, label
 * it, or point an arrow at it. This module is the wire contract for the rest of
 * Excalidraw — shapes, text, arrows with real bindings, lines, freedraw,
 * frames, images and embeds.
 *
 * Field names are Excalidraw's own (camelCase, `strokeColor` not
 * `stroke_color`). That is deliberate: every model that has seen Excalidraw's
 * programmatic API already knows this vocabulary, and a memry-specific
 * renaming would only be a layer to get wrong. The snake_case convention still
 * applies to the TOOL arguments wrapping these (`canvas_id`, `elements`).
 *
 * What is NOT here, and must not be added:
 *  - `customData` — a card is a rectangle carrying
 *    `customData: { entityType, entityId }`, and `canvas_entity_refs` is
 *    rewritten from exactly that on every save. Letting an agent set it would
 *    mint a card for an entity nobody validated, or for one that does not
 *    exist. Cards go through vault_add_canvas_item, which checks.
 *  - `id` as a real element id — `id` here is a batch-local ref used to wire
 *    arrows and frames within one call. Real ids are minted by the renderer.
 *
 * @module contracts/canvas-draw
 */

import { z } from 'zod'

/** Element types an agent may author. */
export const CANVAS_DRAW_ELEMENT_TYPES = [
  'rectangle',
  'ellipse',
  'diamond',
  'text',
  'arrow',
  'line',
  'freedraw',
  'frame',
  'image',
  'embeddable'
] as const
export type CanvasDrawElementType = (typeof CANVAS_DRAW_ELEMENT_TYPES)[number]

/** Most elements one draw call may add. */
export const MAX_DRAW_ELEMENTS = 300
/** Most elements one edit call may touch. */
export const MAX_EDIT_ELEMENTS = 300
/**
 * Ceiling on a scene an agent write may produce. A canvas this big is already
 * past the point where the editor is pleasant; the cap exists so a looping
 * agent cannot grow one until it stops opening.
 */
export const MAX_SCENE_ELEMENTS = 5000

/**
 * Excalidraw accepts any CSS color, but an agent has no reason to need one
 * outside hex — and a permissive string is a place for junk to enter a scene
 * that then fails to render.
 */
const ColorSchema = z
  .string()
  .regex(/^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|transparent)$/)

/**
 * Element hyperlink. http/https only: an element link is a thing the user
 * clicks, and `file:`/`javascript:`/custom schemes reaching the shell from
 * agent-authored content is not a door worth opening for a drawing feature.
 */
const LinkSchema = z
  .string()
  .max(2048)
  .refine((value) => /^https?:\/\//i.test(value), {
    message: 'link must be an http(s) URL'
  })

const FillStyleSchema = z.enum(['hachure', 'cross-hatch', 'solid', 'zigzag'])
const StrokeStyleSchema = z.enum(['solid', 'dashed', 'dotted'])
const TextAlignSchema = z.enum(['left', 'center', 'right'])
const VerticalAlignSchema = z.enum(['top', 'middle', 'bottom'])

/**
 * Named rather than numeric so a font-registry change upstream is a mapping
 * fix in one renderer constant instead of a silently wrong number in every
 * agent's prompt.
 */
export const CanvasFontFamilySchema = z.enum(['hand-drawn', 'normal', 'code', 'lilita'])
export type CanvasFontFamily = z.infer<typeof CanvasFontFamilySchema>

export const CanvasArrowheadSchema = z.enum([
  'none',
  'arrow',
  'bar',
  'dot',
  'triangle',
  'triangle_outline',
  'diamond',
  'diamond_outline',
  'circle',
  'circle_outline',
  'crowfoot_one',
  'crowfoot_many',
  'crowfoot_one_or_many'
])

/**
 * One end of an arrow. `ref` points at another element in the same call;
 * `elementId` at one already on the canvas (read them with
 * vault_read_canvas_elements). Either one makes a real Excalidraw binding —
 * the arrow follows the shape when the user drags it, which is the whole
 * difference between a diagram and two objects that happen to touch.
 */
const ArrowEndpointSchema = z
  .object({
    ref: z.string().min(1).max(64).optional(),
    elementId: z.string().min(1).max(128).optional()
  })
  .refine((value) => Boolean(value.ref) !== Boolean(value.elementId), {
    message: 'exactly one of ref or elementId is required'
  })
export type CanvasArrowEndpoint = z.infer<typeof ArrowEndpointSchema>

const LabelSchema = z.object({
  text: z.string().min(1).max(2000),
  fontSize: z.number().positive().max(200).optional(),
  fontFamily: CanvasFontFamilySchema.optional(),
  textAlign: TextAlignSchema.optional(),
  verticalAlign: VerticalAlignSchema.optional(),
  strokeColor: ColorSchema.optional()
})

const PointSchema = z.tuple([z.number(), z.number()])

const styleFields = {
  strokeColor: ColorSchema.optional(),
  backgroundColor: ColorSchema.optional(),
  fillStyle: FillStyleSchema.optional(),
  strokeWidth: z.number().positive().max(20).optional(),
  strokeStyle: StrokeStyleSchema.optional(),
  roughness: z.number().min(0).max(2).optional(),
  opacity: z.number().min(0).max(100).optional(),
  /** 'round' is Excalidraw's adaptive radius; 'sharp' removes the roundness. */
  roundness: z.enum(['sharp', 'round']).optional(),
  angle: z.number().optional(),
  locked: z.boolean().optional(),
  link: LinkSchema.nullish()
}

export const CanvasDrawElementSchema = z.object({
  /**
   * Batch-local ref, NOT the resulting element id. Wire arrows and frame
   * children with it; the response maps each ref to the real id that was
   * minted, so a follow-up call can bind to it.
   */
  ref: z.string().min(1).max(64).optional(),
  type: z.enum(CANVAS_DRAW_ELEMENT_TYPES),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().min(0).max(100_000).optional(),
  height: z.number().min(0).max(100_000).optional(),
  ...styleFields,
  /** type 'text' only. */
  text: z.string().max(20_000).optional(),
  fontSize: z.number().positive().max(200).optional(),
  fontFamily: CanvasFontFamilySchema.optional(),
  textAlign: TextAlignSchema.optional(),
  verticalAlign: VerticalAlignSchema.optional(),
  /** Bound text for a shape or an arrow — the label rides along when it moves. */
  label: LabelSchema.optional(),
  /** type 'arrow' / 'line' only. */
  start: ArrowEndpointSchema.optional(),
  end: ArrowEndpointSchema.optional(),
  startArrowhead: CanvasArrowheadSchema.optional(),
  endArrowhead: CanvasArrowheadSchema.optional(),
  /** Relative to the element origin; first point is normally [0, 0]. */
  points: z.array(PointSchema).min(2).max(500).optional(),
  /** type 'freedraw' only, one per point. */
  pressures: z.array(z.number().min(0).max(1)).max(500).optional(),
  /** type 'frame' only: refs (this call) or element ids (already on canvas). */
  children: z.array(z.string().min(1).max(128)).max(200).optional(),
  /** type 'frame' only. */
  name: z.string().max(200).optional(),
  /** type 'image' only — a fileId already attached to this canvas. */
  fileId: z.string().min(1).max(128).optional(),
  /** type 'embeddable' only. */
  url: LinkSchema.optional()
})
export type CanvasDrawElement = z.infer<typeof CanvasDrawElementSchema>

/**
 * A patch against one element already on the canvas. Absent fields are left
 * alone; `delete: true` removes the element and repairs anything bound to it.
 */
export const CanvasElementEditSchema = z.object({
  elementId: z.string().min(1).max(128),
  delete: z.boolean().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().min(0).max(100_000).optional(),
  height: z.number().min(0).max(100_000).optional(),
  ...styleFields,
  text: z.string().max(20_000).optional(),
  fontSize: z.number().positive().max(200).optional(),
  fontFamily: CanvasFontFamilySchema.optional(),
  textAlign: TextAlignSchema.optional(),
  verticalAlign: VerticalAlignSchema.optional(),
  startArrowhead: CanvasArrowheadSchema.optional(),
  endArrowhead: CanvasArrowheadSchema.optional(),
  name: z.string().max(200).optional()
})
export type CanvasElementEdit = z.infer<typeof CanvasElementEditSchema>

/**
 * One element as an agent reads it back: enough to reason about layout and to
 * bind to, and nothing of the seed/version/index bookkeeping that makes a raw
 * scene unreadable.
 */
export interface CanvasElementView {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  angle?: number
  text?: string
  /** Text bound INSIDE this element (a shape or arrow label). */
  label?: string
  strokeColor?: string
  backgroundColor?: string
  link?: string
  /** Set when this element is a card for a note/task/event. */
  entityType?: string
  entityId?: string
  /** Arrow bindings, by element id. */
  startElementId?: string
  endElementId?: string
  /** The frame this element belongs to. */
  frameId?: string
  /** The element this text is bound to. */
  containerId?: string
  name?: string
}
