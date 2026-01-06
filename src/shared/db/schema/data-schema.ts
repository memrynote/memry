/**
 * Schema for data.db (source of truth for tasks)
 *
 * This schema is used exclusively for the main data database
 * which stores tasks, projects, and other non-rebuildable data.
 *
 * @module db/schema/data-schema
 */

export * from './projects'
export * from './statuses'
export * from './tasks'
export * from './task-relations'
export * from './inbox'
export * from './settings'
export * from './bookmarks'
export * from './reminders'
