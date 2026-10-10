import type { DataDb } from '../database/types'
import type { HeaderTagEdit } from '@memry/contracts/notes-api'
import { extractInlineTagsFromMarkdown } from '@memry/shared/inline-tags'
import { foldTag, tagKey } from '@memry/shared/tag-fold'
import { applyHeaderTagEdit } from '../vault/frontmatter'
import { tagsWithFields } from './schema/read'

export function inlineTagEditBetween(before: string, after: string): HeaderTagEdit | null {
  const beforeTags = extractInlineTagsFromMarkdown(before)
  const afterTags = extractInlineTagsFromMarkdown(after)
  const beforeKeys = new Set(beforeTags.map(foldTag))
  const afterKeys = new Set(afterTags.map(foldTag))
  const add = afterTags.filter((tag) => !beforeKeys.has(foldTag(tag)))
  const remove = beforeTags.filter((tag) => !afterKeys.has(foldTag(tag)))
  return add.length > 0 || remove.length > 0 ? { add, remove, source: 'inline' } : null
}

export function applyInlineTagEdit(
  db: DataDb,
  current: readonly string[],
  edit: Pick<HeaderTagEdit, 'add' | 'remove'>
): string[] {
  const withFields = tagsWithFields(db)
  const plain = (tags: string[] | undefined): string[] =>
    (tags ?? []).filter((tag) => !withFields.has(tagKey(tag)))
  return applyHeaderTagEdit(current, { add: plain(edit.add), remove: plain(edit.remove) })
}
