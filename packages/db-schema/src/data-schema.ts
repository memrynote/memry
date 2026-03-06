/**
 * Schema for data.db (source of truth for tasks)
 *
 * This schema is used exclusively for the main data database
 * which stores tasks, projects, and other non-rebuildable data.
 *
 * @module db/schema/data-schema
 */

export * from './schema/projects'
export * from './schema/statuses'
export * from './schema/tasks'
export * from './schema/task-relations'
export * from './schema/inbox'
export * from './schema/settings'
export * from './schema/bookmarks'
export * from './schema/reminders'
export * from './schema/note-positions'
export * from './schema/tag-definitions'
export * from './schema/sync-devices'
export * from './schema/sync-queue'
export * from './schema/sync-state'
export * from './schema/sync-history'
