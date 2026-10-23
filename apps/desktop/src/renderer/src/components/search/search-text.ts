/** Turns markdown bodies into the plain lines the search palette shows. */
import { findOffsets } from '@/lib/find-text'

const MATCH_RADIUS = 48

function plainLine(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\s)[*_](\S)/g, '$1$2')
    .replace(/(\S)[*_](\s|$)/g, '$1$2')
    .replace(/<[^>]+>/g, '')
    .trim()
}

function bodyLines(markdown: string, keepCode: boolean): string[] {
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n?/, '')
  const lines: string[] = []
  let inFence = false
  for (const raw of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence && !keepCode) continue
    const line = plainLine(raw)
    if (line) lines.push(line)
  }
  return lines
}

/** Body lines with frontmatter, code fences, and markdown syntax removed. */
export function plainLines(markdown: string): string[] {
  return bodyLines(markdown, false)
}

export interface Occurrence {
  /** Index into `Occurrences.lines`. */
  line: number
  start: number
}

export interface Occurrences {
  lines: string[]
  /** Every hit in document order, so `hits[n]` is what the find bar calls match n. */
  hits: Occurrence[]
}

/**
 * Where `query` occurs in a note body, counted the way the find bar will count
 * it once the note is open. Code stays in: the editor renders it, so the find
 * bar matches inside it and an index that skipped it would land on the wrong hit.
 */
export function findOccurrences(markdown: string, query: string): Occurrences {
  const lines = bodyLines(markdown, true)
  const needle = query.trim()
  const hits = lines.flatMap((text, line) =>
    findOffsets(text, needle).map((start) => ({ line, start }))
  )
  return { lines, hits }
}

const SNIPPET_BEFORE = 20
const SNIPPET_AFTER = 60

/** A hit with the words around it, ready to render with the hit marked. */
export function occurrenceSnippet(
  lines: string[],
  hit: Occurrence,
  query: string
): { before: string; match: string; after: string } {
  const text = lines[hit.line]
  const end = hit.start + query.trim().length
  const from = Math.max(0, hit.start - SNIPPET_BEFORE)
  const to = Math.min(text.length, end + SNIPPET_AFTER)
  return {
    before: `${from > 0 ? '…' : ''}${text.slice(from, hit.start)}`,
    match: text.slice(hit.start, end),
    after: `${text.slice(end, to)}${to < text.length ? '…' : ''}`
  }
}

const normalized = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/** Opening text of a body, skipping a first line that only repeats the title. */
export function excerpt(lines: string[], max = 240, title?: string): string {
  const body =
    title && lines.length > 0 && normalized(lines[0]) === normalized(title) ? lines.slice(1) : lines
  const text = body.join(' ')
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text
}

function queryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

/** Lines that contain a query term, each trimmed to a window around the first hit. */
export function matchLines(
  lines: string[],
  query: string,
  max = 3
): { lines: string[]; total: number } {
  const terms = queryTerms(query)
  if (terms.length === 0) return { lines: [], total: 0 }
  const hits: string[] = []
  let total = 0
  for (const line of lines) {
    const lower = line.toLowerCase()
    const at = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0))
    if (!Number.isFinite(at)) continue
    total += 1
    if (hits.length >= max) continue
    const start = Math.max(0, at - MATCH_RADIUS)
    const end = Math.min(line.length, at + MATCH_RADIUS * 2)
    hits.push(`${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`)
  }
  return { lines: hits, total }
}
