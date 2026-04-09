/**
 * Schema for data.db (source of truth for tasks)
 *
 * This schema is used exclusively for the main data database
 * which stores tasks, projects, and other non-rebuildable data.
 *
 * @module db/schema/data-schema
 */

export * from './schema/projects.ts'
export * from './schema/statuses.ts'
export * from './schema/tasks.ts'
export * from './schema/task-relations.ts'
export * from './schema/inbox.ts'
export * from './schema/settings.ts'
export * from './schema/bookmarks.ts'
export * from './schema/reminders.ts'
export * from './schema/note-positions.ts'
export * from './schema/note-metadata.ts'
export * from './schema/tag-definitions.ts'
export * from './schema/sync-devices.ts'
export * from './schema/sync-queue.ts'
export * from './schema/sync-state.ts'
export * from './schema/sync-history.ts'
export * from './schema/search-reasons.ts'
export {
  propertyDefinitions,
  type PropertyDefinition,
  type NewPropertyDefinition
} from './schema/notes-cache.ts'
