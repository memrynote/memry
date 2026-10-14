import type { ChangePreviewKind } from '@memry/contracts/ipc-agent'

import type { WriteToolName } from './schemas'

/**
 * Which preview the approval card owes the user for each write tool.
 *
 * One table rather than a condition per call site, and typed against
 * `WriteToolName` so a new write tool cannot be added without deciding what it
 * shows. A tool answering `fields` promises `buildChangePreview` can name the
 * columns it changes; `body` promises a markdown before/after; `loss` promises
 * the item is about to stop being reachable and there is no "after" at all.
 *
 * Archiving is deliberately `fields`, not `loss`: it is a reversible state
 * change the user can see in the archive, and calling it a loss would cry wolf
 * on the one signal that has to stay credible.
 */
export const WRITE_TOOL_PREVIEW_KINDS = {
  vault_create_note: 'body',
  vault_rename_note: 'fields',
  vault_delete_note: 'loss',
  vault_create_folder: 'fields',
  vault_rename_folder: 'fields',
  vault_delete_folder: 'loss',
  vault_create_task: 'fields',
  vault_delete_task: 'loss',
  vault_complete_task: 'fields',
  vault_uncomplete_task: 'fields',
  vault_archive_task: 'fields',
  vault_unarchive_task: 'fields',
  vault_move_task: 'fields',
  vault_reorder_tasks: 'fields',
  vault_duplicate_task: 'fields',
  vault_convert_task_to_subtask: 'fields',
  vault_convert_subtask_to_task: 'fields',
  vault_create_project: 'fields',
  vault_update_project: 'fields',
  vault_delete_project: 'loss',
  vault_archive_project: 'fields',
  vault_reorder_projects: 'fields',
  vault_create_status: 'fields',
  vault_update_status: 'fields',
  vault_delete_status: 'loss',
  vault_reorder_statuses: 'fields',
  vault_create_journal_entry: 'body',
  vault_update_journal_entry: 'body',
  vault_delete_journal_entry: 'loss',
  vault_add_to_inbox: 'body',
  vault_update_inbox_item: 'fields',
  vault_snooze_inbox_item: 'fields',
  vault_archive_inbox_item: 'fields',
  vault_unarchive_inbox_item: 'fields',
  vault_delete_inbox_item: 'loss',
  vault_add_inbox_tag: 'fields',
  vault_remove_inbox_tag: 'fields',
  vault_update_note: 'body',
  vault_add_html_artifact: 'fields',
  vault_update_task: 'fields',
  vault_add_tag: 'fields',
  vault_remove_tag: 'fields',
  vault_move_to_folder: 'fields',
  vault_add_canvas_item: 'fields',
  vault_remove_canvas_item: 'fields',
  vault_create_canvas: 'fields',
  vault_draw_on_canvas: 'fields',
  vault_edit_canvas_elements: 'fields',
  vault_desktop_write: 'fields'
} as const satisfies Record<WriteToolName, ChangePreviewKind>

export function previewKindForTool(toolName: string): ChangePreviewKind {
  return (
    (WRITE_TOOL_PREVIEW_KINDS as Record<string, ChangePreviewKind | undefined>)[toolName] ?? 'none'
  )
}
