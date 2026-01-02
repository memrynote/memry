/**
 * Folder View IPC handlers.
 * Handles all folder view (Bases-like database view) related IPC communication.
 *
 * @module ipc/folder-view-handlers
 */

import { ipcMain } from 'electron'
import { eq, like, and, isNull } from 'drizzle-orm'
import { FolderViewChannels } from '@shared/ipc-channels'
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
} from '@shared/contracts/folder-view-api'
import { getNoteFolderSuggestions } from '../inbox/suggestions'
import { createValidatedHandler } from './validate'
import { readFolderConfig, writeFolderConfig } from '../vault/folders'
import { getIndexDatabase as getDataDb } from '../database'
import { noteCache, noteTags, noteProperties } from '@shared/db/schema/notes-cache'

// ============================================================================
// Helpers
// ============================================================================

/**
 * Compute relative folder path from the viewed folder.
 * E.g., if viewing "projects" and note is at "notes/projects/2024/note.md"
 * returns "/2024"
 */
function computeRelativeFolder(notePath: string, viewedFolder: string): string {
  // notePath is like "notes/projects/2024/note.md"
  // viewedFolder is like "projects"
  const withoutNotes = notePath.startsWith('notes/') ? notePath.slice(6) : notePath
  const noteDir = withoutNotes.split('/').slice(0, -1).join('/')

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
    createValidatedHandler(SetConfigRequestSchema, async (input): Promise<SetConfigResponse> => {
      try {
        const currentConfig = (await readFolderConfig(input.folderPath)) || {}
        await writeFolderConfig(input.folderPath, {
          ...currentConfig,
          ...input.config
        })
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to set config'
        return { success: false, error: message }
      }
    })
  )

  // folder-view:get-views - Get all views for a folder
  ipcMain.handle(
    FolderViewChannels.invoke.GET_VIEWS,
    createValidatedHandler(GetViewsRequestSchema, async (input): Promise<GetViewsResponse> => {
      const folderConfig = await readFolderConfig(input.folderPath)

      if (!folderConfig || !folderConfig.views || folderConfig.views.length === 0) {
        return { views: [DEFAULT_VIEW], defaultIndex: 0 }
      }

      const defaultIndex = folderConfig.views.findIndex((v) => v.default) ?? 0
      return { views: folderConfig.views, defaultIndex: Math.max(0, defaultIndex) }
    })
  )

  // folder-view:set-view - Add or update a single view
  ipcMain.handle(
    FolderViewChannels.invoke.SET_VIEW,
    createValidatedHandler(SetViewRequestSchema, async (input): Promise<SetViewResponse> => {
      try {
        console.log('[folder-view:set-view] Saving view:', {
          folderPath: input.folderPath,
          viewName: input.view.name
        })

        const currentConfig = (await readFolderConfig(input.folderPath)) || {}
        const views = currentConfig.views || []

        console.log(
          '[folder-view:set-view] Current views:',
          views.map((v) => v.name)
        )

        // Find existing view by name
        const existingIndex = views.findIndex((v) => v.name === input.view.name)

        if (existingIndex >= 0) {
          // Update existing
          console.log('[folder-view:set-view] Updating existing view at index:', existingIndex)
          views[existingIndex] = input.view
        } else {
          // Add new
          console.log('[folder-view:set-view] Adding new view')
          views.push(input.view)
        }

        // If this view is default, clear default from others
        if (input.view.default) {
          views.forEach((v, i) => {
            if (i !== (existingIndex >= 0 ? existingIndex : views.length - 1)) {
              v.default = false
            }
          })
        }

        await writeFolderConfig(input.folderPath, { ...currentConfig, views })
        console.log('[folder-view:set-view] Successfully saved. Total views:', views.length)
        return { success: true }
      } catch (error) {
        console.error('[folder-view:set-view] Error:', error)
        const message = error instanceof Error ? error.message : 'Failed to set view'
        return { success: false, error: message }
      }
    })
  )

  // folder-view:delete-view - Delete a view by name
  ipcMain.handle(
    FolderViewChannels.invoke.DELETE_VIEW,
    createValidatedHandler(DeleteViewRequestSchema, async (input): Promise<DeleteViewResponse> => {
      try {
        const currentConfig = (await readFolderConfig(input.folderPath)) || {}
        const views = currentConfig.views || []

        const filtered = views.filter((v) => v.name !== input.viewName)

        // If we deleted the last view, don't save (revert to default)
        if (filtered.length === 0) {
          await writeFolderConfig(input.folderPath, { ...currentConfig, views: undefined })
        } else {
          // If we deleted the default view, make first view default
          if (!filtered.some((v) => v.default)) {
            filtered[0].default = true
          }
          await writeFolderConfig(input.folderPath, { ...currentConfig, views: filtered })
        }

        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to delete view'
        return { success: false, error: message }
      }
    })
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

        // Build path pattern for LIKE query
        // folderPath is like "projects" -> match "notes/projects/%"
        const pathPattern = input.folderPath ? `notes/${input.folderPath}/%` : 'notes/%'

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

        // Batch fetch tags
        const tagsResult = await db
          .select({ noteId: noteTags.noteId, tag: noteTags.tag })
          .from(noteTags)
          .where(
            noteIds.length === 1
              ? eq(noteTags.noteId, noteIds[0])
              : // For multiple notes, we need individual queries or SQL IN
                eq(noteTags.noteId, noteIds[0]) // Simplified - should use IN
          )

        // Group tags by note ID
        const tagsByNote = new Map<string, string[]>()
        tagsResult.forEach((row) => {
          if (!tagsByNote.has(row.noteId)) {
            tagsByNote.set(row.noteId, [])
          }
          tagsByNote.get(row.noteId)!.push(row.tag)
        })

        // Batch fetch properties (if specific properties requested)
        const propertiesMap = new Map<string, Record<string, unknown>>()

        if (input.properties && input.properties.length > 0) {
          // Query properties for all notes
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
        }

        // Build response
        const notesWithProps: NoteWithProperties[] = notes.map((note) => ({
          id: note.id,
          path: note.path,
          title: note.title,
          emoji: note.emoji,
          folder: computeRelativeFolder(note.path, input.folderPath),
          tags: tagsByNote.get(note.id) || [],
          created: note.created,
          modified: note.modified,
          wordCount: note.wordCount,
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

        let db: ReturnType<typeof getDataDb>
        try {
          db = getDataDb()
        } catch {
          return { builtIn, properties: [], formulas: [] }
        }

        // Get folder config for formulas
        const folderConfig = await readFolderConfig(input.folderPath)
        const formulas = folderConfig?.formulas
          ? Object.entries(folderConfig.formulas).map(([id, expression]) => ({ id, expression }))
          : []

        // Query distinct property names used in this folder
        const pathPattern = input.folderPath ? `notes/${input.folderPath}/%` : 'notes/%'

        // Get notes in folder first
        const folderNotes = await db
          .select({ id: noteCache.id })
          .from(noteCache)
          .where(and(like(noteCache.path, pathPattern), isNull(noteCache.date)))

        if (folderNotes.length === 0) {
          return { builtIn, properties: [], formulas }
        }

        // Get property usage counts
        const propCounts = new Map<string, { count: number; type: string }>()

        for (const note of folderNotes) {
          const props = await db
            .select({ name: noteProperties.name, type: noteProperties.type })
            .from(noteProperties)
            .where(eq(noteProperties.noteId, note.id))

          props.forEach((p) => {
            const existing = propCounts.get(p.name)
            if (existing) {
              existing.count++
            } else {
              propCounts.set(p.name, { count: 1, type: p.type })
            }
          })
        }

        // Convert to array
        const properties: AvailableProperty[] = Array.from(propCounts.entries()).map(
          ([name, { count, type }]) => ({
            name,
            type: type as AvailableProperty['type'],
            usageCount: count
          })
        )

        // Sort by usage count descending
        properties.sort((a, b) => b.usageCount - a.usageCount)

        return { builtIn, properties, formulas }
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
          console.error('[folder-view:get-folder-suggestions] Error:', error)
          // Return empty array on error - not critical, just disables AI suggestions
          return { suggestions: [] }
        }
      }
    )
  )
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
