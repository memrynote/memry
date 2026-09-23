import type {
  ChangePreview,
  ChangePreviewField,
  ChangePreviewIntent,
  ChangePreviewItemType,
  ChangePreviewKind
} from '@memry/contracts/ipc-agent'

import type { VaultServiceHandles } from '../mcp/tools/handles'
import {
  asRecord,
  countWords,
  displayValue,
  excerpt,
  field,
  fields,
  mergeContent,
  optionalField
} from './format'

/**
 * Builds the preview the approval card draws for one pending write.
 *
 * Every builder reads the item's current state through the same handle the
 * write itself would use, so the "before" column is what the write is actually
 * about to land on rather than whatever the agent last saw. The read is not
 * free, but it is the read the write would have done anyway, and its result is
 * also the snapshot an undo needs.
 *
 * The `kind` a builder returns is authoritative. `WRITE_TOOL_PREVIEW_KINDS`
 * decides *that* a preview is owed and what it will roughly look like, while a
 * builder that finds no body to diff can still answer `fields` for the same
 * tool.
 */
export async function buildChangePreview(
  toolName: string,
  rawArgs: unknown,
  handles: VaultServiceHandles
): Promise<ChangePreview> {
  const args = asRecord(rawArgs)
  const builder = BUILDERS[toolName]
  if (!builder) return genericPreview(toolName, args)
  return builder(args, handles)
}

type Builder = (
  args: Record<string, unknown>,
  handles: VaultServiceHandles
) => Promise<ChangePreview>

function make(input: {
  kind: ChangePreviewKind
  type: ChangePreviewItemType
  id?: string | null
  title: string
  context?: string | null
  intent: ChangePreviewIntent
  fields?: ChangePreviewField[]
  body?: { current: string; candidate: string } | null
  loss?: string[]
  destructive?: boolean
}): ChangePreview {
  return {
    kind: input.kind,
    item: {
      type: input.type,
      id: input.id ?? null,
      title: input.title,
      context: input.context ?? null
    },
    intent: input.intent,
    fields: input.fields ?? [],
    body: input.body ?? null,
    loss: input.loss ?? [],
    destructive: input.destructive ?? false
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : []
}

/**
 * A tool the builders have not been taught about individually. It still names
 * the operation and its arguments rather than rendering nothing: a card with no
 * content is worse than a coarse one, because the user cannot tell whether the
 * write is small or the preview is broken.
 */
function genericPreview(toolName: string, args: Record<string, unknown>): ChangePreview {
  const rows = Object.entries(args)
    .map(([key, value]) => field(key, null, value))
    .filter((row): row is ChangePreviewField => Boolean(row))
  return make({
    kind: 'fields',
    type: 'note',
    title: toolName,
    intent: 'update',
    fields: rows
  })
}

// ---------------------------------------------------------------- notes

const createNote: Builder = async (args) => {
  const content = str(args.content_markdown)
  return make({
    kind: 'body',
    type: 'note',
    title: str(args.title),
    context: displayValue(args.folder_path),
    intent: 'create',
    fields: fields(field('tags', null, args.tags)),
    body: { current: '', candidate: content }
  })
}

const updateNote: Builder = async (args, handles) => {
  const id = str(args.id)
  const note = await handles.notes.read(id)
  if (!note) throw new Error(`Note not found: ${id}`)
  const mode = args.mode === 'append' || args.mode === 'prepend' ? args.mode : 'replace'
  return make({
    kind: 'body',
    type: 'note',
    id,
    title: note.title,
    context: note.folder_path,
    intent: 'update',
    body: {
      current: note.content_markdown,
      candidate: mergeContent(note.content_markdown, mode, str(args.content_markdown))
    }
  })
}

const renameNote: Builder = async (args, handles) => {
  const id = str(args.id)
  const note = await handles.notes.read(id)
  return make({
    kind: 'fields',
    type: 'note',
    id,
    title: note?.title ?? str(args.title),
    context: note?.folder_path ?? null,
    intent: 'update',
    fields: fields(field('title', note?.title, args.title))
  })
}

const moveNote: Builder = async (args, handles) => {
  const id = str(args.id)
  const note = await handles.notes.read(id)
  return make({
    kind: 'fields',
    type: 'note',
    id,
    title: note?.title ?? id,
    context: note?.folder_path ?? null,
    intent: 'move',
    fields: fields(field('folder', note?.folder_path, args.folder_path))
  })
}

const deleteNote: Builder = async (args, handles) => {
  const id = str(args.id)
  const note = await handles.notes.read(id)
  const loss: string[] = []
  if (note) {
    loss.push(`words:${countWords(note.content_markdown)}`)
    if (note.tags.length > 0) loss.push(`tags:${note.tags.length}`)
    const body = excerpt(note.content_markdown)
    if (body) loss.push(`excerpt:${body}`)
  }
  return make({
    kind: 'loss',
    type: 'note',
    id,
    title: note?.title ?? id,
    context: note?.folder_path ?? null,
    intent: 'delete',
    loss,
    destructive: true
  })
}

// -------------------------------------------------------------- folders

const createFolder: Builder = async (args) =>
  make({
    kind: 'fields',
    type: 'folder',
    title: str(args.path),
    intent: 'create',
    fields: fields(field('path', null, args.path))
  })

const renameFolder: Builder = async (args) =>
  make({
    kind: 'fields',
    type: 'folder',
    title: str(args.new_path),
    intent: 'move',
    fields: fields(field('path', args.old_path, args.new_path))
  })

const deleteFolder: Builder = async (args, handles) => {
  const path = str(args.path)
  const entries = await handles.folders.list({ path, recursive: true })
  const notes = entries.filter((entry) => entry.kind === 'note').length
  const folders = entries.filter((entry) => entry.kind === 'folder').length
  const loss: string[] = []
  if (notes > 0) loss.push(`notes:${notes}`)
  if (folders > 0) loss.push(`folders:${folders}`)
  return make({
    kind: 'loss',
    type: 'folder',
    title: path,
    intent: 'delete',
    loss,
    destructive: true
  })
}

// ---------------------------------------------------------------- tasks

async function readTask(
  handles: VaultServiceHandles,
  id: string
): Promise<Record<string, unknown>> {
  return asRecord(await handles.tasks.get(id))
}

function taskTitle(task: Record<string, unknown>, fallback: string): string {
  return typeof task.title === 'string' && task.title.length > 0 ? task.title : fallback
}

const createTask: Builder = async (args) =>
  make({
    kind: 'fields',
    type: 'task',
    title: str(args.title),
    intent: 'create',
    fields: fields(
      optionalField('project', null, args.project_id),
      optionalField('status', null, args.status_id),
      optionalField('parent', null, args.parent_id),
      optionalField('due_date', null, args.due_date ?? args.due),
      optionalField('due_time', null, args.due_time),
      optionalField('start_date', null, args.start_date),
      optionalField('priority', null, args.priority),
      optionalField('tags', null, args.tags),
      optionalField('description', null, args.description ?? args.notes)
    )
  })

const updateTask: Builder = async (args, handles) => {
  const id = str(args.id)
  const task = await readTask(handles, id)
  return make({
    kind: 'fields',
    type: 'task',
    id,
    title: taskTitle(task, id),
    context: displayValue(task.projectId),
    intent: 'update',
    fields: fields(
      optionalField('title', task.title, args.title),
      optionalField('status', task.statusId, args.status_id ?? args.status),
      optionalField('project', task.projectId, args.project_id),
      optionalField('parent', task.parentId, args.parent_id),
      optionalField('due_date', task.dueDate, args.due_date ?? args.due),
      optionalField('due_time', task.dueTime, args.due_time),
      optionalField('start_date', task.startDate, args.start_date),
      optionalField('priority', task.priority, args.priority),
      optionalField('description', task.description, args.description ?? args.notes),
      optionalField('tags', task.tags, args.tags),
      optionalField('repeat_from', task.repeatFrom, args.repeat_from)
    )
  })
}

/** complete, uncomplete, archive, unarchive: one state column each. */
function taskStateBuilder(key: 'completed_at' | 'archived_at', set: boolean): Builder {
  return async (args, handles) => {
    const id = str(args.id)
    const task = await readTask(handles, id)
    const before = key === 'completed_at' ? task.completedAt : task.archivedAt
    const after = set ? (displayValue(args.completed_at) ?? 'now') : null
    return make({
      kind: 'fields',
      type: 'task',
      id,
      title: taskTitle(task, id),
      context: displayValue(task.projectId),
      intent: 'update',
      fields: fields(field(key, before, after))
    })
  }
}

const moveTask: Builder = async (args, handles) => {
  const id = str(args.task_id)
  const task = await readTask(handles, id)
  return make({
    kind: 'fields',
    type: 'task',
    id,
    title: taskTitle(task, id),
    context: displayValue(task.projectId),
    intent: 'move',
    fields: fields(
      optionalField('project', task.projectId, args.target_project_id),
      optionalField('status', task.statusId, args.target_status_id),
      optionalField('parent', task.parentId, args.target_parent_id),
      optionalField('position', task.position, args.position)
    )
  })
}

const convertToSubtask: Builder = async (args, handles) => {
  const id = str(args.task_id)
  const task = await readTask(handles, id)
  return make({
    kind: 'fields',
    type: 'task',
    id,
    title: taskTitle(task, id),
    intent: 'move',
    fields: fields(field('parent', task.parentId, args.parent_id))
  })
}

const convertToTask: Builder = async (args, handles) => {
  const id = str(args.id)
  const task = await readTask(handles, id)
  return make({
    kind: 'fields',
    type: 'task',
    id,
    title: taskTitle(task, id),
    intent: 'move',
    fields: fields(field('parent', task.parentId, null))
  })
}

const duplicateTask: Builder = async (args, handles) => {
  const id = str(args.id)
  const task = await readTask(handles, id)
  const title = taskTitle(task, id)
  return make({
    kind: 'fields',
    type: 'task',
    id,
    title,
    context: displayValue(task.projectId),
    intent: 'create',
    fields: fields(field('duplicate_of', null, title))
  })
}

const deleteTask: Builder = async (args, handles) => {
  const id = str(args.id)
  const task = await readTask(handles, id)
  const loss: string[] = []
  const description = displayValue(task.description)
  if (description) {
    const body = excerpt(description)
    if (body) loss.push(`excerpt:${body}`)
  }
  const due = displayValue(task.dueDate)
  if (due) loss.push(`due:${due}`)
  return make({
    kind: 'loss',
    type: 'task',
    id,
    title: taskTitle(task, id),
    context: displayValue(task.projectId),
    intent: 'delete',
    loss,
    destructive: true
  })
}

/**
 * Reordering has no meaningful before and after per item, so the card names the
 * new sequence instead. Listing the ids the agent asked for is deliberately the
 * whole of it: resolving every one to a title would be a read per row on the
 * one write where the individual rows are not what changed.
 */
function reorderBuilder(type: ChangePreviewItemType, idsKey: string): Builder {
  return async (args) => {
    const ids = Array.isArray(args[idsKey]) ? (args[idsKey] as unknown[]) : []
    return make({
      kind: 'fields',
      type,
      title: `${ids.length}`,
      intent: 'reorder',
      fields: fields(field('order', null, ids))
    })
  }
}

// ------------------------------------------------------------- projects

const createProject: Builder = async (args) =>
  make({
    kind: 'fields',
    type: 'project',
    title: str(args.name),
    intent: 'create',
    fields: fields(
      optionalField('description', null, args.description),
      optionalField('color', null, args.color),
      optionalField('icon', null, args.icon)
    )
  })

const updateProject: Builder = async (args, handles) => {
  const id = str(args.id)
  const project = asRecord(await handles.projects.get(id))
  return make({
    kind: 'fields',
    type: 'project',
    id,
    title: displayValue(project.name) ?? id,
    intent: 'update',
    fields: fields(
      optionalField('name', project.name, args.name),
      optionalField('description', project.description, args.description),
      optionalField('color', project.color, args.color),
      optionalField('icon', project.icon, args.icon)
    )
  })
}

const archiveProject: Builder = async (args, handles) => {
  const id = str(args.id)
  const project = asRecord(await handles.projects.get(id))
  return make({
    kind: 'fields',
    type: 'project',
    id,
    title: displayValue(project.name) ?? id,
    intent: 'update',
    fields: fields(field('archived_at', project.archivedAt, 'now'))
  })
}

const deleteProject: Builder = async (args, handles) => {
  const id = str(args.id)
  const projects = await handles.projects.list()
  const project = projects.find((entry) => entry.id === id)
  const loss: string[] = []
  if (project) {
    if (project.task_count > 0) loss.push(`tasks:${project.task_count}`)
    if (project.linked_counts.notes > 0) loss.push(`notes:${project.linked_counts.notes}`)
    if (project.linked_counts.files > 0) loss.push(`files:${project.linked_counts.files}`)
    if (project.linked_counts.events > 0) loss.push(`events:${project.linked_counts.events}`)
  }
  return make({
    kind: 'loss',
    type: 'project',
    id,
    title: project?.name ?? id,
    intent: 'delete',
    loss,
    destructive: true
  })
}

// ------------------------------------------------------------- statuses

const createStatus: Builder = async (args) =>
  make({
    kind: 'fields',
    type: 'status',
    title: str(args.name),
    context: displayValue(args.project_id),
    intent: 'create',
    fields: fields(
      optionalField('color', null, args.color),
      optionalField('is_done', null, args.is_done)
    )
  })

const updateStatus: Builder = async (args) =>
  make({
    kind: 'fields',
    type: 'status',
    id: str(args.id),
    title: displayValue(args.name) ?? str(args.id),
    intent: 'update',
    fields: fields(
      optionalField('name', null, args.name),
      optionalField('color', null, args.color),
      optionalField('position', null, args.position),
      optionalField('is_default', null, args.is_default),
      optionalField('is_done', null, args.is_done)
    )
  })

const deleteStatus: Builder = async (args) =>
  make({
    kind: 'loss',
    type: 'status',
    id: str(args.id),
    title: str(args.id),
    intent: 'delete',
    destructive: true
  })

// -------------------------------------------------------------- journal

const createJournalEntry: Builder = async (args, handles) => {
  const date = str(args.date)
  const existing = await handles.journal.getByDate(date)
  return make({
    kind: 'body',
    type: 'journal',
    id: existing?.id ?? null,
    title: date,
    intent: existing ? 'update' : 'create',
    body: {
      current: existing?.content_markdown ?? '',
      candidate: existing?.content_markdown ?? str(args.content_markdown)
    }
  })
}

const updateJournalEntry: Builder = async (args, handles) => {
  const date = str(args.date)
  const existing = await handles.journal.getByDate(date)
  const current = existing?.content_markdown ?? ''
  const next = args.content_markdown === undefined ? current : str(args.content_markdown)
  return make({
    kind: 'body',
    type: 'journal',
    id: existing?.id ?? null,
    title: date,
    intent: 'update',
    fields: fields(optionalField('tags', null, args.tags)),
    body: { current, candidate: next }
  })
}

const deleteJournalEntry: Builder = async (args, handles) => {
  const date = str(args.date)
  const existing = await handles.journal.getByDate(date)
  const loss: string[] = []
  if (existing) {
    loss.push(`words:${countWords(existing.content_markdown)}`)
    const body = excerpt(existing.content_markdown)
    if (body) loss.push(`excerpt:${body}`)
  }
  return make({
    kind: 'loss',
    type: 'journal',
    id: existing?.id ?? null,
    title: date,
    intent: 'delete',
    loss,
    destructive: true
  })
}

// ---------------------------------------------------------------- inbox

async function readInbox(
  handles: VaultServiceHandles,
  id: string
): Promise<Record<string, unknown>> {
  return asRecord(await handles.inbox.get(id))
}

function inboxTitle(item: Record<string, unknown>, fallback: string): string {
  return displayValue(item.title) ?? fallback
}

const addToInbox: Builder = async (args) =>
  make({
    kind: 'body',
    type: 'inbox',
    title: str(args.title),
    context: displayValue(args.source),
    intent: 'create',
    body: { current: '', candidate: str(args.content) }
  })

/**
 * Body when the content moves, fields when only the title does. The tool can do
 * either, and a title rename does not deserve a text diff pane.
 */
const updateInboxItem: Builder = async (args, handles) => {
  const id = str(args.id)
  const item = await readInbox(handles, id)
  const current = displayValue(item.content) ?? ''
  const contentChanges = args.content !== undefined && str(args.content) !== current
  return make({
    kind: contentChanges ? 'body' : 'fields',
    type: 'inbox',
    id,
    title: inboxTitle(item, id),
    context: displayValue(item.source),
    intent: 'update',
    fields: fields(optionalField('title', item.title, args.title)),
    body: contentChanges ? { current, candidate: str(args.content) } : null
  })
}

const snoozeInboxItem: Builder = async (args, handles) => {
  const id = str(args.id)
  const item = await readInbox(handles, id)
  return make({
    kind: 'fields',
    type: 'inbox',
    id,
    title: inboxTitle(item, id),
    intent: 'update',
    fields: fields(
      field('snoozed_until', item.snoozedUntil, args.snooze_until),
      optionalField('snooze_reason', item.snoozeReason, args.reason)
    )
  })
}

function inboxArchiveBuilder(set: boolean): Builder {
  return async (args, handles) => {
    const id = str(args.id)
    const item = await readInbox(handles, id)
    return make({
      kind: 'fields',
      type: 'inbox',
      id,
      title: inboxTitle(item, id),
      intent: 'update',
      fields: fields(field('archived_at', item.archivedAt, set ? 'now' : null))
    })
  }
}

const deleteInboxItem: Builder = async (args, handles) => {
  const id = str(args.id)
  const item = await readInbox(handles, id)
  const loss: string[] = []
  const content = displayValue(item.content)
  if (content) {
    loss.push(`words:${countWords(content)}`)
    const body = excerpt(content)
    if (body) loss.push(`excerpt:${body}`)
  }
  return make({
    kind: 'loss',
    type: 'inbox',
    id,
    title: inboxTitle(item, id),
    context: displayValue(item.source),
    intent: 'delete',
    loss,
    destructive: true
  })
}

function inboxTagBuilder(add: boolean): Builder {
  return async (args, handles) => {
    const id = str(args.id)
    const item = await readInbox(handles, id)
    const before = stringList(item.tags)
    const tag = str(args.tag)
    const after = add ? [...before, tag] : before.filter((entry) => entry !== tag)
    return make({
      kind: 'fields',
      type: 'inbox',
      id,
      title: inboxTitle(item, id),
      intent: 'update',
      fields: fields(field('tags', before, after))
    })
  }
}

// ----------------------------------------------------------------- tags

/** `vault_add_tag` and `vault_remove_tag` address notes and tasks both. */
function tagBuilder(add: boolean): Builder {
  return async (args, handles) => {
    const id = str(args.id)
    const tag = str(args.tag)
    const onTask = args.kind === 'task'

    let title: string
    let before: string[]
    if (onTask) {
      const task = await readTask(handles, id)
      title = taskTitle(task, id)
      before = stringList(task.tags)
    } else {
      const note = await handles.notes.read(id)
      title = note?.title ?? id
      before = note?.tags ?? []
    }

    const after = add ? [...before, tag] : before.filter((entry) => entry !== tag)
    return make({
      kind: 'fields',
      type: onTask ? 'task' : 'note',
      id,
      title,
      intent: 'update',
      fields: fields(field('tags', before, after))
    })
  }
}

// --------------------------------------------------------------- canvas

const createCanvas: Builder = async (args) =>
  make({
    kind: 'fields',
    type: 'canvas',
    title: displayValue(args.title) ?? '',
    intent: 'create',
    fields: fields(field('title', null, args.title))
  })

const addCanvasItem: Builder = async (args, handles) => {
  const id = str(args.canvas_id)
  const canvas = await handles.canvas.read(id)
  const items = Array.isArray(args.items) ? args.items : []
  return make({
    kind: 'fields',
    type: 'canvas',
    id,
    title: canvas?.title ?? id,
    intent: 'update',
    fields: fields(
      field('items', canvas?.items.length ?? 0, (canvas?.items.length ?? 0) + items.length)
    )
  })
}

const removeCanvasItem: Builder = async (args, handles) => {
  const id = str(args.canvas_id)
  const canvas = await handles.canvas.read(id)
  return make({
    kind: 'fields',
    type: 'canvas',
    id,
    title: canvas?.title ?? id,
    intent: 'update',
    fields: fields(
      field('items', canvas?.items.length ?? 0, Math.max((canvas?.items.length ?? 1) - 1, 0)),
      field('removed', null, args.entity_id)
    )
  })
}

function canvasElementBuilder(argKey: 'elements' | 'edits'): Builder {
  return async (args, handles) => {
    const id = str(args.canvas_id)
    const canvas = await handles.canvas.read(id)
    const count = Array.isArray(args[argKey]) ? (args[argKey] as unknown[]).length : 0
    return make({
      kind: 'fields',
      type: 'canvas',
      id,
      title: canvas?.title ?? id,
      intent: 'update',
      fields: fields(field(argKey, null, count))
    })
  }
}

// -------------------------------------------------------------- desktop

/**
 * `vault_desktop_write` is an allowlisted CRUD passthrough, so there is no item
 * to read a before from. Naming the operation and its arguments is the honest
 * limit of what can be previewed here.
 */
const desktopWrite: Builder = async (args) =>
  make({
    kind: 'fields',
    type: 'note',
    title: displayValue(args.operation) ?? 'desktop',
    intent: 'update',
    fields: fields(
      field('operation', null, args.operation),
      field('arguments', null, Array.isArray(args.args) ? args.args.length : 0)
    )
  })

const BUILDERS: Record<string, Builder | undefined> = {
  vault_create_note: createNote,
  vault_update_note: updateNote,
  vault_rename_note: renameNote,
  vault_move_to_folder: moveNote,
  vault_delete_note: deleteNote,
  vault_create_folder: createFolder,
  vault_rename_folder: renameFolder,
  vault_delete_folder: deleteFolder,
  vault_create_task: createTask,
  vault_update_task: updateTask,
  vault_delete_task: deleteTask,
  vault_complete_task: taskStateBuilder('completed_at', true),
  vault_uncomplete_task: taskStateBuilder('completed_at', false),
  vault_archive_task: taskStateBuilder('archived_at', true),
  vault_unarchive_task: taskStateBuilder('archived_at', false),
  vault_move_task: moveTask,
  vault_reorder_tasks: reorderBuilder('task', 'task_ids'),
  vault_duplicate_task: duplicateTask,
  vault_convert_task_to_subtask: convertToSubtask,
  vault_convert_subtask_to_task: convertToTask,
  vault_create_project: createProject,
  vault_update_project: updateProject,
  vault_delete_project: deleteProject,
  vault_archive_project: archiveProject,
  vault_reorder_projects: reorderBuilder('project', 'project_ids'),
  vault_create_status: createStatus,
  vault_update_status: updateStatus,
  vault_delete_status: deleteStatus,
  vault_reorder_statuses: reorderBuilder('status', 'status_ids'),
  vault_create_journal_entry: createJournalEntry,
  vault_update_journal_entry: updateJournalEntry,
  vault_delete_journal_entry: deleteJournalEntry,
  vault_add_to_inbox: addToInbox,
  vault_update_inbox_item: updateInboxItem,
  vault_snooze_inbox_item: snoozeInboxItem,
  vault_archive_inbox_item: inboxArchiveBuilder(true),
  vault_unarchive_inbox_item: inboxArchiveBuilder(false),
  vault_delete_inbox_item: deleteInboxItem,
  vault_add_inbox_tag: inboxTagBuilder(true),
  vault_remove_inbox_tag: inboxTagBuilder(false),
  vault_add_tag: tagBuilder(true),
  vault_remove_tag: tagBuilder(false),
  vault_create_canvas: createCanvas,
  vault_add_canvas_item: addCanvasItem,
  vault_remove_canvas_item: removeCanvasItem,
  vault_draw_on_canvas: canvasElementBuilder('elements'),
  vault_edit_canvas_elements: canvasElementBuilder('edits'),
  vault_desktop_write: desktopWrite
}
