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
  return chunks
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
  return text.replace(/^\n+/, '').replace(/\n+$/, '')
}
