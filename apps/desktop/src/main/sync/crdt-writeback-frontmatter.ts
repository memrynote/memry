import type * as Y from 'yjs'
import { isDeepStrictEqual } from 'node:util'
import {
  isWritingFrontmatterValue,
  toWritingFrontmatterValue,
  WRITING_FRONTMATTER_KEY,
  type WritingFrontmatter
} from '@memry/shared'
import type { NoteFrontmatter } from '../vault/frontmatter'

interface MergedFrontmatter {
  frontmatter: NoteFrontmatter
  /** True only when the merge actually altered a frontmatter value */
  changed: boolean
}

/**
 * Merge write-back frontmatter: user keys pass through verbatim. No Memry keys
 * are ever injected. `changed` stays false when the CRDT state matches the
 * file, so the raw block survives verbatim.
 *
 * The file owns its `tags:` list: header edits land in the file and sync with
 * the note record. The doc's `tags` array can be stale (a header edit made
 * while the note was closed never reaches its stored doc) or hold body tags (a
 * doc an older build seeded with header and inline tags), so it only seeds the
 * list of a file the write-back creates.
 */
export function mergeFrontmatter(
  existing: NoteFrontmatter | null,
  doc: Y.Doc,
  writing: WritingFrontmatter
): MergedFrontmatter {
  const merged: NoteFrontmatter = { ...existing }
  let changed = mergeWritingFrontmatter(merged, writing)
  const yjsTags = existing === null ? getYjsTags(doc) : []
  if (yjsTags.length > 0) {
    merged.tags = yjsTags
    changed = true
  }
  return { frontmatter: merged, changed }
}

export function mergeJournalFrontmatter(
  date: string,
  existing: NoteFrontmatter | null,
  doc: Y.Doc,
  writing: WritingFrontmatter
): MergedFrontmatter {
  const yjsTags = getYjsTags(doc)
  const merged: NoteFrontmatter = { ...existing, date }
  let changed = normalizeDateValue(existing?.date) !== date
  if (mergeWritingFrontmatter(merged, writing)) changed = true
  if (yjsTags.length > 0 && !sameTags(existing?.tags, yjsTags)) {
    merged.tags = yjsTags
    changed = true
  }
  return { frontmatter: merged, changed }
}

/**
 * The doc's writing tools data onto `frontmatter.writing`; true when that
 * changed it. A `writing` key that is not writing tools data is the author's
 * property and is left alone, at the cost of not writing ours.
 */
function mergeWritingFrontmatter(
  frontmatter: NoteFrontmatter,
  writing: WritingFrontmatter
): boolean {
  const current = frontmatter[WRITING_FRONTMATTER_KEY]
  if (current !== undefined && !isWritingFrontmatterValue(current)) return false
  const next = toWritingFrontmatterValue(writing)
  if (isDeepStrictEqual(current, next)) return false
  if (next === undefined) delete frontmatter[WRITING_FRONTMATTER_KEY]
  else frontmatter[WRITING_FRONTMATTER_KEY] = next
  return true
}

function sameTags(existing: unknown, next: string[]): boolean {
  return (
    Array.isArray(existing) &&
    existing.length === next.length &&
    existing.every((v, i) => String(v) === next[i])
  )
}

/** YAML gives `date: 2026-07-05` back as a Date object — compare by day. */
function normalizeDateValue(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'string') return value
  if (value == null) return null
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  return JSON.stringify(value)
}

function getYjsTags(doc: Y.Doc): string[] {
  const tagArray = doc.getArray('tags')
  const tags: string[] = []
  for (let i = 0; i < tagArray.length; i++) {
    const val = tagArray.get(i)
    if (typeof val === 'string') tags.push(val)
  }
  return tags
}
