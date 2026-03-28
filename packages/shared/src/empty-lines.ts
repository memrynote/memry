export type MarkdownSegment =
  | { type: 'content'; text: string }
  | { type: 'gap'; extraLines: number }

/**
 * Split markdown into content segments and gap descriptors.
 *
 * Runs of 3+ consecutive newlines (outside code fences) are extracted as
 * `gap` segments whose `extraLines` value equals the number of blank lines
 * beyond the standard 1-blank-line paragraph break.
 *
 * Standard paragraph breaks (\n\n) are left inside content segments for
 * BlockNote's parser to handle normally.
 */
export function splitMarkdownPreservingBlanks(markdown: string): MarkdownSegment[] {
  if (!markdown || !markdown.trim()) return []

  const regions = splitByCodeFences(markdown)
  let assembled = ''

  for (const region of regions) {
    if (region.isCode) {
      assembled += region.text
    } else {
      assembled += region.text.replace(/\n{3,}/g, (match) => {
        const nl = match.length
        return `\n\n\x00GAP:${nl - 2}\x00\n\n`
      })
    }
  }

  const parts = assembled.split(/\x00GAP:(\d+)\x00/)
  const segments: MarkdownSegment[] = []

  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      const text = trimEdgeNewlines(parts[i])
      if (text) {
        segments.push({ type: 'content', text })
      }
    } else {
      segments.push({ type: 'gap', extraLines: parseInt(parts[i], 10) })
    }
  }

  return segments
}

/**
 * Assemble markdown segments back into a single string.
 *
 * Content segments are joined by `\n\n` (standard paragraph break) plus
 * N extra `\n` characters for each gap between them.
 *
 * Round-trip guarantee: `assemble(split(md)) === md` for all well-formed
 * markdown where extra blank lines only appear outside code fences.
 */
export function assembleMarkdownWithBlanks(segments: MarkdownSegment[]): string {
  if (segments.length === 0) return ''

  let result = ''
  let prevWasContent = false

  for (const seg of segments) {
    if (seg.type === 'content') {
      if (prevWasContent) {
        result += '\n\n'
      }
      result += seg.text
      prevWasContent = true
    } else {
      if (prevWasContent) {
        result += '\n\n' + '\n'.repeat(seg.extraLines)
      } else {
        result += '\n\n' + '\n'.repeat(seg.extraLines)
      }
      prevWasContent = false
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface TextRegion {
  text: string
  isCode: boolean
}

function splitByCodeFences(markdown: string): TextRegion[] {
  const regions: TextRegion[] = []
  const fenceRegex = /^( {0,3})(```|~~~)/gm
  let inCode = false
  let openFence = ''
  let lastIndex = 0

  let match: RegExpExecArray | null
  while ((match = fenceRegex.exec(markdown)) !== null) {
    const fence = match[2]

    if (!inCode) {
      if (match.index > lastIndex) {
        regions.push({ text: markdown.slice(lastIndex, match.index), isCode: false })
      }
      inCode = true
      openFence = fence
      lastIndex = match.index
    } else if (fence === openFence) {
      const lineEnd = markdown.indexOf('\n', match.index)
      const fenceEnd = lineEnd === -1 ? markdown.length : lineEnd
      regions.push({ text: markdown.slice(lastIndex, fenceEnd), isCode: true })
      const endPos = fenceEnd
      inCode = false
      openFence = ''
      lastIndex = endPos
    }
  }

  if (lastIndex < markdown.length) {
    regions.push({ text: markdown.slice(lastIndex), isCode: inCode })
  }

  return regions
}

function trimEdgeNewlines(text: string): string {
  return text.replace(/^\n+/, '').replace(/\n+$/, '')
}
