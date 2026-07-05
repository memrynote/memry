// Foreign-syntax raw-segment splitter (docs/obs/06).
//
// Obsidian block constructs that BlockNote/remark cannot represent are split
// out BEFORE parsing and carried as opaque `rawMarkdown` blocks whose text is
// re-emitted verbatim on serialize. Inline foreign syntax (%%…%%, ==…==, $…$,
// [^1], ![[…]], {{…}}, ^blockid, dataview fields) is proven by the
// foreign-syntax round-trip matrix to survive remark untouched, so it stays
// plain text — no masking layer.
//
// ponytail: blank-line runs directly adjacent to a raw segment normalize to a
// single blank line on save (same ceiling the Memry embed/file markers already
// have); interior gaps inside markdown segments keep full fidelity via
// empty-lines.ts.

export type ForeignSegment = { kind: 'markdown'; text: string } | { kind: 'raw'; text: string }

// Keep in sync with CALLOUT_TYPES in
// apps/desktop/src/renderer/src/components/note/content-area/callout-block.tsx
const MEMRY_CALLOUT_TYPES: readonly string[] = ['info', 'warning', 'error', 'success']

const FENCE_LINE = /^ {0,3}(```|~~~)/
const FOOTNOTE_DEF_LINE = /^\[\^[^\]\s]+\]:/
// `- [x] …` GFM states (space/x/X) stay native checkboxes; anything else is an
// Obsidian custom state the schema cannot represent.
const CUSTOM_CHECKBOX_LINE = /^\s*[-*+] \[[^ xX\]]\] /
const CALLOUT_START = /^> \[!(\w+)\](.*)$/

// A callout the Memry callout block can represent losslessly: one of the four
// Memry types, no fold marker or custom title, and a simple single-paragraph
// body (no nested quotes/callouts, no `>` blank lines).
function isLosslessMemryCallout(blockLines: string[]): boolean {
  const match = blockLines[0].match(CALLOUT_START)
  if (!match || !MEMRY_CALLOUT_TYPES.includes(match[1])) return false
  if (match[2].trim() !== '') return false
  return blockLines
    .slice(1)
    .every(
      (line) =>
        line.startsWith('> ') &&
        line.slice(2).trim() !== '' &&
        !line.startsWith('> >') &&
        !line.startsWith('> [!')
    )
}

/**
 * Split markdown into segments the BlockNote pipeline may parse (`markdown`)
 * and segments it must pass through verbatim (`raw`).
 *
 * Raw-claimed constructs: `%%` block comments, `$$` math blocks, footnote
 * definition lines, custom-state checkbox lines, and callouts
 * `isLosslessMemryCallout` rejects. Code-fence interiors are never claimed.
 * Adjacent raw lines merge into one raw segment so their original single-`\n`
 * joins survive reassembly.
 */
export function splitForeignRawSegments(markdown: string): ForeignSegment[] {
  const lines = markdown.split('\n')
  const segments: ForeignSegment[] = []
  let mdLines: string[] = []
  let rawLines: string[] = []

  const flushMd = (): void => {
    if (mdLines.length === 0) return
    segments.push({ kind: 'markdown', text: mdLines.join('\n') })
    mdLines = []
  }
  const flushRaw = (): void => {
    if (rawLines.length === 0) return
    segments.push({ kind: 'raw', text: rawLines.join('\n') })
    rawLines = []
  }
  const pushMd = (line: string): void => {
    flushRaw()
    mdLines.push(line)
  }
  const pushRaw = (claimed: string[]): void => {
    flushMd()
    rawLines.push(...claimed)
  }

  let inFence = false
  let fenceChar = ''
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    const fenceMatch = line.match(FENCE_LINE)

    if (inFence) {
      if (fenceMatch && fenceMatch[1] === fenceChar) inFence = false
      pushMd(line)
      i++
      continue
    }
    if (fenceMatch) {
      inFence = true
      fenceChar = fenceMatch[1]
      pushMd(line)
      i++
      continue
    }

    // %% block comment / $$ math block: own-line delimiter through its closer.
    // Unclosed delimiters fall through as plain markdown.
    if (trimmed === '%%' || trimmed === '$$') {
      let j = i + 1
      while (j < lines.length && lines[j].trim() !== trimmed) j++
      if (j < lines.length) {
        pushRaw(lines.slice(i, j + 1))
        i = j + 1
        continue
      }
    }

    // Single-line display math: $$…$$ on one line.
    if (trimmed.startsWith('$$') && trimmed.endsWith('$$') && trimmed.length > 4) {
      pushRaw([line])
      i++
      continue
    }

    // ponytail: single-line footnote definitions only; indented continuation
    // lines re-parse as markdown (extend the claim if that ever bites).
    if (FOOTNOTE_DEF_LINE.test(line) || CUSTOM_CHECKBOX_LINE.test(line)) {
      pushRaw([line])
      i++
      continue
    }

    if (CALLOUT_START.test(line)) {
      let j = i + 1
      while (j < lines.length && (lines[j].startsWith('> ') || lines[j] === '>')) j++
      const blockLines = lines.slice(i, j)
      if (isLosslessMemryCallout(blockLines)) {
        for (const calloutLine of blockLines) pushMd(calloutLine)
      } else {
        pushRaw(blockLines)
      }
      i = j
      continue
    }

    pushMd(line)
    i++
  }

  flushMd()
  flushRaw()
  return segments
}
