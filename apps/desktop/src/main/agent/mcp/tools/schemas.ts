import { z } from 'zod'
import {
  AgentMcpDesktopReadOperations,
  AgentMcpDesktopWriteOperations
} from '@memry/contracts/agent-mcp-channels'
import {
  CanvasDrawElementSchema,
  CanvasElementEditSchema,
  MAX_DRAW_ELEMENTS,
  MAX_EDIT_ELEMENTS
} from '@memry/contracts/canvas-draw'
import { NoteFileTypeEnum } from '@memry/contracts/search-api'

const idSchema = z.string().min(1)
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const isoTimeSchema = z.string().regex(/^\d{2}:\d{2}$/)
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const unknownRecordSchema = z.record(z.string(), z.unknown())
const repeatConfigSchema = unknownRecordSchema
const statusDefinitionInputSchema = z.object({
  id: idSchema.optional(),
  name: z.string().min(1).max(50),
  color: colorSchema.default('#6b7280'),
  type: z.enum(['todo', 'in_progress', 'done']),
  order: z.number().int().min(0)
})
const taskPatchSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  status: z.string().optional(),
  status_id: idSchema.nullish(),
  project_id: idSchema.nullish(),
  parent_id: idSchema.nullish(),
  due: isoDateSchema.nullish(),
  due_date: isoDateSchema.nullish(),
  due_time: isoTimeSchema.nullish(),
  start_date: isoDateSchema.nullish(),
  priority: z.number().int().min(0).max(4).optional(),
  notes: z.string().max(10000).nullish(),
  description: z.string().max(10000).nullish(),
  is_repeating: z.boolean().optional(),
  repeat_config: repeatConfigSchema.nullish(),
  repeat_from: z.enum(['due', 'completion']).nullish(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  linked_note_ids: z.array(idSchema).optional()
})
const projectCreateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullish(),
  color: colorSchema.default('#6366f1'),
  icon: z.string().nullish(),
  statuses: z.array(statusDefinitionInputSchema).min(2).optional()
})
const projectUpdateSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullish(),
  color: colorSchema.optional(),
  icon: z.string().nullish(),
  statuses: z.array(statusDefinitionInputSchema).min(2).optional()
})
const statusCreateSchema = z.object({
  project_id: idSchema,
  name: z.string().min(1).max(50),
  color: colorSchema.default('#6b7280'),
  is_done: z.boolean().default(false)
})
const statusUpdateSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(50).optional(),
  color: colorSchema.optional(),
  position: z.number().int().optional(),
  is_default: z.boolean().optional(),
  is_done: z.boolean().optional()
})
const desktopReadSchema = z.object({
  operation: z.enum(AgentMcpDesktopReadOperations),
  args: z.array(z.unknown()).default([])
})
const desktopWriteSchema = z.object({
  operation: z.enum(AgentMcpDesktopWriteOperations),
  args: z.array(z.unknown()).default([])
})

export const TOOL_SCHEMAS = {
  vault_search_notes: {
    input: z.object({
      query: z.string().min(1),
      limit: z.number().int().positive().max(50).optional(),
      folder_id: idSchema.optional(),
      file_types: z.array(NoteFileTypeEnum).min(1).optional()
    }),
    description:
      'Full-text search across notes and filed files; returns id, title, snippet, folder_path, ' +
      'file_type. A file_type other than "markdown" (pdf/image/audio/video) is a filed file, not ' +
      'a note — vault_read_note rejects those. Pass file_types to restrict the search, e.g. ' +
      '["markdown"] for notes only; omitted returns every file type.'
  },
  vault_read_note: {
    input: z.object({ id: idSchema }),
    description:
      'Read a markdown note by id; returns full markdown content + metadata. Errors with ' +
      'VALIDATION when the id belongs to a filed pdf/image/audio/video file.'
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
  vault_get_task: {
    input: z.object({ id: idSchema }),
    description: 'Read a task by id.'
  },
  vault_list_projects: {
    input: z.object({}).default({}),
    description: 'List all projects with task counts and linked note/file/event counts.'
  },
  vault_get_project: {
    input: z.object({ id: idSchema }),
    description: 'Read a project by id.'
  },
  vault_list_statuses: {
    input: z.object({ project_id: idSchema }),
    description: 'List statuses for a project.'
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
  vault_get_inbox_item: {
    input: z.object({ id: idSchema }),
    description: 'Read an inbox item by id.'
  },
  vault_get_tags: {
    input: z.object({}).default({}),
    description:
      'List all tags with usage counts, color, icon, sort order, and the tag category they ' +
      'belong to (category_id and category_name, both null when uncategorized).'
  },
  vault_list_canvases: {
    input: z.object({}).default({}),
    description:
      'List spatial canvases with how many notes/tasks/events sit on each. ' +
      'Never returns scene geometry.'
  },
  vault_read_canvas: {
    input: z.object({ id: idSchema }),
    description:
      'Read one canvas: title, the entities on it (with titles), and any text written on it. ' +
      'Returns no scene geometry — use vault_add_canvas_item to change what is on it.'
  },
  vault_read_canvas_elements: {
    input: z.object({ id: idSchema }),
    description:
      'Read the SHAPES on a canvas: every element with its id, type, position, size, text, ' +
      'colors, arrow bindings and frame. This is the read to use before drawing — an element ' +
      'id from here is what vault_draw_on_canvas binds an arrow to and what ' +
      'vault_edit_canvas_elements changes. Cards carry entity_type/entity_id. Use ' +
      'vault_read_canvas instead when you only need to know WHICH notes/tasks/events are on it.'
  },
  vault_desktop_read: {
    input: desktopReadSchema,
    description:
      'Run an allowlisted read-only desktop API operation through the memrynote window. ' +
      'Calendar examples: calendar.listEvents with args [{}], calendar.getRange with args ' +
      '[{"startAt":"2026-05-14T00:00:00.000Z","endAt":"2026-06-15T00:00:00.000Z"}].'
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
  vault_rename_note: {
    input: z.object({ id: idSchema, title: z.string().min(1).max(200) }),
    description: 'Rename a note. Requires user approval.'
  },
  vault_delete_note: {
    input: z.object({ id: idSchema }),
    description: 'Delete a note. Requires user approval.'
  },
  vault_create_folder: {
    input: z.object({ path: z.string().min(1) }),
    description: 'Create a note folder. Requires user approval.'
  },
  vault_rename_folder: {
    input: z.object({ old_path: z.string().min(1), new_path: z.string().min(1) }),
    description: 'Rename a note folder. Requires user approval.'
  },
  vault_delete_folder: {
    input: z.object({ path: z.string().min(1) }),
    description: 'Delete a note folder and its contents. Requires user approval.'
  },
  vault_create_task: {
    input: taskPatchSchema
      .extend({
        title: z.string().min(1).max(500),
        source_note_id: idSchema.nullish(),
        position: z.number().int().optional()
      })
      .omit({ status: true }),
    description: 'Create a new task. Requires user approval.'
  },
  vault_delete_task: {
    input: z.object({ id: idSchema }),
    description: 'Delete a task. Requires user approval.'
  },
  vault_complete_task: {
    input: z.object({ id: idSchema, completed_at: z.string().datetime().optional() }),
    description: 'Complete a task. Requires user approval.'
  },
  vault_uncomplete_task: {
    input: z.object({ id: idSchema }),
    description: 'Reopen a completed task. Requires user approval.'
  },
  vault_archive_task: {
    input: z.object({ id: idSchema }),
    description: 'Archive a task. Requires user approval.'
  },
  vault_unarchive_task: {
    input: z.object({ id: idSchema }),
    description: 'Unarchive a task. Requires user approval.'
  },
  vault_move_task: {
    input: z.object({
      task_id: idSchema,
      target_project_id: idSchema.optional(),
      target_status_id: idSchema.nullish(),
      target_parent_id: idSchema.nullish(),
      position: z.number().int()
    }),
    description: 'Move a task between projects/statuses/parents. Requires user approval.'
  },
  vault_reorder_tasks: {
    input: z.object({
      task_ids: z.array(idSchema),
      positions: z.array(z.number().int())
    }),
    description: 'Reorder tasks. Requires user approval.'
  },
  vault_duplicate_task: {
    input: z.object({ id: idSchema }),
    description: 'Duplicate a task with subtasks. Requires user approval.'
  },
  vault_convert_task_to_subtask: {
    input: z.object({ task_id: idSchema, parent_id: idSchema }),
    description: 'Convert a task into a subtask. Requires user approval.'
  },
  vault_convert_subtask_to_task: {
    input: z.object({ id: idSchema }),
    description: 'Convert a subtask back to a top-level task. Requires user approval.'
  },
  vault_create_project: {
    input: projectCreateSchema,
    description: 'Create a task project. Requires user approval.'
  },
  vault_update_project: {
    input: projectUpdateSchema,
    description: 'Update a task project. Requires user approval.'
  },
  vault_delete_project: {
    input: z.object({ id: idSchema }),
    description: 'Delete a task project. Requires user approval.'
  },
  vault_archive_project: {
    input: z.object({ id: idSchema }),
    description: 'Archive a task project. Requires user approval.'
  },
  vault_reorder_projects: {
    input: z.object({
      project_ids: z.array(idSchema),
      positions: z.array(z.number().int())
    }),
    description: 'Reorder task projects. Requires user approval.'
  },
  vault_create_status: {
    input: statusCreateSchema,
    description: 'Create a project status. Requires user approval.'
  },
  vault_update_status: {
    input: statusUpdateSchema,
    description: 'Update a project status. Requires user approval.'
  },
  vault_delete_status: {
    input: z.object({ id: idSchema }),
    description: 'Delete a project status. Requires user approval.'
  },
  vault_reorder_statuses: {
    input: z.object({
      status_ids: z.array(idSchema),
      positions: z.array(z.number().int())
    }),
    description: 'Reorder project statuses. Requires user approval.'
  },
  vault_create_journal_entry: {
    input: z.object({
      date: isoDateSchema,
      content_markdown: z.string()
    }),
    description: 'Create or return existing journal entry for date. Requires user approval.'
  },
  vault_update_journal_entry: {
    input: z.object({
      date: isoDateSchema,
      content_markdown: z.string().optional(),
      tags: z.array(z.string()).optional(),
      properties: unknownRecordSchema.optional()
    }),
    description: 'Update or create a journal entry. Requires user approval.'
  },
  vault_delete_journal_entry: {
    input: z.object({ date: isoDateSchema }),
    description: 'Delete a journal entry. Requires user approval.'
  },
  vault_add_to_inbox: {
    input: z.object({
      source: z.string().min(1),
      title: z.string().min(1),
      content: z.string()
    }),
    description: 'Append a new inbox item. Requires user approval.'
  },
  vault_update_inbox_item: {
    input: z.object({
      id: idSchema,
      title: z.string().min(1).max(200).optional(),
      content: z.string().max(50000).optional()
    }),
    description: 'Update an inbox item. Requires user approval.'
  },
  vault_snooze_inbox_item: {
    input: z.object({
      id: idSchema,
      snooze_until: z.string().datetime(),
      reason: z.string().max(500).optional()
    }),
    description: 'Snooze an inbox item until an ISO datetime. Requires user approval.'
  },
  vault_archive_inbox_item: {
    input: z.object({ id: idSchema }),
    description: 'Archive an inbox item. Requires user approval.'
  },
  vault_unarchive_inbox_item: {
    input: z.object({ id: idSchema }),
    description: 'Unarchive an inbox item. Requires user approval.'
  },
  vault_delete_inbox_item: {
    input: z.object({ id: idSchema }),
    description: 'Permanently delete an inbox item. Requires user approval.'
  },
  vault_add_inbox_tag: {
    input: z.object({ id: idSchema, tag: z.string().min(1) }),
    description: 'Add a tag to an inbox item. Requires user approval.'
  },
  vault_remove_inbox_tag: {
    input: z.object({ id: idSchema, tag: z.string().min(1) }),
    description: 'Remove a tag from an inbox item. Requires user approval.'
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
    input: taskPatchSchema.extend({ id: idSchema }),
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
  },
  vault_add_canvas_item: {
    input: z.object({
      canvas_id: idSchema,
      items: z
        .array(
          z.object({
            entity_type: z.enum(['note', 'task', 'calendar_event']),
            entity_id: idSchema
          })
        )
        .min(1)
        .max(20)
    }),
    description:
      'Put existing notes/tasks/events on a canvas as cards. Applies to the open editor when ' +
      'the user has that canvas open. Requires user approval.'
  },
  vault_remove_canvas_item: {
    input: z.object({
      canvas_id: idSchema,
      entity_type: z.enum(['note', 'task', 'calendar_event']),
      entity_id: idSchema
    }),
    description:
      "Remove an entity's card from a canvas, clearing any arrows bound to it. " +
      'The note/task/event itself is not deleted. Requires user approval.'
  },
  vault_create_canvas: {
    input: z.object({ title: z.string().min(1).max(200).optional() }),
    description: 'Create an empty spatial canvas and return its id. Requires user approval.'
  },
  vault_draw_on_canvas: {
    input: z.object({
      canvas_id: idSchema,
      elements: z.array(CanvasDrawElementSchema).min(1).max(MAX_DRAW_ELEMENTS)
    }),
    description:
      'Draw on a canvas: rectangles, ellipses, diamonds, text, arrows, lines, freedraw, ' +
      "frames, images and embeds. Element fields are Excalidraw's own skeleton fields in " +
      'camelCase (strokeColor, backgroundColor, fillStyle, strokeWidth, strokeStyle, ' +
      'roughness, opacity, roundness, fontSize, points, ...), so a shape is e.g. ' +
      '{"type":"rectangle","x":0,"y":0,"width":240,"height":120,"backgroundColor":"#ffec99",' +
      '"label":{"text":"Chapter 1"}}. Give an element a "ref" to point arrows at it or put it ' +
      'in a frame within the same call; bind to something already on the canvas with ' +
      '{"elementId":"..."} from vault_read_canvas_elements. An arrow with start and end is a ' +
      'REAL binding — it follows the shapes when the user drags them: ' +
      '{"type":"arrow","start":{"ref":"a"},"end":{"elementId":"..."},"endArrowhead":"arrow",' +
      '"label":{"text":"leads to"}}. Coordinates are scene coordinates; x/y default to 0, so ' +
      'read the canvas first and place relative to what is there. To put a note/task/event on ' +
      'the canvas use vault_add_canvas_item — this tool cannot mint entity cards. Images need ' +
      'a fileId already attached to the canvas. Requires user approval.'
  },
  vault_edit_canvas_elements: {
    input: z.object({
      canvas_id: idSchema,
      edits: z.array(CanvasElementEditSchema).min(1).max(MAX_EDIT_ELEMENTS)
    }),
    description:
      'Move, restyle, retext or delete elements already on a canvas, by element id from ' +
      'vault_read_canvas_elements. Absent fields are left alone; {"delete":true} removes the ' +
      'element and clears any arrow bound to it. Works on entity cards too (move and restyle ' +
      'them), except their text, which lives in the note. Requires user approval.'
  },
  vault_desktop_write: {
    input: desktopWriteSchema,
    description: 'Run an allowlisted desktop CRUD mutation. Requires user approval.'
  }
} as const

export type ToolName = keyof typeof TOOL_SCHEMAS

export const READ_TOOL_NAMES = [
  'vault_search_notes',
  'vault_read_note',
  'vault_list_folder',
  'vault_get_current_note',
  'vault_list_tasks',
  'vault_get_task',
  'vault_list_projects',
  'vault_get_project',
  'vault_list_statuses',
  'vault_get_journal_entry',
  'vault_list_journal_entries',
  'vault_list_inbox_items',
  'vault_get_inbox_item',
  'vault_get_tags',
  'vault_list_canvases',
  'vault_read_canvas',
  'vault_read_canvas_elements',
  'vault_desktop_read'
] as const satisfies readonly ToolName[]

export const WRITE_TOOL_NAMES = [
  'vault_create_note',
  'vault_rename_note',
  'vault_delete_note',
  'vault_create_folder',
  'vault_rename_folder',
  'vault_delete_folder',
  'vault_create_task',
  'vault_delete_task',
  'vault_complete_task',
  'vault_uncomplete_task',
  'vault_archive_task',
  'vault_unarchive_task',
  'vault_move_task',
  'vault_reorder_tasks',
  'vault_duplicate_task',
  'vault_convert_task_to_subtask',
  'vault_convert_subtask_to_task',
  'vault_create_project',
  'vault_update_project',
  'vault_delete_project',
  'vault_archive_project',
  'vault_reorder_projects',
  'vault_create_status',
  'vault_update_status',
  'vault_delete_status',
  'vault_reorder_statuses',
  'vault_create_journal_entry',
  'vault_update_journal_entry',
  'vault_delete_journal_entry',
  'vault_add_to_inbox',
  'vault_update_inbox_item',
  'vault_snooze_inbox_item',
  'vault_archive_inbox_item',
  'vault_unarchive_inbox_item',
  'vault_delete_inbox_item',
  'vault_add_inbox_tag',
  'vault_remove_inbox_tag',
  'vault_update_note',
  'vault_update_task',
  'vault_add_tag',
  'vault_remove_tag',
  'vault_move_to_folder',
  'vault_add_canvas_item',
  'vault_remove_canvas_item',
  'vault_create_canvas',
  'vault_draw_on_canvas',
  'vault_edit_canvas_elements',
  'vault_desktop_write'
] as const satisfies readonly ToolName[]

export const CREATE_TOOL_NAMES = [
  'vault_create_note',
  'vault_create_folder',
  'vault_create_task',
  'vault_create_project',
  'vault_create_status',
  'vault_create_journal_entry',
  'vault_add_to_inbox',
  'vault_create_canvas'
] as const satisfies readonly ToolName[]

export const UPDATE_TOOL_NAMES = [
  'vault_rename_note',
  'vault_delete_note',
  'vault_rename_folder',
  'vault_delete_folder',
  'vault_delete_task',
  'vault_complete_task',
  'vault_uncomplete_task',
  'vault_archive_task',
  'vault_unarchive_task',
  'vault_move_task',
  'vault_reorder_tasks',
  'vault_duplicate_task',
  'vault_convert_task_to_subtask',
  'vault_convert_subtask_to_task',
  'vault_update_project',
  'vault_delete_project',
  'vault_archive_project',
  'vault_reorder_projects',
  'vault_update_status',
  'vault_delete_status',
  'vault_reorder_statuses',
  'vault_update_journal_entry',
  'vault_delete_journal_entry',
  'vault_update_inbox_item',
  'vault_snooze_inbox_item',
  'vault_archive_inbox_item',
  'vault_unarchive_inbox_item',
  'vault_delete_inbox_item',
  'vault_add_inbox_tag',
  'vault_remove_inbox_tag',
  'vault_update_note',
  'vault_update_task',
  'vault_add_tag',
  'vault_remove_tag',
  'vault_move_to_folder',
  'vault_add_canvas_item',
  'vault_remove_canvas_item',
  'vault_draw_on_canvas',
  'vault_edit_canvas_elements',
  'vault_desktop_write'
] as const satisfies readonly ToolName[]

export const ALL_TOOL_NAMES = [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES] as const
