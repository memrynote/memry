import type { DataDb } from '../database/types'
import { listTagSchemas } from '@main/database/queries/tag-definitions'
import type { HeaderTagEdit } from '@memry/contracts/notes-api'
import { extractInlineTagsFromMarkdown } from '@memry/shared/inline-tags'
import { createLogger } from '../lib/logger'
import { applyHeaderTagEdit } from '../vault/frontmatter'

const log = createLogger('FieldTags')

/**
 * Lowercase names of the tags with fields: a non-empty `fields` list in the
 * tag's own schema or in a tag it extends. A cycle in `extends` ends the walk.
 */
export function resolveTagsWithFields(
  rows: readonly { name: string; schema: string }[]
): Set<string> {
  const parentOf = new Map<string, string>()
  const hasOwnFields = new Set<string>()
  for (const row of rows) {
    const name = row.name.toLowerCase()
    let parsed: unknown
    try {
      parsed = JSON.parse(row.schema)
    } catch {
      log.warn('Ignoring a tag schema that is not JSON', { tag: row.name })
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const { fields, extends: parent } = parsed as { fields?: unknown; extends?: unknown }
    if (Array.isArray(fields) && fields.length > 0) hasOwnFields.add(name)
    if (typeof parent === 'string' && parent.trim()) parentOf.set(name, parent.trim().toLowerCase())
  }

  const withFields = new Set<string>()
  for (const name of new Set([...hasOwnFields, ...parentOf.keys()])) {
    const seen = new Set<string>()
    for (let tag = name as string | undefined; tag && !seen.has(tag); tag = parentOf.get(tag)) {
      seen.add(tag)
      if (hasOwnFields.has(tag)) {
        withFields.add(name)
        break
      }
    }
  }
  return withFields
}

export function tagsWithFields(db: DataDb): Set<string> {
  return resolveTagsWithFields(listTagSchemas(db))
}

/** The inline `#tags` a body edit added and removed, or null when it changed none. */
export function inlineTagEditBetween(before: string, after: string): HeaderTagEdit | null {
  const key = (tag: string): string => tag.toLowerCase()
  const beforeTags = extractInlineTagsFromMarkdown(before)
  const afterTags = extractInlineTagsFromMarkdown(after)
  const beforeKeys = new Set(beforeTags.map(key))
  const afterKeys = new Set(afterTags.map(key))
  const add = afterTags.filter((tag) => !beforeKeys.has(key(tag)))
  const remove = beforeTags.filter((tag) => !afterKeys.has(key(tag)))
  return add.length > 0 || remove.length > 0 ? { add, remove, source: 'inline' } : null
}

/**
 * `current` after an inline-origin edit: only plain tags move between the body
 * and the header. A tag with fields typed in the text stays a mention, and
 * deleting that mention leaves a header that holds the tag alone.
 */
export function applyInlineTagEdit(
  db: DataDb,
  current: readonly string[],
  edit: Pick<HeaderTagEdit, 'add' | 'remove'>
): string[] {
  const withFields = tagsWithFields(db)
  const plain = (tags: string[] | undefined): string[] =>
    (tags ?? []).filter((tag) => !withFields.has(tag.toLowerCase()))
  return applyHeaderTagEdit(current, { add: plain(edit.add), remove: plain(edit.remove) })
}
