/**
 * Predicates that match tag columns by tag identity (`foldTag`).
 *
 * The tag columns are `COLLATE NOCASE`, which folds ASCII only: `eq(tag, 'ünal')`
 * misses a row spelled `Ünal`. These compare `tag_fold(column)` (registered in
 * `database/sqlite-functions.ts`) with the folded input instead, and every
 * caller passes the tag as typed.
 */
import { sql, type AnyColumn, type SQL } from 'drizzle-orm'
import { foldTag } from '@memry/shared/tag-fold'

/** `column` is `tag`, in any spelling. */
export function tagIs(column: AnyColumn, tag: string): SQL {
  return sql`tag_fold(${column}) = ${foldTag(tag)}`
}

/** `column` is one of `tags`, in any spelling. False for an empty list. */
export function tagIn(column: AnyColumn, tags: Iterable<string>): SQL {
  const keys = [...new Set([...tags].map(foldTag))]
  if (keys.length === 0) return sql`0`
  return sql`tag_fold(${column}) IN (${sql.join(
    keys.map((key) => sql`${key}`),
    sql`, `
  )})`
}

/** `column` is a `/` descendant of `tag`. `work` never matches `workshop`. */
export function tagUnder(column: AnyColumn, tag: string): SQL {
  return sql`instr(tag_fold(${column}), ${`${foldTag(tag)}/`}) = 1`
}

/** `column` is `tag` or a `/` descendant of it. */
export function tagOrUnder(column: AnyColumn, tag: string): SQL {
  const key = foldTag(tag)
  return sql`(tag_fold(${column}) = ${key} OR instr(tag_fold(${column}), ${`${key}/`}) = 1)`
}

/** The column's tag identity, for GROUP BY and DISTINCT. */
export function tagFoldOf(column: AnyColumn): SQL<string> {
  return sql<string>`tag_fold(${column})`
}
