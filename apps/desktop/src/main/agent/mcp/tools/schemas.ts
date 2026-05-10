import { z } from 'zod'

const idSchema = z.string().min(1)
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const TOOL_SCHEMAS = {
  vault_search_notes: {
    input: z.object({
      query: z.string().min(1),
      limit: z.number().int().positive().max(50).optional(),
      folder_id: idSchema.optional()
    }),
    description: 'Full-text search across notes; returns id, title, snippet, folder_path.'
  },
  vault_read_note: {
    input: z.object({ id: idSchema }),
    description: 'Read a note by id; returns full markdown content + metadata.'
  },
  vault_list_folder: {
    input: z.object({
      path: z.string().optional(),
      id: idSchema.optional(),
      recursive: z.boolean().optional()
    }),
    description: 'List folder contents (sub-folders and notes).'
  },
  vault_get_current_note: {
    input: z.object({}).default({}),
    description: 'Return the note currently open in the originating renderer window, or null.'
  },
  vault_list_tasks: {
    input: z.object({
      status: z.string().optional(),
      project_id: idSchema.optional(),
      due_before: z.string().optional(),
      tag: z.string().optional(),
      limit: z.number().int().positive().max(200).optional()
    }),
    description: 'List tasks with optional filters.'
  },
  vault_list_projects: {
    input: z.object({}).default({}),
    description: 'List all projects with task counts.'
  },
  vault_get_journal_entry: {
    input: z.object({ date: isoDateSchema }),
    description: 'Return the journal entry for an ISO date or null.'
  },
  vault_list_journal_entries: {
    input: z.object({
      from: isoDateSchema,
      to: isoDateSchema
    }),
    description: 'List journal entry summaries within a date range (inclusive).'
  },
  vault_list_inbox_items: {
    input: z.object({ unread_only: z.boolean().optional() }),
    description: 'List inbox items (unread first by default).'
  },
  vault_get_tags: {
    input: z.object({}).default({}),
    description: 'List all tags with usage counts.'
  },
  vault_create_note: {
    input: z.object({
      title: z.string().min(1),
      content_markdown: z.string(),
      folder_path: z.string().optional(),
      tags: z.array(z.string()).optional()
    }),
    description: 'Create a new note. Requires user approval.'
  },
  vault_create_task: {
    input: z.object({
      title: z.string().min(1),
      project_id: idSchema.optional(),
      due: z.string().optional(),
      priority: z.number().int().min(0).max(3).optional(),
      tags: z.array(z.string()).optional(),
      notes: z.string().optional()
    }),
    description: 'Create a new task. Requires user approval.'
  },
  vault_create_journal_entry: {
    input: z.object({
      date: isoDateSchema,
      content_markdown: z.string()
    }),
    description: 'Create or return existing journal entry for date. Requires user approval.'
  },
  vault_add_to_inbox: {
    input: z.object({
      source: z.string().min(1),
      title: z.string().min(1),
      content: z.string()
    }),
    description: 'Append a new inbox item. Requires user approval.'
  },
  vault_update_note: {
    input: z.object({
      id: idSchema,
      mode: z.enum(['append', 'prepend', 'replace']),
      content_markdown: z.string()
    }),
    description: 'Update note body. Requires user approval with diff preview.'
  },
  vault_update_task: {
    input: z.object({
      id: idSchema,
      title: z.string().optional(),
      status: z.string().optional(),
      project_id: idSchema.nullish(),
      due: z.string().nullish(),
      priority: z.number().int().min(0).max(3).optional(),
      notes: z.string().optional()
    }),
    description: 'Update task fields. Requires user approval with before/after preview.'
  },
  vault_add_tag: {
    input: z.object({
      id: idSchema,
      kind: z.enum(['note', 'task']),
      tag: z.string().min(1)
    }),
    description: 'Add a tag to a note or task. Requires user approval.'
  },
  vault_remove_tag: {
    input: z.object({
      id: idSchema,
      kind: z.enum(['note', 'task']),
      tag: z.string().min(1)
    }),
    description: 'Remove a tag from a note or task. Requires user approval.'
  },
  vault_move_to_folder: {
    input: z.object({ id: idSchema, folder_path: z.string().min(1) }),
    description: 'Move a note to a folder. Requires user approval.'
  }
} as const

export type ToolName = keyof typeof TOOL_SCHEMAS

export const READ_TOOL_NAMES: ToolName[] = [
  'vault_search_notes',
  'vault_read_note',
  'vault_list_folder',
  'vault_get_current_note',
  'vault_list_tasks',
  'vault_list_projects',
  'vault_get_journal_entry',
  'vault_list_journal_entries',
  'vault_list_inbox_items',
  'vault_get_tags'
]

export const WRITE_TOOL_NAMES: ToolName[] = [
  'vault_create_note',
  'vault_create_task',
  'vault_create_journal_entry',
  'vault_add_to_inbox',
  'vault_update_note',
  'vault_update_task',
  'vault_add_tag',
  'vault_remove_tag',
  'vault_move_to_folder'
]

export const CREATE_TOOL_NAMES: ToolName[] = [
  'vault_create_note',
  'vault_create_task',
  'vault_create_journal_entry',
  'vault_add_to_inbox'
]

export const UPDATE_TOOL_NAMES: ToolName[] = [
  'vault_update_note',
  'vault_update_task',
  'vault_add_tag',
  'vault_remove_tag',
  'vault_move_to_folder'
]

export const ALL_TOOL_NAMES: ToolName[] = [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES]
