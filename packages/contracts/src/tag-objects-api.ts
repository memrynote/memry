/**
 * Object reads for tags with fields: the @ menu and relation picker search,
 * and an object's "Linked here" groups. Read-only; inverse lists are derived
 * on every call, never stored.
 */

import { z } from 'zod'

const TagName = z.string().trim().min(1).max(100)

export const SearchObjectsSchema = z.object({
  query: z.string().max(200),
  /** Only objects of this tag and the tags that extend it (relation target). */
  tag: TagName.optional(),
  limit: z.number().int().min(1).max(50).default(12)
})
export type SearchObjectsInput = z.infer<typeof SearchObjectsSchema>

export interface ObjectMatch {
  noteId: string
  title: string
  /** Lowercase primary object tag of the note (within `tag`'s family when filtered). */
  tag: string
  /** Root of `tag`'s extends chain: the group the match lists under. */
  groupTag: string
  /** `tag` when it differs from `groupTag` ("employee" under People). */
  viaTag: string | null
  /** First filled text-like field, then the first filled relation's title (else the second text-like field). */
  subtitle: string[]
  modified: string
}

export interface SearchObjectsResponse {
  matches: ObjectMatch[]
  /** False while tag rows from an older build still lack a header flag. */
  complete: boolean
}

export const GetLinkedHereSchema = z.object({
  noteId: z.string().min(1),
  limitPerGroup: z.number().int().min(1).max(500).default(2)
})
export type GetLinkedHereInput = z.infer<typeof GetLinkedHereSchema>

export interface LinkedNoteItem {
  noteId: string
  title: string
  date: string | null
  snippet: string | null
}

export interface LinkedTaskItem {
  taskId: string
  title: string
  dueDate: string | null
  completed: boolean
}

export type LinkedHereGroup =
  | {
      kind: 'relation'
      /** Lowercase tag that defines the field, '' when no tag defines it. */
      sourceTag: string
      field: string
      /** The relation's inverse label, else the source tag's name, else the field name. */
      label: string
      total: number
      items: LinkedNoteItem[]
      /** Filter that opens the matching table rows. */
      filter: string
    }
  | {
      kind: 'task-field'
      /** Lowercase task tag that defines the field, '' when none does. */
      tag: string
      field: string
      total: number
      items: LinkedTaskItem[]
      filter: string
    }
  | { kind: 'mentions'; total: number; items: LinkedNoteItem[] }

export interface GetLinkedHereResponse {
  groups: LinkedHereGroup[]
}
