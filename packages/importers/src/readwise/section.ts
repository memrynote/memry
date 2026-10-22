/**
 * The section markers and the state in the end marker (D5). `v1` is a vault
 * format that older and newer builds read, so the token is part of the
 * contract.
 */

export const SECTION_START = '<!-- readwise:start -->'
export const SECTION_FORMAT_VERSION = 1

export interface EndMarker {
  /** Newest `created_at` (Readwise server time) written into the note. */
  last: string
  /** Hash of the section body as Memry wrote it. */
  hash: string
}

const END_MARKER_LINE = /^<!-- readwise:end (.*) -->$/
const END_MARKER_FIELDS = /^v(\d+) last=(\S+) hash=([0-9a-f]+)$/

/** Line endings and trailing whitespace the editor round trip may change. */
function normalizeForHash(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
}

/** 32-bit FNV-1a over the UTF-16 code units, as 8 hex digits. */
export function hashSectionBody(body: string): string {
  let hash = 0x811c9dc5
  const text = normalizeForHash(body)
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function writeEndMarker({ last, hash }: EndMarker): string {
  return `<!-- readwise:end v${SECTION_FORMAT_VERSION} last=${last} hash=${hash} -->`
}

/**
 * The whole section for `body`, sealed with a fresh hash. A blank line sits
 * inside each marker, which is how the editor round trip writes the markers. After an append to a
 * touched section the writer keeps the old hash and writes the new `last` with
 * `writeEndMarker`, so the section stays touched.
 */
export function sealSection(body: string, last: string): string {
  return `${SECTION_START}\n\n${body}\n\n${writeEndMarker({ last, hash: hashSectionBody(body) })}`
}

export type SectionProblem =
  'no-start' | 'no-end' | 'out-of-order' | 'inline-marker' | 'duplicate-markers'

export type SectionRead =
  | {
      found: true
      /** Offsets in `body` of the start marker and just past the end marker. */
      range: { start: number; end: number }
      /** Text between the two marker lines. */
      text: string
      /** Null when the end marker is not a `v1` marker this build can read. */
      marker: EndMarker | null
      /** The hash matches, so the section is bytes Memry wrote. */
      untouched: boolean
    }
  | {
      found: false
      untouched: false
      problem: SectionProblem
      /**
       * The one end marker, when the note holds exactly one and no marker text
       * sits inline: `no-start` and `out-of-order` reads. The writer appends
       * before it and keeps its state.
       */
      end?: { range: { start: number; end: number }; marker: EndMarker | null }
    }

function parseEndMarker(fieldsText: string): EndMarker | null {
  const fields = END_MARKER_FIELDS.exec(fieldsText)
  return fields && Number(fields[1]) === SECTION_FORMAT_VERSION
    ? { last: fields[2], hash: fields[3] }
    : null
}

/**
 * Find the section in a note body. Both markers must be alone on their line,
 * once each, start before end. Anything else is reported as a problem and the
 * section is never untouched, so the writer appends instead of rewriting.
 */
export function readSection(body: string): SectionRead {
  const starts: Array<{ from: number; to: number }> = []
  const ends: Array<{ from: number; to: number; text: string }> = []
  let inline = false

  let offset = 0
  for (const rawLine of body.split('\n')) {
    const lineEnd = offset + rawLine.length
    const line = rawLine.trim()
    const endMatch = END_MARKER_LINE.exec(line)
    if (line === SECTION_START) starts.push({ from: offset, to: lineEnd })
    else if (endMatch) ends.push({ from: offset, to: lineEnd, text: endMatch[1] })
    else if (line.includes('<!-- readwise:start') || line.includes('<!-- readwise:end')) {
      inline = true
    }
    offset = lineEnd + 1
  }

  if (inline) return { found: false, untouched: false, problem: 'inline-marker' }
  if (starts.length > 1 || ends.length > 1) {
    return { found: false, untouched: false, problem: 'duplicate-markers' }
  }
  if (ends.length === 0) {
    const problem = starts.length === 0 ? 'no-start' : 'no-end'
    return { found: false, untouched: false, problem }
  }
  const [end] = ends
  const endRead = { range: { start: end.from, end: end.to }, marker: parseEndMarker(end.text) }
  if (starts.length === 0) {
    return { found: false, untouched: false, problem: 'no-start', end: endRead }
  }
  const [start] = starts
  if (end.from < start.to) {
    return { found: false, untouched: false, problem: 'out-of-order', end: endRead }
  }

  const marker = parseEndMarker(end.text)
  const text = body.slice(start.to + 1, end.from - 1)
  return {
    found: true,
    range: { start: start.from, end: end.to },
    text,
    marker,
    untouched: marker !== null && marker.hash === hashSectionBody(text)
  }
}
