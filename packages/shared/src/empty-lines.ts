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

/**
 * A standalone image line (`![alt](url)` alone on its line) must be a block-level
 * element for BlockNote to create an image block. When it sits directly under a
 * text line with no blank line between, CommonMark folds it into the preceding
 * paragraph as an *inline* image — and BlockNote has no inline-image node, so the
 * image is silently dropped on parse. Imported notes (Apple Notes, Bear, …) emit
 * images glued to the previous line this way. Insert a blank line before/after
 * each such line so it parses as its own image block. Code fences are left as-is.
 */
const STANDALONE_IMAGE_LINE = /^\s*!\[[^\]]*\]\([^)]+\)\s*$/

export function separateBlockImages(markdown: string): string {
  if (!markdown.includes('![')) return markdown

  const regions = splitByCodeFences(markdown)
  let out = ''

  for (const region of regions) {
    if (region.isCode) {
      out += region.text
      continue
    }

    const lines = region.text.split('\n')
    const result: string[] = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (STANDALONE_IMAGE_LINE.test(line)) {
        if (result.length > 0 && result[result.length - 1].trim() !== '') result.push('')
        result.push(line)
        if (i + 1 < lines.length && lines[i + 1].trim() !== '') result.push('')
        continue
      }
      result.push(line)
    }
    out += result.join('\n')
  }

  return out
}

/**
 * Obsidian embeds an image as `![[photo.png]]`, optionally with a display size
 * or alias after a pipe (`![[photo.png|300x200]]`). The target stops at `|`;
 * `[`/`]`/`#` are excluded so a run cannot overrun the closing `]]`, and so a
 * heading transclusion (`![[Some Note#Heading]]`) never matches — that is a
 * note embed, not an image.
 *
 * The leading `!` is required: a bare `[[Note]]` is a link between notes and
 * keeps its `wikiLink` atom.
 */
const WIKI_IMAGE_EMBED_RE = /!\[\[([^\][|#]+)(?:\|([^\][]*))?\]\]/g

/**
 * Only real image extensions are treated as embedded images. `![[Some Note]]`
 * and `![[report.pdf]]` are transclusions of other things and keep whatever
 * handling they have today.
 */
const IMAGE_EMBED_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i

function eachWikiImageEmbed(
  markdown: string,
  visit: (match: RegExpExecArray, ref: string) => void
): void {
  for (const region of splitByCodeFences(markdown)) {
    if (region.isCode) continue
    WIKI_IMAGE_EMBED_RE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = WIKI_IMAGE_EMBED_RE.exec(region.text)) !== null) {
      const ref = match[1].trim()
      if (!ref || !IMAGE_EMBED_EXT_RE.test(ref)) continue
      visit(match, ref)
    }
  }
}

/**
 * Every distinct image target embedded with Obsidian syntax, in first-seen
 * order. Callers resolve these to `memry-file://` URLs and hand the results
 * back to `rewriteWikiImageEmbeds`.
 */
export function extractWikiImageEmbedRefs(markdown: string): string[] {
  if (!markdown.includes('![[')) return []
  const seen = new Set<string>()
  eachWikiImageEmbed(markdown, (_match, ref) => seen.add(ref))
  return Array.from(seen)
}

/**
 * Rewrite `![[photo.png]]` into the CommonMark `![photo.png](url)` form that
 * BlockNote parses into an image block. Without this the `[[…]]` half becomes a
 * wikiLink atom and the `!` is left behind as literal text, so the image never
 * renders.
 *
 * `resolve` maps the embed target to a URL the renderer can actually load —
 * image blocks only resolve absolute `memry-file://` URLs, so an embed whose
 * target is not found is left exactly as it was rather than rewritten into a
 * broken image. The display size (`|300x200`) is dropped: markdown cannot carry
 * it and BlockNote takes its width from the block's `previewWidth` prop.
 */
export function rewriteWikiImageEmbeds(
  markdown: string,
  resolve: (ref: string) => string | undefined
): string {
  if (!markdown.includes('![[')) return markdown

  const regions = splitByCodeFences(markdown)
  let out = ''

  for (const region of regions) {
    if (region.isCode) {
      out += region.text
      continue
    }
    WIKI_IMAGE_EMBED_RE.lastIndex = 0
    out += region.text.replace(WIKI_IMAGE_EMBED_RE, (whole, rawRef: string) => {
      const ref = rawRef.trim()
      if (!ref || !IMAGE_EMBED_EXT_RE.test(ref)) return whole
      const url = resolve(ref)
      if (!url) return whole
      // Strip brackets from the alt text so the filename cannot break `![](…)`.
      const alt = (ref.split('/').pop() ?? ref).replace(/[[\]]/g, '')
      return `![${alt}](${url})`
    })
  }

  return out
}

const LIST_ITEM_LINE = /^[ \t]*(?:[-*+]|\d+[.)])\s/

/**
 * Normalize BlockNote's markdown serializer output to the CommonMark/Obsidian
 * style vault files actually use. BlockNote serializes via remark-stringify,
 * whose defaults diverge from a hand-authored vault file:
 *
 * - `*` bullets            → `-`
 * - blank line per item    → tight list (dropped only between two list items)
 * - `\` hard line breaks   → plain `\n` soft breaks
 *
 * Without this, editing one line of a note rewrites every unrelated list line
 * and sprays blank lines / backslashes through the file. Code fences are left
 * byte-for-byte untouched (a `* ` or trailing `\` inside code is real content).
 */
export function normalizeSerializedMarkdown(markdown: string): string {
  if (!markdown) return markdown

  const regions = splitByCodeFences(markdown)
  let out = ''
  for (const region of regions) {
    out += region.isCode ? region.text : normalizeProseMarkdown(region.text)
  }
  return out
}

function normalizeProseMarkdown(text: string): string {
  // Backslash hard break (remark's default) → soft newline, so typed/imported
  // single-newline lines round-trip clean instead of gaining `\`.
  const lines = text.replace(/\\\n/g, '\n').split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') {
      const prev = out[out.length - 1]
      const next = lines[i + 1]
      // Drop a blank line only between two list items (loose→tight), never a
      // real paragraph gap.
      if (
        prev !== undefined &&
        next !== undefined &&
        LIST_ITEM_LINE.test(prev) &&
        LIST_ITEM_LINE.test(next)
      ) {
        continue
      }
    }
    // `*`/`+` bullet marker → `-` (needs the trailing space, so `*emphasis*` and
    // `***` thematic breaks are untouched).
    out.push(line.replace(/^([ \t]*)[*+](\s)/, '$1-$2'))
  }
  return out.join('\n')
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
