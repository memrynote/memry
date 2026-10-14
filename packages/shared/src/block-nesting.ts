export interface BlockWithChildren<T> {
  children?: T[]
}

export interface MarkdownBlockNestingChunk {
  level: number
  text: string
}

const BLOCK_NESTING_MARKER_REGEX = /^<!--\s*memry:block-nesting-level=(\d+)\s*-->$/

export function createBlockNestingMarker(level: number): string {
  return `<!-- memry:block-nesting-level=${normalizeNestingLevel(level)} -->`
}

export function splitMarkdownByBlockNestingMarkers(markdown: string): MarkdownBlockNestingChunk[] {
  const chunks: MarkdownBlockNestingChunk[] = []
  const lines = markdown.split('\n')
  let currentLevel = 0
  let buffer: string[] = []
  let inCodeFence = false
  let openFence = ''

  const flush = (): void => {
    const text = trimEdgeNewlines(buffer.join('\n'))
    if (text.trim()) chunks.push({ level: currentLevel, text })
    buffer = []
  }
  const lastLevel = (): number => chunks[chunks.length - 1]?.level ?? 0

  for (const line of lines) {
    const fenceMatch = line.match(/^( {0,3})(```|~~~)/)
    if (fenceMatch) {
      buffer.push(line)
      const fence = fenceMatch[2]
      if (!inCodeFence) {
        inCodeFence = true
        openFence = fence
      } else if (fence === openFence) {
        inCodeFence = false
        openFence = ''
      }
      continue
    }

    const markerMatch = inCodeFence ? null : line.match(BLOCK_NESTING_MARKER_REGEX)
    if (markerMatch) {
      flush()
      currentLevel = normalizeNestingLevel(Number(markerMatch[1]))
      continue
    }

    buffer.push(line)
  }

  flush()
  // A marker with no text after it still moves the level for whatever the
  // caller parses next (the `=0` that closes a nested run before a callout,
  // say), so it comes back as an empty chunk.
  if (currentLevel !== lastLevel()) chunks.push({ level: currentLevel, text: '' })
  return chunks
}

/**
 * Stand-ins for nesting markers in a flat block list. A list item's nested
 * child is often claimed by a different parser than its parent (a callout, a
 * task, a file marker), so the level has to outlive the chunk it was read in;
 * `foldBlockNestingMarkers` applies it once the whole run is parsed (#2365).
 */
const nestingMarkerLevels = new WeakMap<object, number>()

/**
 * `markdown` parsed chunk by chunk, with a level marker block before each
 * chunk. Pass the result through `foldBlockNestingMarkers` before use.
 */
export async function parseMarkdownWithNestingMarkers<T extends object>(
  markdown: string,
  parse: (markdown: string) => Promise<T[]>
): Promise<T[]> {
  const blocks: T[] = []
  for (const chunk of splitMarkdownByBlockNestingMarkers(markdown)) {
    const marker = {} as T
    nestingMarkerLevels.set(marker, chunk.level)
    blocks.push(marker)
    if (chunk.text) blocks.push(...(await parse(chunk.text)))
  }
  return blocks
}

export function isBlockNestingMarker(block: object): boolean {
  return nestingMarkerLevels.has(block)
}

/** The blocks with every level marker removed and its level applied. */
export function foldBlockNestingMarkers<T extends BlockWithChildren<T>>(blocks: readonly T[]): T[] {
  if (!blocks.some(isBlockNestingMarker)) return [...blocks]
  const content: T[] = []
  const levels: number[] = []
  let level = 0
  for (const block of blocks) {
    const markerLevel = nestingMarkerLevels.get(block)
    if (markerLevel === undefined) {
      content.push(block)
      levels.push(level)
    } else {
      level = markerLevel
    }
  }
  return levels.some((l) => l > 0) ? restoreBlockNesting(content, levels) : content
}

export function restoreBlockNesting<T extends BlockWithChildren<T>>(
  blocks: readonly T[],
  levels: readonly number[]
): T[] {
  const roots: T[] = []
  const stack: T[] = []

  blocks.forEach((block, index) => {
    const level = normalizeNestingLevel(levels[index] ?? 0)
    const nextBlock = {
      ...block,
      children: Array.isArray(block.children) ? [...block.children] : []
    } as T

    if (level === 0 || !stack[level - 1]) {
      roots.push(nextBlock)
      stack[0] = nextBlock
      stack.length = 1
      return
    }

    const parent = stack[level - 1]
    parent.children = [...(parent.children ?? []), nextBlock]
    stack[level] = nextBlock
    stack.length = level + 1
  })

  return roots
}

function normalizeNestingLevel(level: number): number {
  return Number.isInteger(level) && level > 0 ? level : 0
}

function trimEdgeNewlines(text: string): string {
  let start = 0
  let end = text.length

  while (start < end && text.charCodeAt(start) === 10) start += 1
  while (end > start && text.charCodeAt(end - 1) === 10) end -= 1

  return text.slice(start, end)
}
