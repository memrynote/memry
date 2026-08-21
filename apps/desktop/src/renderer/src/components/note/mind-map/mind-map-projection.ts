/**
 * Private step 1 — an editor block tree becomes a logical mind-map tree.
 *
 * Not exported outside this directory: `buildMindMap` is the only seam, so this
 * file is free to change shape as later tickets add lists, tasks and links.
 *
 * Headings are the one hierarchy mechanism handled here, and they are flat
 * siblings in the block tree whose nesting lives in a `level` prop — so this is
 * a level stack, not a recursive descent. (Recursive descent is still needed to
 * *find* headings, because a heading can sit inside a toggle or a callout.)
 */

import type { MindMapNode, MindMapSourceBlock } from './mind-map-types'

export const MIND_MAP_ROOT_ID = 'mm-root'

const MIN_HEADING_LEVEL = 1
const MAX_HEADING_LEVEL = 6

/**
 * Content-less inline specs (wiki links, hash tags, date mentions) carry their
 * visible text in props. Read in this order, first non-empty wins.
 *
 * An interim rule: these kinds get their own treatment when links, tags and
 * dates become nodes and badges of their own.
 */
const INLINE_LABEL_PROPS = ['alias', 'target', 'tag', 'dateISO'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Total: any inline shape in, a plain string out. */
function inlineText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(inlineText).join('')
  if (!isRecord(value)) return ''

  if (typeof value.text === 'string') return value.text
  if (value.content !== undefined) return inlineText(value.content)

  const props = value.props
  if (isRecord(props)) {
    for (const key of INLINE_LABEL_PROPS) {
      const candidate = props[key]
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
    }
  }
  return ''
}

/** Collapses runs of whitespace so a wrapped heading measures predictably. */
function normalizeLabel(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()
}

function headingLevel(block: MindMapSourceBlock): number | null {
  if (block.type !== 'heading') return null
  const props = block.props
  const raw = isRecord(props) ? props.level : undefined
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return MIN_HEADING_LEVEL
  if (raw < MIN_HEADING_LEVEL) return MIN_HEADING_LEVEL
  if (raw > MAX_HEADING_LEVEL) return MAX_HEADING_LEVEL
  return raw
}

/**
 * Turns a block tree into the logical map.
 *
 * Rules that matter, all of them observable through `buildMindMap`:
 * - The root is always the note title, never the first heading.
 * - A skipped level mints no phantom intermediate node; the heading simply
 *   nests one step deeper than its nearest shallower ancestor.
 * - A note whose first heading is a deep level attaches it straight to the
 *   root: relative depth is what matters, not the absolute number.
 * - Anything that is not a heading — including everything before the first
 *   heading — contributes no node, and never re-parents the headings around it.
 * - A blank heading has nothing to show, so it draws no box and does not join
 *   the level stack; its sub-headings fold up to the nearest labelled ancestor
 *   rather than disappearing.
 */
export function projectBlocks(
  blocks: readonly MindMapSourceBlock[],
  rootLabel: string
): MindMapNode {
  const root: MindMapNode = {
    id: MIND_MAP_ROOT_ID,
    blockId: null,
    label: rootLabel,
    kind: 'root',
    level: null,
    depth: 0,
    children: []
  }

  /** Open headings, shallowest first. The root is the implicit floor. */
  const stack: Array<{ level: number; node: MindMapNode }> = []
  /**
   * Block ids should be unique, but a node id collision would mint two drawing
   * elements with one id, so the suffix keeps them apart deterministically.
   */
  const usedIds = new Map<string, number>()

  const mintId = (blockId: string): string => {
    const base = `mm-${blockId}`
    const seen = usedIds.get(base) ?? 0
    usedIds.set(base, seen + 1)
    return seen === 0 ? base : `${base}-${seen + 1}`
  }

  const visit = (block: MindMapSourceBlock): void => {
    const level = headingLevel(block)
    if (level !== null) {
      const label = normalizeLabel(inlineText(block.content))
      if (label !== '') {
        while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop()
        const parent = stack.length > 0 ? stack[stack.length - 1].node : root
        const node: MindMapNode = {
          id: mintId(block.id),
          blockId: block.id,
          label,
          kind: 'heading',
          level,
          depth: parent.depth + 1,
          children: []
        }
        parent.children.push(node)
        stack.push({ level, node })
      }
    }

    for (const child of block.children ?? []) visit(child)
  }

  for (const block of blocks) visit(block)
  return root
}
