/**
 * Edit a frontmatter block in place: a key whose value did not change keeps
 * its lines byte for byte, a changed key gets new lines where the old ones
 * were, a removed key loses its lines and a new key goes at the end. Comments,
 * blank lines, quoting, key order and line endings survive. Re-stringifying the
 * whole block would reorder keys and re-spell every scalar (`due: 2026-10-07`
 * becomes an ISO timestamp).
 *
 * @module vault/frontmatter-edit
 */

import matter from 'gray-matter'
import { isDeepStrictEqual } from 'util'
import { stringifyFrontmatterBlock } from '@memry/app-core/markdown'
import { parseYamlDate, spellYamlDate } from './yaml-dates'

interface Entry {
  key: string
  value: unknown
  lines: string[]
}

type Segment = Entry | { key: null; lines: string[] }

const withoutCr = (line: string): string => line.replace(/\r$/, '')
const startsEntry = (line: string): boolean => /^(?:[^\s#-]|-\S)/.test(line)
const continuesEntry = (line: string): boolean => /^(?:[ \t]|-(?:\s|$))/.test(line)

function readYaml(lines: string[]): Record<string, unknown> | null {
  try {
    return matter(`---\n${lines.map(withoutCr).join('\n')}\n---\n`, {}).data
  } catch {
    return null
  }
}

/** Top-level entries with their continuation lines; blank and comment lines between them stand alone. */
function segment(lines: string[]): Segment[] | null {
  const segments: Segment[] = []
  let start = 0
  while (start < lines.length) {
    if (!startsEntry(withoutCr(lines[start]))) {
      segments.push({ key: null, lines: [lines[start]] })
      start += 1
      continue
    }
    let end = start + 1
    for (let next = end; next < lines.length; next += 1) {
      const line = withoutCr(lines[next])
      if (startsEntry(line)) break
      if (continuesEntry(line)) end = next + 1
    }
    const entryLines = lines.slice(start, end)
    const data = readYaml(entryLines) ?? {}
    const keys = Object.keys(data)
    if (keys.length !== 1) return null
    segments.push({ key: keys[0], value: data[keys[0]], lines: entryLines })
    start = end
  }
  return segments
}

/** A string that spells a date stays a date where the file held one. */
function valueToWrite(previous: unknown, value: unknown): unknown {
  if (previous instanceof Date && typeof value === 'string') return parseYamlDate(value) ?? value
  return value
}

function entryLines(key: string, value: unknown, cr: string): string[] {
  const lines = stringifyFrontmatterBlock({ [key]: value })
    .split('\n')
    .slice(1, -2)
  if (value instanceof Date && lines.length === 1) {
    const iso = value.toISOString()
    if (lines[0].endsWith(` ${iso}`)) {
      lines[0] = lines[0].slice(0, -iso.length) + spellYamlDate(value)
    }
  }
  return lines.map((line) => line + cr)
}

/**
 * The block with `next` as its keys, or null when its lines cannot be matched
 * one to one with the keys it parses to (anchors, duplicate keys, a flow
 * mapping), so the caller re-stringifies instead. `parsed` is the caller's
 * reading of the block; a value equal to either reading is unchanged.
 */
export function editFrontmatterBlock(
  block: string,
  parsed: Record<string, unknown>,
  next: Record<string, unknown>
): string | null {
  const wanted = Object.entries(next).filter(([, value]) => value !== undefined)
  if (wanted.length === 0) return ''

  const trailingNewline = block.endsWith('\n')
  const lines = (trailingNewline ? block.slice(0, -1) : block).split('\n')
  const inner = lines.slice(1, -1)
  const previous = readYaml(inner)
  const segments = segment(inner)
  if (!previous || !segments) return null

  const entries = segments.filter((s): s is Entry => s.key !== null)
  const keys = new Set(entries.map((entry) => entry.key))
  const matches =
    keys.size === entries.length &&
    keys.size === Object.keys(previous).length &&
    entries.every(
      (entry) =>
        Object.hasOwn(previous, entry.key) && isDeepStrictEqual(entry.value, previous[entry.key])
    )
  if (!matches) return null

  const cr = lines[0].endsWith('\r') ? '\r' : ''
  const values = new Map(wanted)
  const rewrite = (entry: Entry): string[] => {
    if (!values.has(entry.key)) return []
    const value = values.get(entry.key)
    const old = previous[entry.key]
    const toWrite = valueToWrite(old, value)
    const same = isDeepStrictEqual(old, toWrite) || isDeepStrictEqual(parsed[entry.key], value)
    return same ? entry.lines : entryLines(entry.key, toWrite, cr)
  }

  const body = segments.flatMap((s) => (s.key === null ? s.lines : rewrite(s)))
  const added = wanted
    .filter(([key]) => !keys.has(key))
    .flatMap(([key, value]) => entryLines(key, value, cr))
  const edited = [lines[0], ...body, ...added, lines[lines.length - 1]].join('\n')
  return trailingNewline ? edited + '\n' : edited
}
