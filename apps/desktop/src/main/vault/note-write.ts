/**
 * The pure parts of one note write (header tags, frontmatter) and the one
 * per-note queue every read-modify-write of a note file goes through.
 *
 * @module vault/note-write
 */
import { isDeepStrictEqual } from 'util'
import type { HeaderTagEdit } from '@memry/contracts/notes-api'
import { extractInlineTagsFromMarkdown } from '@memry/shared/inline-tags'
import type { DataDb } from '../database/types'
import { applyInlineTagEdit, inlineTagEditBetween } from '../tags/inline-tags'
import {
  applyHeaderTagEdit,
  normalizePropertiesToRoot,
  propertiesToWrite,
  replacePropertiesOnRoot,
  patchPropertiesOnRoot,
  type NoteFrontmatter
} from './frontmatter'

export type HeaderTagChange = { added: string[]; removed: string[] } | null

const noteWrites = new Map<string, Promise<unknown>>()

/**
 * Runs `write` after every write queued before it for the same note. Two quick
 * edits of one note (add #a then #b, or a tag and a property) would otherwise
 * both start from the file as it was, and the later write would drop the earlier.
 */
export function queueNoteWrite<T>(noteId: string, write: () => Promise<T>): Promise<T> {
  const run = (noteWrites.get(noteId) ?? Promise.resolve()).then(write)
  const settled = run.catch(() => {})
  noteWrites.set(noteId, settled)
  void settled.then(() => {
    if (noteWrites.get(noteId) === settled) noteWrites.delete(noteId)
  })
  return run
}

const key = (tag: string): string => tag.toLowerCase()

/**
 * A full `tags` list from the agent API as an edit of the header. The list may
 * echo `Note.tags`, which holds the body's `#tags` too, so a tag the note only
 * mentions inline is not promoted into the header by being echoed back.
 */
function headerTagEditToList(
  header: readonly string[],
  body: string,
  next: readonly string[]
): HeaderTagEdit {
  const have = new Set(header.map(key))
  const want = new Set(next.map(key))
  const inline = new Set(extractInlineTagsFromMarkdown(body).map(key))
  return {
    add: next.filter((tag) => !have.has(key(tag)) && !inline.has(key(tag))),
    remove: header.filter((tag) => !want.has(key(tag)))
  }
}

/**
 * The note's header tags after an update: the explicit edit (`headerTags` or
 * the agent's `tags` list) first, then the plain `#tags` a new body added or
 * removed, as typing them in the editor does. `ignoreInlineTags` skips the
 * second step for a body Memry wrote itself (a tag template and its undo).
 */
export function nextHeaderTags(
  db: DataDb,
  existing: { headerTags: string[]; content: string },
  input: {
    headerTags?: HeaderTagEdit
    tags?: string[]
    content?: string
    ignoreInlineTags?: boolean
  }
): string[] {
  const explicit =
    input.headerTags ??
    (input.tags ? headerTagEditToList(existing.headerTags, existing.content, input.tags) : null)
  let tags = !explicit
    ? existing.headerTags
    : explicit.source === 'inline'
      ? applyInlineTagEdit(db, existing.headerTags, explicit)
      : applyHeaderTagEdit(existing.headerTags, explicit)
  const inlineEdit =
    explicit?.source === 'inline' || input.content === undefined || input.ignoreInlineTags
      ? null
      : inlineTagEditBetween(existing.content, input.content)
  if (inlineEdit) tags = applyInlineTagEdit(db, tags, inlineEdit)
  return tags
}

/** What a header edit added and removed, or null when it left the list exactly as it was. */
export function compareHeaderTags(
  before: readonly string[],
  after: readonly string[]
): HeaderTagChange {
  if (after.length === before.length && after.every((tag, i) => tag === before[i])) return null
  const holds = (list: readonly string[], tag: string): boolean =>
    list.some((held) => key(held) === key(tag))
  return {
    added: after.filter((tag) => !holds(before, tag)),
    removed: before.filter((tag) => !holds(after, tag))
  }
}

/**
 * The frontmatter a note write leaves in the file, built from the file's own
 * frontmatter (never the index), and whether its block must be re-stringified.
 */
export function nextNoteFrontmatter(
  existing: { frontmatter: NoteFrontmatter; properties: Record<string, unknown> },
  input: {
    frontmatter?: Record<string, unknown>
    properties?: Record<string, unknown>
    propertyPatch?: Record<string, unknown>
  },
  headerTags: string[],
  headerTagChange: HeaderTagChange
): { frontmatter: NoteFrontmatter; properties: Record<string, unknown>; edited: boolean } {
  // User keys only — Memry state (title, dates, emoji, localOnly) lives in the DBs
  const merged: NoteFrontmatter = { ...existing.frontmatter, ...input.frontmatter }
  for (const [name, value] of Object.entries(input.frontmatter ?? {})) {
    if (value === null) delete merged[name]
  }
  let frontmatter = normalizePropertiesToRoot(merged).frontmatter
  if (input.propertyPatch) frontmatter = patchPropertiesOnRoot(frontmatter, input.propertyPatch)
  const properties = propertiesToWrite(input.properties, existing, frontmatter)
  if (input.properties !== undefined) {
    frontmatter = replacePropertiesOnRoot(frontmatter, properties)
  }

  // A `frontmatter` patch never sets `tags`, and an unchanged list keeps its bytes.
  const tagsValue =
    headerTagChange === null
      ? existing.frontmatter.tags
      : headerTags.length > 0
        ? headerTags
        : undefined
  if (tagsValue === undefined) delete frontmatter.tags
  else frontmatter.tags = tagsValue

  // Re-stringify when a caller changed frontmatter or when normalizing a
  // legacy nested property block. Otherwise the raw block stays byte-identical.
  const edited =
    !isDeepStrictEqual(frontmatter, existing.frontmatter) ||
    headerTagChange !== null ||
    (input.properties !== undefined && !isDeepStrictEqual(input.properties, existing.properties)) ||
    (input.frontmatter !== undefined &&
      !isDeepStrictEqual({ ...existing.frontmatter, ...input.frontmatter }, existing.frontmatter))
  return { frontmatter, properties, edited }
}
