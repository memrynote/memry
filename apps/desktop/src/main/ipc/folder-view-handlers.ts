/**
 * Folder View IPC handlers.
 * Handles all folder view (Bases-like database view) related IPC communication.
 *
 * @module ipc/folder-view-handlers
 */

import { ipcMain } from 'electron'
import { eq, like, and, isNull, inArray } from 'drizzle-orm'
import { FolderViewChannels } from '@memry/contracts/ipc-channels'
import {
  GetConfigRequestSchema,
  SetConfigRequestSchema,
  GetViewsRequestSchema,
  SetViewRequestSchema,
  DeleteViewRequestSchema,
  ListWithPropertiesRequestSchema,
  GetAvailablePropertiesRequestSchema,
  GetFolderSuggestionsRequestSchema,
  DEFAULT_VIEW,
  BUILT_IN_COLUMNS,
  type ViewScope,
  type ViewConfig,
  type FolderViewConfig,
  type NoteWithProperties,
  type AvailableProperty,
  type GetConfigResponse,
  type SetConfigResponse,
  type GetViewsResponse,
  type SetViewResponse,
  type DeleteViewResponse,
  type ListWithPropertiesResponse,
  type GetAvailablePropertiesResponse,
  type GetFolderSuggestionsResponse
} from '@memry/contracts/folder-view-api'
import { createLogger } from '../lib/logger'
import { getNoteFolderSuggestions } from '../inbox/suggestions'
import { createValidatedHandler, withErrorHandler } from './validate'
import { readFolderConfig, writeFolderConfig, folderExists } from '../vault/folders'
import { getIndexDatabase as getDataDb, getDatabase } from '../database'
import { noteCache, noteTags, noteProperties } from '@memry/db-schema/schema/notes-cache'
import { listTagItems, readTagViews, writeTagViews } from '../tags/store'

const logger = createLogger('IPC:FolderView')

// ============================================================================
// Helpers
// ============================================================================

/**
 * Compute relative folder path from the viewed folder.
 * E.g., if viewing "projects" and note is at "projects/2024/note.md"
 * returns "/2024"
 *
 * Both `notePath` and `viewedFolder` are vault-relative. `defaultNoteFolder`
 * is not consulted: it names where new notes go, not where folders live, so
 * setting it must not make every other folder look empty (#1204).
 */
function computeRelativeFolder(notePath: string, viewedFolder: string): string {
  // notePath is like "projects/2024/note.md"
  // viewedFolder is like "projects"
  const noteDir = notePath.split('/').slice(0, -1).join('/')

  if (!viewedFolder || viewedFolder === '') {
    return noteDir ? `/${noteDir}` : '/'
  }

  if (noteDir === viewedFolder) {
    return '/'
  }

  if (noteDir.startsWith(viewedFolder + '/')) {
    return '/' + noteDir.slice(viewedFolder.length + 1)
  }

  return '/'
}

/**
 * Batch-fetch every property value for the given notes.
 * Shared by both scopes — a tag view is worthless if its property columns
 * are blank, so tag rows go through exactly the same fetch folders use.
 */
async function fetchPropertiesFor(
  db: ReturnType<typeof getDataDb>,
  noteIds: string[]
): Promise<Map<string, Record<string, unknown>>> {
  const propertiesMap = new Map<string, Record<string, unknown>>()
  for (const noteId of noteIds) {
    const propsResult = await db
      .select({ name: noteProperties.name, value: noteProperties.value })
      .from(noteProperties)
      .where(eq(noteProperties.noteId, noteId))

    const props: Record<string, unknown> = {}
    propsResult.forEach((row) => {
      try {
        props[row.name] = row.value ? JSON.parse(row.value) : null
      } catch {
        props[row.name] = row.value
      }
    })
    propertiesMap.set(noteId, props)
  }
  return propertiesMap
}

/**
 * Batch-fetch property usage counts and types across the given notes.
 * Shared by both scope branches of get-available-properties — a tag's
 * columns come from the same note_properties rows a folder's do, just
 * counted over a different note id set.
 */
async function fetchPropertyCounts(
  db: ReturnType<typeof getDataDb>,
  noteIds: string[]
): Promise<Map<string, { count: number; type: string }>> {
  const propCounts = new Map<string, { count: number; type: string }>()

  for (const noteId of noteIds) {
    const props = await db
      .select({ name: noteProperties.name, type: noteProperties.type })
      .from(noteProperties)
      .where(eq(noteProperties.noteId, noteId))

    props.forEach((p) => {
      const existing = propCounts.get(p.name)
      if (existing) {
        existing.count++
      } else {
        propCounts.set(p.name, { count: 1, type: p.type })
      }
    })
  }

  return propCounts
}

/** Usage counts -> the sorted AvailableProperty list the response returns (highest usage first). */
function toAvailableProperties(
  propCounts: Map<string, { count: number; type: string }>
): AvailableProperty[] {
  const properties: AvailableProperty[] = Array.from(propCounts.entries()).map(
    ([name, { count, type }]) => ({
      name,
      type: type as AvailableProperty['type'],
      usageCount: count
    })
  )

  properties.sort((a, b) => b.usageCount - a.usageCount)
  return properties
}

/**
 * Saved views for a scope. Folders keep theirs in `.folder.md`; a tag has no
 * directory, so its views live on the tag_definitions row instead (Task 2).
 * Centralising the split here keeps GET_VIEWS/SET_VIEW/DELETE_VIEW thin.
 */
async function readScopedViews(scope: ViewScope): Promise<ViewConfig[] | null> {
  if (scope.kind === 'tag') return readTagViews(getDatabase(), scope.tag)
  const folderConfig = await readFolderConfig(scope.path)
  return folderConfig?.views ?? null
}

async function writeScopedViews(scope: ViewScope, views: ViewConfig[] | null): Promise<void> {
  if (scope.kind === 'tag') {
    writeTagViews(getDatabase(), scope.tag, views)
    return
  }
  const currentConfig = (await readFolderConfig(scope.path)) || {}
  await writeFolderConfig(scope.path, { ...currentConfig, views: views ?? undefined })
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * Register all folder view-related IPC handlers.
 * Call this once during app initialization.
 */
export function registerFolderViewHandlers(): void {
  // folder-view:get-config - Get folder view configuration
  ipcMain.handle(
    FolderViewChannels.invoke.GET_CONFIG,
    createValidatedHandler(GetConfigRequestSchema, async (input): Promise<GetConfigResponse> => {
      const folderConfig = await readFolderConfig(input.folderPath)

      if (!folderConfig || !folderConfig.views || folderConfig.views.length === 0) {
        // Return default config
        const defaultConfig: FolderViewConfig = {
          path: input.folderPath,
          views: [DEFAULT_VIEW]
        }
        return { config: defaultConfig, isDefault: true }
      }

      return {
        config: {
          path: input.folderPath,
          ...folderConfig
        },
        isDefault: false
      }
    })
  )

  // folder-view:set-config - Set folder view configuration
  ipcMain.handle(
    FolderViewChannels.invoke.SET_CONFIG,
    createValidatedHandler(
      SetConfigRequestSchema,
      withErrorHandler(async (input): Promise<SetConfigResponse> => {
        const currentConfig = (await readFolderConfig(input.folderPath)) || {}
        await writeFolderConfig(input.folderPath, {
          ...currentConfig,
          ...input.config
        })
        return { success: true }
      }, 'errors:folderView.setConfigFailed')
    )
  )

  // folder-view:get-views - Get all views for a folder or tag
  ipcMain.handle(
    FolderViewChannels.invoke.GET_VIEWS,
    createValidatedHandler(GetViewsRequestSchema, async (input): Promise<GetViewsResponse> => {
      const views = await readScopedViews(input.scope)

      if (!views || views.length === 0) {
        return { views: [DEFAULT_VIEW], defaultIndex: 0 }
      }

      const defaultIndex = views.findIndex((v) => v.default) ?? 0
      return { views, defaultIndex: Math.max(0, defaultIndex) }
    })
  )

  // folder-view:set-view - Add or update a single view
  ipcMain.handle(
    FolderViewChannels.invoke.SET_VIEW,
    createValidatedHandler(
      SetViewRequestSchema,
      withErrorHandler(async (input): Promise<SetViewResponse> => {
        const views = (await readScopedViews(input.scope)) || []

        const existingIndex = views.findIndex((v) => v.name === input.view.name)

        if (existingIndex >= 0) {
          views[existingIndex] = input.view
        } else {
          views.push(input.view)
        }

        if (input.view.default) {
          views.forEach((v, i) => {
            if (i !== (existingIndex >= 0 ? existingIndex : views.length - 1)) {
              v.default = false
            }
          })
        }

        await writeScopedViews(input.scope, views)
        return { success: true }
      }, 'errors:folderView.setViewFailed')
    )
  )

  // folder-view:delete-view - Delete a view by name
  ipcMain.handle(
    FolderViewChannels.invoke.DELETE_VIEW,
    createValidatedHandler(
      DeleteViewRequestSchema,
      withErrorHandler(async (input): Promise<DeleteViewResponse> => {
        const views = (await readScopedViews(input.scope)) || []

        const filtered = views.filter((v) => v.name !== input.viewName)

        if (filtered.length === 0) {
          await writeScopedViews(input.scope, null)
        } else {
          if (!filtered.some((v) => v.default)) {
            filtered[0].default = true
          }
          await writeScopedViews(input.scope, filtered)
        }

        return { success: true }
      }, 'errors:folderView.deleteViewFailed')
    )
  )

  // folder-view:list-with-properties - List notes in folder with property values
  ipcMain.handle(
    FolderViewChannels.invoke.LIST_WITH_PROPERTIES,
    createValidatedHandler(
      ListWithPropertiesRequestSchema,
      async (input): Promise<ListWithPropertiesResponse> => {
        let db: ReturnType<typeof getDataDb>
        try {
          db = getDataDb()
        } catch {
          return { notes: [], total: 0, hasMore: false }
        }

        if (input.scope.kind === 'tag') {
          let dataDb: ReturnType<typeof getDatabase>
          try {
            dataDb = getDatabase()
          } catch {
            return { notes: [], total: 0, hasMore: false }
          }

          const items = listTagItems(db, dataDb, input.scope.tag)
          const noteIds = items.filter((i) => i.kind === 'note').map((i) => i.id)
          const propertiesMap = await fetchPropertiesFor(db, noteIds)

          const rows: NoteWithProperties[] = items.map((item) => ({
            id: item.id,
            // Tasks and inbox items have no note path; synthesise a stable one so
            // row identity and any path-keyed UI still work.
            path:
              item.kind === 'note'
                ? (item.path ?? '')
                : item.kind === 'task'
                  ? `/tasks/${item.id}`
                  : `/inbox/${item.id}`,
            title: item.title,
            emoji: item.emoji,
            // `container` is the note's parent folder or the task's project name.
            folder: item.container ?? '',
            tags: item.tags,
            created: item.created,
            modified: item.modified,
            // TagItem carries no word count for any kind.
            wordCount: 0,
            properties: propertiesMap.get(item.id) ?? {},
            kind: item.kind
          }))

          const page = rows.slice(input.offset, input.offset + input.limit)
          return {
            notes: page,
            total: rows.length,
            hasMore: input.offset + page.length < rows.length
          }
        }

        // Build path pattern for LIKE query. Note paths are vault-relative,
        // so scope.path "projects" -> match "projects/%".
        // Captured into a local so the 'folder' narrowing survives into the
        // .map() closure below (TS doesn't carry discriminated-union
        // narrowing of a property access across a nested function).
        const folderPath = input.scope.path
        const pathPattern = folderPath ? `${folderPath}/%` : '%'

        // Query notes in folder (exclude journal entries where date IS NOT NULL)
        const notesResult = await db
          .select({
            id: noteCache.id,
            path: noteCache.path,
            title: noteCache.title,
            emoji: noteCache.emoji,
            created: noteCache.createdAt,
            modified: noteCache.modifiedAt,
            wordCount: noteCache.wordCount
          })
          .from(noteCache)
          .where(and(like(noteCache.path, pathPattern), isNull(noteCache.date)))
          .limit(input.limit + 1) // +1 to check hasMore
          .offset(input.offset)
          .orderBy(noteCache.modifiedAt)

        const hasMore = notesResult.length > input.limit
        const notes = notesResult.slice(0, input.limit)

        if (notes.length === 0) {
          return { notes: [], total: 0, hasMore: false }
        }

        // Get note IDs for batch queries
        const noteIds = notes.map((n) => n.id)

        // Batch fetch tags for all notes
        const tagsResult = await db
          .select({ noteId: noteTags.noteId, tag: noteTags.tag })
          .from(noteTags)
          .where(inArray(noteTags.noteId, noteIds))

        // Group tags by note ID
        const tagsByNote = new Map<string, string[]>()
        tagsResult.forEach((row) => {
          if (!tagsByNote.has(row.noteId)) {
            tagsByNote.set(row.noteId, [])
          }
          tagsByNote.get(row.noteId)!.push(row.tag)
        })

        // Batch fetch properties for all notes.
        // When input.properties is undefined, fetch ALL properties (for column flexibility)
        // When input.properties is specified, only fetch those (for optimization) —
        // currently fetchPropertiesFor always fetches all, for simplicity.
        const propertiesMap = await fetchPropertiesFor(db, noteIds)

        // Build response
        const notesWithProps: NoteWithProperties[] = notes.map((note) => ({
          id: note.id,
          path: note.path,
          title: note.title,
          emoji: note.emoji,
          folder: computeRelativeFolder(note.path, folderPath),
          tags: tagsByNote.get(note.id) || [],
          created: note.created,
          modified: note.modified,
          wordCount: note.wordCount ?? 0,
          properties: propertiesMap.get(note.id) || {}
        }))

        // Count total (simplified - just use current batch)
        const total = notes.length + input.offset + (hasMore ? 1 : 0)

        return { notes: notesWithProps, total, hasMore }
      }
    )
  )

  // folder-view:get-available-properties - Get available properties for column selector
  ipcMain.handle(
    FolderViewChannels.invoke.GET_AVAILABLE_PROPERTIES,
    createValidatedHandler(
      GetAvailablePropertiesRequestSchema,
      async (input): Promise<GetAvailablePropertiesResponse> => {
        // Built-in columns (always available)
        const builtIn = BUILT_IN_COLUMNS.map((id) => ({
          id,
          displayName: id.charAt(0).toUpperCase() + id.slice(1),
          type:
            id === 'created' || id === 'modified'
              ? ('date' as const)
              : id === 'wordCount'
                ? ('number' as const)
                : id === 'tags'
                  ? ('multiselect' as const)
                  : ('text' as const)
        }))

        // Only a tag view mixes row kinds, so only it gets the column — and
        // with it, `kind` filtering through the normal Filter By path.
        const builtInForScope =
          input.scope.kind === 'tag'
            ? [...builtIn, { id: 'kind' as const, displayName: 'Kind', type: 'text' as const }]
            : builtIn

        let db: ReturnType<typeof getDataDb>
        try {
          db = getDataDb()
        } catch {
          return { builtIn: builtInForScope, properties: [], formulas: [] }
        }

        if (input.scope.kind === 'tag') {
          let dataDb: ReturnType<typeof getDatabase>
          try {
            dataDb = getDatabase()
          } catch {
            return { builtIn: builtInForScope, properties: [], formulas: [] }
          }

          const items = listTagItems(db, dataDb, input.scope.tag)
          const noteIds = items.filter((item) => item.kind === 'note').map((item) => item.id)
          const propCounts = await fetchPropertyCounts(db, noteIds)

          // Formulas live in `.folder.md`, which a tag has no equivalent of.
          return {
            builtIn: builtInForScope,
            properties: toAvailableProperties(propCounts),
            formulas: []
          }
        }

        const folderPath = input.scope.path

        // Get folder config for formulas
        const folderConfig = await readFolderConfig(folderPath)
        const formulas = folderConfig?.formulas
          ? Object.entries(folderConfig.formulas).map(([id, expression]) => ({ id, expression }))
          : []

        // Query distinct property names used in this folder
        const pathPattern = folderPath ? `${folderPath}/%` : '%'

        // Get notes in folder first
        const folderNotes = await db
          .select({ id: noteCache.id })
          .from(noteCache)
          .where(and(like(noteCache.path, pathPattern), isNull(noteCache.date)))

        if (folderNotes.length === 0) {
          return { builtIn: builtInForScope, properties: [], formulas }
        }

        const propCounts = await fetchPropertyCounts(
          db,
          folderNotes.map((note) => note.id)
        )

        return { builtIn: builtInForScope, properties: toAvailableProperties(propCounts), formulas }
      }
    )
  )

  // folder-view:get-folder-suggestions - Get AI-powered folder suggestions for moving a note
  ipcMain.handle(
    FolderViewChannels.invoke.GET_FOLDER_SUGGESTIONS,
    createValidatedHandler(
      GetFolderSuggestionsRequestSchema,
      async (input): Promise<GetFolderSuggestionsResponse> => {
        try {
          const suggestions = await getNoteFolderSuggestions(input.noteId)
          return { suggestions }
        } catch (error) {
          logger.error('get-folder-suggestions error:', error)
          // Return empty array on error - not critical, just disables AI suggestions
          return { suggestions: [] }
        }
      }
    )
  )

  // folder-view:folder-exists - Check if a folder exists (T115)
  ipcMain.handle(FolderViewChannels.invoke.FOLDER_EXISTS, (_event, folderPath: string): boolean => {
    return folderExists(folderPath)
  })
}

/**
 * Unregister all folder view-related IPC handlers.
 * Useful for cleanup or testing.
 */
export function unregisterFolderViewHandlers(): void {
  Object.values(FolderViewChannels.invoke).forEach((channel) => {
    ipcMain.removeHandler(channel)
  })
}
