/**
 * Writing tools in the note's markdown file, which is their source of truth.
 *
 * The body carries only where each range is:
 *
 *   Sabah <!--alt:k3x9q2-->ayaz<!--/alt:k3x9q2--> bir ruzgar esiyordu.
 *   Kahve dukkani <!--ghost-->biraz fazla<!--/ghost--> kalabalikti.
 *
 * Everything else sits in the `writing` frontmatter key: the other versions of
 * each alternative (keyed by the id in the body) and the overflow list.
 *
 *   writing:
 *     alternatives:
 *       k3x9q2:
 *         versions: [soguk, buz gibi, {text: keskin, ai: true}]
 *     overflow:
 *       - Belki de en iyisi hic yazmamakti.
 *
 * The body between the markers is always the version on show, so the file
 * reads as plain prose anywhere, and `original` is written only while a
 * variant is on show.
 *
 * Markers never reach the markdown parser. Decoding swaps each paired marker
 * for one private-use character (a sentinel) that rides through the parse
 * into the editor's text, where the caller turns sentinels into anchors and
 * deletes them. Encoding is the reverse: sentinels go into the text before
 * serialization and come out as comments. A marker with no partner is
 * dropped and its text kept: a broken marker costs the range, never prose.
 */

import {
  serializeCriticMarkup,
  type CriticMarkupMark,
  type ParsedCriticMarkup
} from '../critic-markup/parser'

export const WRITING_FRONTMATTER_KEY = 'writing'

export type WritingMarkerKind = 'alt' | 'ghost'

/** One end of a marked range. `key` pairs the ends: the alternative id, or a per-parse ghost key. */
export interface WritingMarker {
  kind: WritingMarkerKind
  key: string
  open: boolean
}

/** Sentinel character -> the marker it stands for. */
export type WritingSentinelMap = Map<string, WritingMarker>

export interface WritingFrontmatterVersion {
  text: string
  ai?: boolean
}

export interface WritingFrontmatterAlternative {
  /** Present only while the body shows one of the versions instead of the original. */
  original?: string
  versions: WritingFrontmatterVersion[]
}

export interface WritingFrontmatterOverflowItem {
  text: string
  label?: string
}

export interface WritingFrontmatter {
  alternatives: Record<string, WritingFrontmatterAlternative>
  overflow: WritingFrontmatterOverflowItem[]
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const MARKER_PATTERN = /<!--\s*(\/?)(alt|ghost)(?::([A-Za-z0-9_-]{1,64}))?\s*-->/g

export function isWritingAlternativeId(value: string): boolean {
  return ID_PATTERN.test(value)
}

// ----------------------------------------------------------------------------
// Sentinels
// ----------------------------------------------------------------------------

const PRIVATE_USE_START = 0xe000
const PRIVATE_USE_END = 0xf8ff

/**
 * Hands out private-use characters that do not occur in `taken`, so a
 * sentinel can never be mistaken for a character the author typed.
 */
export function createSentinelAllocator(taken: string): () => string | null {
  const used = new Set<number>()
  for (const char of taken) {
    const code = char.charCodeAt(0)
    if (code >= PRIVATE_USE_START && code <= PRIVATE_USE_END) used.add(code)
  }
  let next = PRIVATE_USE_START
  return () => {
    while (next <= PRIVATE_USE_END && used.has(next)) next++
    if (next > PRIVATE_USE_END) return null
    return String.fromCharCode(next++)
  }
}

function markerComment(marker: WritingMarker): string {
  const slash = marker.open ? '' : '/'
  return marker.kind === 'alt' ? `<!--${slash}alt:${marker.key}-->` : `<!--${slash}ghost-->`
}

interface MarkerToken {
  index: number
  length: number
  kind: WritingMarkerKind
  id: string | undefined
  open: boolean
}

/**
 * The body with every paired marker replaced by a sentinel and every unpaired
 * one removed. Alternatives pair by id (the first open with the first later
 * close of the same id); ghosts pair as nested brackets. Ranges may nest or
 * cross; an alternative id that occurs twice keeps its first range only.
 */
export function decodeWritingMarkers(markdown: string): {
  text: string
  sentinels: WritingSentinelMap
} {
  const tokens: MarkerToken[] = []
  for (const match of markdown.matchAll(MARKER_PATTERN)) {
    tokens.push({
      index: match.index,
      length: match[0].length,
      kind: match[2] as WritingMarkerKind,
      id: match[3],
      open: match[1] !== '/'
    })
  }
  if (tokens.length === 0) return { text: markdown, sentinels: new Map() }

  const partner = new Map<number, string>()
  const openAlt = new Map<string, number>()
  const pairedAlt = new Set<string>()
  const ghostStack: number[] = []
  let ghostCount = 0
  tokens.forEach((token, position) => {
    if (token.kind === 'ghost') {
      if (token.open) ghostStack.push(position)
      else {
        const opener = ghostStack.pop()
        if (opener === undefined) return
        const key = `g${ghostCount++}`
        partner.set(opener, key)
        partner.set(position, key)
      }
      return
    }
    if (token.id === undefined || pairedAlt.has(token.id)) return
    if (token.open) {
      if (!openAlt.has(token.id)) openAlt.set(token.id, position)
      return
    }
    const opener = openAlt.get(token.id)
    if (opener === undefined) return
    openAlt.delete(token.id)
    pairedAlt.add(token.id)
    partner.set(opener, token.id)
    partner.set(position, token.id)
  })

  const allocate = createSentinelAllocator(markdown)
  const sentinels: WritingSentinelMap = new Map()
  const sentinelByKey = new Map<string, { open: string; close: string } | null>()
  const sentinelFor = (token: MarkerToken, key: string): string | null => {
    let pair = sentinelByKey.get(key)
    if (pair === undefined) {
      const open = allocate()
      const close = open === null ? null : allocate()
      pair = open !== null && close !== null ? { open, close } : null
      sentinelByKey.set(key, pair)
      if (pair) {
        sentinels.set(pair.open, { kind: token.kind, key, open: true })
        sentinels.set(pair.close, { kind: token.kind, key, open: false })
      }
    }
    if (!pair) return null
    return token.open ? pair.open : pair.close
  }

  let text = ''
  let cursor = 0
  tokens.forEach((token, position) => {
    text += markdown.slice(cursor, token.index)
    const key = partner.get(position)
    if (key !== undefined) text += sentinelFor(token, key) ?? ''
    cursor = token.index + token.length
  })
  return { text: text + markdown.slice(cursor), sentinels }
}

export function stripWritingSentinels(text: string, sentinels: WritingSentinelMap): string {
  if (sentinels.size === 0) return text
  let out = ''
  for (const char of text) if (!sentinels.has(char)) out += char
  return out
}

/**
 * CriticMarkup parsed out of sentinel-bearing text, moved onto the text with
 * the sentinels removed: the offsets every other CriticMarkup reader uses.
 */
export function withoutWritingSentinels(
  parsed: ParsedCriticMarkup,
  sentinels: WritingSentinelMap
): ParsedCriticMarkup {
  if (sentinels.size === 0) return parsed
  const before: number[] = [0]
  let count = 0
  for (let index = 0; index < parsed.plainText.length; index++) {
    if (sentinels.has(parsed.plainText[index])) count++
    before.push(count)
  }
  const strip = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : stripWritingSentinels(value, sentinels)
  return {
    plainText: stripWritingSentinels(parsed.plainText, sentinels),
    marks: parsed.marks.map((mark) => ({
      ...mark,
      visibleText: stripWritingSentinels(mark.visibleText, sentinels),
      start: mark.start - before[mark.start],
      end: mark.end - before[mark.end],
      ...(mark.originalText !== undefined ? { originalText: strip(mark.originalText) } : {})
    }))
  }
}

/**
 * The file body for serialized text that carries sentinels: CriticMarkup
 * applied (its offsets count no sentinels), then every sentinel written out
 * as its comment. A writing range that cuts into a CriticMarkup range is
 * widened to cover it, since a comment inside `{++…++}` would end up in the
 * mark's text.
 */
export function encodeWritingBody(
  text: string,
  sentinels: WritingSentinelMap,
  criticMarks: CriticMarkupMark[]
): string {
  const withCritic =
    criticMarks.length === 0 ? text : serializeCriticAroundSentinels(text, sentinels, criticMarks)
  if (sentinels.size === 0) return withCritic
  let out = ''
  for (const char of withCritic) {
    const marker = sentinels.get(char)
    out += marker ? markerComment(marker) : char
  }
  return out
}

function serializeCriticAroundSentinels(
  text: string,
  sentinels: WritingSentinelMap,
  marks: CriticMarkupMark[]
): string {
  // The text as plain characters, each carrying the sentinels just before it;
  // `before[plain.length]` holds the trailing ones.
  const plainChars: string[] = []
  const before: string[][] = [[]]
  for (const char of text) {
    if (sentinels.has(char)) before[before.length - 1].push(char)
    else {
      plainChars.push(char)
      before.push([])
    }
  }
  // `for…of` walks code points; offsets are UTF-16 units. Rebuild per unit.
  const units: string[] = []
  const unitBefore: string[][] = []
  plainChars.forEach((char, index) => {
    unitBefore.push(before[index])
    units.push(char[0])
    for (let k = 1; k < char.length; k++) {
      unitBefore.push([])
      units.push(char[k])
    }
  })
  unitBefore.push(before[plainChars.length])

  for (const mark of marks) {
    if (mark.end - mark.start < 2) continue
    if (mark.start < 0 || mark.end > units.length) continue
    for (let index = mark.start + 1; index < mark.end; index++) {
      const inside = unitBefore[index]
      if (inside.length === 0) continue
      unitBefore[index] = []
      for (const sentinel of inside) {
        if (sentinels.get(sentinel)?.open) unitBefore[mark.start].push(sentinel)
        else unitBefore[mark.end].unshift(sentinel)
      }
    }
  }

  // Positions in the rebuilt text: a plain unit sits after its sentinels.
  let rebuilt = ''
  const unitAt: number[] = []
  units.forEach((unit, index) => {
    rebuilt += unitBefore[index].join('')
    unitAt.push(rebuilt.length)
    rebuilt += unit
  })
  const tailAt = rebuilt.length
  rebuilt += unitBefore[units.length].join('')

  const startAt = (offset: number): number => (offset < units.length ? unitAt[offset] : tailAt)
  const endAt = (offset: number): number => (offset === 0 ? startAt(0) : unitAt[offset - 1] + 1)
  const mapped = marks.map((mark) => {
    if (mark.start < 0 || mark.end > units.length || mark.end < mark.start) return mark
    const start = startAt(mark.start)
    return { ...mark, start, end: mark.end === mark.start ? start : endAt(mark.end) }
  })
  return serializeCriticMarkup(rebuilt, mapped)
}

// ----------------------------------------------------------------------------
// Frontmatter
// ----------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readVersion(value: unknown): WritingFrontmatterVersion | null {
  if (typeof value === 'string') return value.length > 0 ? { text: value } : null
  if (!isPlainObject(value) || typeof value.text !== 'string' || value.text.length === 0) {
    return null
  }
  return value.ai === true ? { text: value.text, ai: true } : { text: value.text }
}

function readAlternative(value: unknown): WritingFrontmatterAlternative | null {
  const raw = Array.isArray(value) ? { versions: value } : value
  if (!isPlainObject(raw) || !Array.isArray(raw.versions)) return null
  const versions = raw.versions.flatMap((entry) => {
    const version = readVersion(entry)
    return version ? [version] : []
  })
  if (versions.length === 0) return null
  return typeof raw.original === 'string' ? { original: raw.original, versions } : { versions }
}

function readOverflowItem(value: unknown): WritingFrontmatterOverflowItem | null {
  if (typeof value === 'string') return value.length > 0 ? { text: value } : null
  if (!isPlainObject(value) || typeof value.text !== 'string' || value.text.length === 0) {
    return null
  }
  return typeof value.label === 'string' && value.label.length > 0
    ? { text: value.text, label: value.label }
    : { text: value.text }
}

/**
 * The `writing` frontmatter value, or null when the value is not one: a
 * `writing:` key the author uses for something else stays their property.
 */
export function readWritingFrontmatter(value: unknown): WritingFrontmatter | null {
  if (!isPlainObject(value)) return null
  const keys = Object.keys(value)
  if (keys.length === 0 || keys.some((key) => key !== 'alternatives' && key !== 'overflow')) {
    return null
  }
  if (value.alternatives !== undefined && !isPlainObject(value.alternatives)) return null
  if (value.overflow !== undefined && !Array.isArray(value.overflow)) return null

  const alternatives: Record<string, WritingFrontmatterAlternative> = {}
  for (const [id, entry] of Object.entries(value.alternatives ?? {})) {
    if (!isWritingAlternativeId(id)) continue
    const alternative = readAlternative(entry)
    if (alternative) alternatives[id] = alternative
  }
  const overflow = ((value.overflow as unknown[] | undefined) ?? []).flatMap((entry) => {
    const item = readOverflowItem(entry)
    return item ? [item] : []
  })
  return { alternatives, overflow }
}

export function isWritingFrontmatterValue(value: unknown): boolean {
  return readWritingFrontmatter(value) !== null
}

/**
 * The YAML-shaped value for `writing`, or undefined when there is nothing to
 * keep (the key is then removed). User versions and unlabelled overflow items
 * are bare strings so the common case reads as a plain list.
 */
export function toWritingFrontmatterValue(
  writing: WritingFrontmatter
): Record<string, unknown> | undefined {
  const alternatives = Object.entries(writing.alternatives)
  const value: Record<string, unknown> = {}
  if (alternatives.length > 0) {
    value.alternatives = Object.fromEntries(
      alternatives.map(([id, alternative]) => {
        const versions = alternative.versions.map((version) =>
          version.ai ? { text: version.text, ai: true } : version.text
        )
        return [
          id,
          alternative.original === undefined
            ? { versions }
            : { original: alternative.original, versions }
        ]
      })
    )
  }
  if (writing.overflow.length > 0) {
    value.overflow = writing.overflow.map((item) =>
      item.label ? { label: item.label, text: item.text } : item.text
    )
  }
  return Object.keys(value).length > 0 ? value : undefined
}
