/**
 * The async sources behind "Add all from…" in the canvas Add card picker
 * (#2484): the tag and folder lists to pick from, and the items a picked scope
 * holds, whole or through one of its saved views.
 *
 * Rows come from the same `folder-view:list-with-properties` call a folder or
 * tag page runs, and a saved view's filter is applied here exactly as the page
 * applies it (client-side, see useFolderView), so "add this view" places what
 * the view shows.
 */

import type { CanvasEntityRef } from '@memry/contracts/canvas-api'
import type { NoteWithProperties, ViewScope } from '@memry/contracts/folder-view-api'
import { isFilterEmpty } from '@/lib/filter-evaluator'
import { tagsService } from '@/services/tags-service'
import { refsFromViewRows } from './canvas-bulk-add'

/** The largest page the list call accepts (ListWithPropertiesRequestSchema). */
const PAGE_SIZE = 1000

/** One way to add a scope: everything in it (`viewName: null`) or one saved view. */
export interface BulkScopeOption {
  viewName: string | null
  refs: CanvasEntityRef[]
}

export interface BulkTagSource {
  name: string
  count: number
}

export async function listBulkTags(): Promise<BulkTagSource[]> {
  const { tags } = await tagsService.getAllWithCounts()
  return tags
    .filter((tag) => tag.count > 0)
    .map((tag) => ({ name: tag.name, count: tag.count }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Vault folders, root excluded: "every note in the vault" is not a folder pick. */
export async function listBulkFolders(): Promise<string[]> {
  const folders = await window.api.notes.getFolders()
  return folders
    .map((folder) => folder.path)
    .filter((path) => path.length > 0)
    .sort((a, b) => a.localeCompare(b))
}

async function listScopeRows(scope: ViewScope): Promise<NoteWithProperties[]> {
  const rows: NoteWithProperties[] = []
  for (;;) {
    const page = await window.api.folderView.listWithProperties({
      scope,
      limit: PAGE_SIZE,
      offset: rows.length
    })
    rows.push(...page.notes)
    if (!page.hasMore || page.notes.length === 0) return rows
  }
}

/**
 * Everything the scope holds, then one option per saved view that actually
 * filters. A view without a filter shows the same rows as "all items", so it
 * would only be a duplicate row in the picker.
 *
 * Rows are ordered by title so the placed grid reads alphabetically; the
 * list call's own order (modification time, or notes-then-tasks for a tag) is
 * an index detail, not something a user chose.
 */
export async function loadBulkScopeOptions(scope: ViewScope): Promise<BulkScopeOption[]> {
  const [rows, { views }] = await Promise.all([
    listScopeRows(scope),
    window.api.folderView.getViews(scope)
  ])
  const sorted = [...rows].sort((a, b) => a.title.localeCompare(b.title))
  const options: BulkScopeOption[] = [{ viewName: null, refs: refsFromViewRows(sorted) }]
  for (const view of views) {
    if (isFilterEmpty(view.filters)) continue
    options.push({ viewName: view.name, refs: refsFromViewRows(sorted, view.filters) })
  }
  return options
}
