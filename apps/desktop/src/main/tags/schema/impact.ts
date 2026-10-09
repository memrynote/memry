/** J1 and A2 counts: what a schema change would touch, read before anything runs. */
import type { ImpactQuery, ImpactResult } from '@memry/contracts/tag-schema-api'
import type { ResolvedTag } from '@memry/contracts/tag-schema'
import {
  countPropertyValues,
  headerObjectNoteIds,
  notesWithProperty,
  taskFieldValues,
  taskIdsWithTags
} from '@main/database/queries/tag-schema-counts'
import type { DataDb, IndexDb } from '../../database/types'
import { getTemplate } from '../../vault/templates'
import { descendantsOf } from '../tag-schema'
import { tagKey } from '@memry/shared/tag-fold'
import { loadResolvedTags } from './read'

const names = (tag: ResolvedTag | undefined): string[] =>
  tag?.effectiveFields.map((f) => f.name) ?? []

export async function previewTagImpact(
  db: DataDb,
  indexDb: IndexDb,
  query: ImpactQuery
): Promise<ImpactResult> {
  const resolved = loadResolvedTags(db)
  const members = (tag: string): string[] => [tagKey(tag), ...descendantsOf(tag, resolved)]

  switch (query.kind) {
    case 'remove-field': {
      const tags = members(query.tag)
      const noteIds = headerObjectNoteIds(indexDb, tags)
      const filledNotes = notesWithProperty(indexDb, query.name, noteIds).length
      const taskIds = new Set(taskIdsWithTags(db, tags))
      const filledTasks = taskFieldValues(db).filter(
        (task) => taskIds.has(task.id) && query.name in task.fields
      ).length
      const filled = filledNotes + filledTasks
      return { kind: 'remove-field', filled, empty: noteIds.length + taskIds.size - filled }
    }
    case 'rename-field':
      return {
        kind: 'rename-field',
        notes: notesWithProperty(indexDb, query.name).length,
        tasks: taskFieldValues(db).filter((task) => query.name in task.fields).length,
        tags: [...resolved.values()]
          .filter((tag) => tag.ownFields.some((f) => f.name === query.name))
          .map((tag) => tag.key)
      }
    case 'delete-tag': {
      const tag = resolved.get(tagKey(query.tag))
      const noteIds = headerObjectNoteIds(indexDb, [tagKey(query.tag)])
      const template = tag?.template && !tag.template.inheritedFrom ? tag.template : null
      return {
        kind: 'delete-tag',
        notes: noteIds.length,
        tasks: taskIdsWithTags(db, [tagKey(query.tag)]).length,
        values: countPropertyValues(indexDb, noteIds, names(tag)),
        fields: tag?.ownFields.length ?? 0,
        templateName: template ? ((await getTemplate(template.id))?.name ?? null) : null
      }
    }
    case 'set-extends': {
      const tag = resolved.get(tagKey(query.tag))
      const own = new Set(tag?.ownFields.map((f) => f.name.toLowerCase()) ?? [])
      const before = names(tag).filter((n) => !own.has(n.toLowerCase()))
      const parent = query.parent === null ? undefined : resolved.get(tagKey(query.parent))
      const after = names(parent).filter((n) => !own.has(n.toLowerCase()))
      return {
        kind: 'set-extends',
        notes: headerObjectNoteIds(indexDb, members(query.tag)).length,
        gained: after.filter((n) => !before.includes(n)),
        lost: before.filter((n) => !after.includes(n))
      }
    }
    case 'become-objects':
      return {
        kind: 'become-objects',
        notes: headerObjectNoteIds(indexDb, members(query.tag)).length
      }
  }
}
