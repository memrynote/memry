import { diffArrays, diffWordsWithSpace } from 'diff'

import { restoreBlockNesting } from '@memry/shared/block-nesting'

/**
 * Style values that only exist inside the review surface. They ride BlockNote's
 * own `backgroundColor` style so the diff renders through the note editor's
 * real block specs, and the CSS in `agent-diff-body.css` maps them to the
 * `--diff-*` tokens. The document they sit in is never serialized.
 */
export const DIFF_ADD_STYLE = 'memry-diff-add'
export const DIFF_DEL_STYLE = 'memry-diff-del'

/** Block id prefixes the stylesheet keys the change bar on. */
export const DIFF_BLOCK_ID_PREFIX = {
  context: 'diff-ctx-',
  added: 'diff-add-',
  removed: 'diff-del-',
  modified: 'diff-mod-'
} as const

export interface DiffableBlock {
  id: string
  type: string
  props: Record<string, unknown>
  content?: unknown
  children: DiffableBlock[]
}

export interface BlockDiffResult<T extends DiffableBlock> {
  blocks: T[]
  /** Runs of consecutive changed blocks, the count the review bar shows. */
  changeCount: number
}

interface FlatBlock {
  block: DiffableBlock
  depth: number
  signature: string
}

type Marker = 'add' | 'del'

/**
 * One document that shows both versions: untouched blocks once, removed blocks
 * struck through, added blocks highlighted, and a block edited in place diffed
 * word by word.
 *
 * Blocks are compared on a pre-order walk with their depth, not as a tree: a
 * changed child should mark that child, not its whole parent. The merged walk
 * is folded back into a tree with the same helper the markdown loader uses.
 */
export function buildBlockDiff<T extends DiffableBlock>(
  current: readonly T[],
  candidate: readonly T[]
): BlockDiffResult<T> {
  const before = flatten(current)
  const after = flatten(candidate)
  const changes = diffArrays(before, after, {
    comparator: (left, right) => left.signature === right.signature
  })

  const merged: { block: DiffableBlock; depth: number }[] = []
  let changeCount = 0
  let counter = 0
  const nextId = (prefix: string): string => `${prefix}${counter++}`

  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index]

    if (!change.added && !change.removed) {
      for (const item of change.value) {
        merged.push({
          block: { ...item.block, id: nextId(DIFF_BLOCK_ID_PREFIX.context) },
          depth: item.depth
        })
      }
      continue
    }

    changeCount += 1
    // A replacement arrives as removed-then-added. Pairing the two runs is what
    // lets an edited paragraph read as one paragraph with a changed word
    // instead of a struck-out copy followed by a new one.
    const next = changes[index + 1]
    const removed = change.removed ? change.value : []
    const added = change.removed && next?.added ? next.value : change.added ? change.value : []
    if (change.removed && next?.added) index += 1

    for (let slot = 0; slot < Math.max(removed.length, added.length); slot += 1) {
      const oldItem = removed[slot]
      const newItem = added[slot]

      if (oldItem && newItem && canDiffInline(oldItem.block, newItem.block)) {
        merged.push({
          block: {
            ...newItem.block,
            id: nextId(DIFF_BLOCK_ID_PREFIX.modified),
            content: diffInlineContent(
              oldItem.block.content as unknown[],
              newItem.block.content as unknown[]
            )
          },
          depth: newItem.depth
        })
        continue
      }

      if (oldItem) {
        merged.push({
          block: {
            ...oldItem.block,
            id: nextId(DIFF_BLOCK_ID_PREFIX.removed),
            content: markContent(oldItem.block.content, 'del')
          },
          depth: oldItem.depth
        })
      }
      if (newItem) {
        merged.push({
          block: {
            ...newItem.block,
            id: nextId(DIFF_BLOCK_ID_PREFIX.added),
            content: markContent(newItem.block.content, 'add')
          },
          depth: newItem.depth
        })
      }
    }
  }

  const blocks = restoreBlockNesting(
    merged.map((entry) => entry.block),
    merged.map((entry) => entry.depth)
  )
  return { blocks: blocks as T[], changeCount }
}

function flatten(blocks: readonly DiffableBlock[], depth = 0, out: FlatBlock[] = []): FlatBlock[] {
  for (const block of blocks) {
    const shallow: DiffableBlock = { ...block, children: [] }
    out.push({
      block: shallow,
      depth,
      // Ids are minted per parse, so they are left out: the same line parsed
      // twice has to compare equal.
      signature: JSON.stringify([depth, block.type, block.props, block.content ?? null])
    })
    flatten(block.children ?? [], depth + 1, out)
  }
  return out
}

function canDiffInline(oldBlock: DiffableBlock, newBlock: DiffableBlock): boolean {
  return (
    oldBlock.type === newBlock.type &&
    Array.isArray(oldBlock.content) &&
    Array.isArray(newBlock.content)
  )
}

interface StyledText {
  type: 'text'
  text: string
  styles: Record<string, unknown>
}

interface LinkContent {
  type: 'link'
  href: string
  content: StyledText[]
}

function isStyledText(item: unknown): item is StyledText {
  return (
    Boolean(item) &&
    typeof item === 'object' &&
    (item as { type?: unknown }).type === 'text' &&
    typeof (item as { text?: unknown }).text === 'string'
  )
}

function isLink(item: unknown): item is LinkContent {
  return (
    Boolean(item) &&
    typeof item === 'object' &&
    (item as { type?: unknown }).type === 'link' &&
    Array.isArray((item as { content?: unknown }).content)
  )
}

function markStyles(styles: Record<string, unknown>, marker: Marker): Record<string, unknown> {
  return marker === 'add'
    ? { ...styles, backgroundColor: DIFF_ADD_STYLE }
    : { ...styles, backgroundColor: DIFF_DEL_STYLE, strike: true }
}

function markItem(item: unknown, marker: Marker): unknown {
  if (isStyledText(item)) return { ...item, styles: markStyles(item.styles ?? {}, marker) }
  if (isLink(item)) {
    return { ...item, content: item.content.map((inner) => markItem(inner, marker)) }
  }
  // Wiki links, tags and date pills carry no text styles. The block's change
  // bar still marks them.
  return item
}

function markContent(content: unknown, marker: Marker): unknown {
  return Array.isArray(content) ? content.map((item) => markItem(item, marker)) : content
}

type Unit =
  { kind: 'char'; char: string; styles: Record<string, unknown> } | { kind: 'item'; item: unknown }

/**
 * Text runs become one unit per UTF-16 code unit so offsets line up with the
 * strings `diffWordsWithSpace` sees. Anything that is not plain text (a link, a
 * wiki link, a tag) becomes one private-use character, shared between both
 * sides when the item is identical, so an untouched link compares equal.
 */
function encode(content: unknown[], codes: Map<string, string>): { text: string; units: Unit[] } {
  let text = ''
  const units: Unit[] = []

  for (const item of content) {
    if (isStyledText(item)) {
      for (const char of item.text.split('')) {
        text += char
        units.push({ kind: 'char', char, styles: item.styles ?? {} })
      }
      continue
    }

    const key = JSON.stringify(item)
    let code = codes.get(key)
    if (!code) {
      code = String.fromCharCode(0xe000 + (codes.size % 0x1900))
      codes.set(key, code)
    }
    text += code
    units.push({ kind: 'item', item })
  }

  return { text, units }
}

function diffInlineContent(oldContent: unknown[], newContent: unknown[]): unknown[] {
  const codes = new Map<string, string>()
  const before = encode(oldContent, codes)
  const after = encode(newContent, codes)

  const marked: { unit: Unit; marker: Marker | null }[] = []
  let atOld = 0
  let atNew = 0

  for (const part of diffWordsWithSpace(before.text, after.text)) {
    const length = part.value.length
    if (part.removed) {
      for (const unit of before.units.slice(atOld, atOld + length)) {
        marked.push({ unit, marker: 'del' })
      }
      atOld += length
      continue
    }
    if (part.added) {
      for (const unit of after.units.slice(atNew, atNew + length)) {
        marked.push({ unit, marker: 'add' })
      }
      atNew += length
      continue
    }
    for (const unit of after.units.slice(atNew, atNew + length)) {
      marked.push({ unit, marker: null })
    }
    atOld += length
    atNew += length
  }

  return rebuild(marked)
}

function rebuild(marked: { unit: Unit; marker: Marker | null }[]): unknown[] {
  const out: unknown[] = []
  let run: { text: string; styles: Record<string, unknown>; key: string } | null = null

  const flush = (): void => {
    if (run) out.push({ type: 'text', text: run.text, styles: run.styles })
    run = null
  }

  for (const { unit, marker } of marked) {
    if (unit.kind === 'item') {
      flush()
      out.push(marker ? markItem(unit.item, marker) : unit.item)
      continue
    }
    const styles = marker ? markStyles(unit.styles, marker) : unit.styles
    const key = JSON.stringify(styles)
    if (run && run.key === key) {
      run.text += unit.char
      continue
    }
    flush()
    run = { text: unit.char, styles, key }
  }
  flush()

  return out
}
