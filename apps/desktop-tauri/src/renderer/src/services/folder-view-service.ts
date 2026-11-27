import {
  DEFAULT_VIEW,
  type FolderViewClientAPI,
  type FolderViewConfig,
  type GetViewsResponse,
  type ListWithPropertiesResponse,
  type GetAvailablePropertiesResponse,
  type ViewConfig,
  type ViewScope
} from '@memry/contracts/folder-view-api'
import { commands, type Value } from '../../../generated/bindings'
import { extractErrorMessage } from '../lib/ipc-error'
import { createWindowApiForwarder } from './window-api-forwarder'

export type FolderViewService = FolderViewClientAPI & {
  folderExists(folderPath: string): Promise<boolean>
}

async function settled(
  write: () => Promise<unknown>
): Promise<{ success: boolean; error?: string }> {
  try {
    await write()
    return { success: true }
  } catch (error) {
    const message = extractErrorMessage(error, '')
    return message ? { success: false, error: message } : { success: false }
  }
}

/** A view or a config is JSON the renderer wrote; Rust stores it whole and checks its keys. */
function toJson(value: ViewConfig | Partial<FolderViewConfig>): Record<string, Value> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a view or config is a JSON object
  return value as Record<string, Value>
}

/**
 * A config with each key the caller set to `undefined` as `null`. A caller clears a key with
 * `{ ...config, formulas: undefined }`; JSON would drop it and keep the stored value, and `null`
 * removes it.
 */
function cleared(config: Partial<FolderViewConfig>): Record<string, Value> {
  return Object.fromEntries(
    Object.entries(toJson(config)).map(([key, value]) => [key, value ?? null])
  )
}

/** `defaultFieldTagView`: a tag with fields shows them between the title and modified columns. */
function defaultView(fieldColumns: string[] | null): ViewConfig {
  if (!fieldColumns) return DEFAULT_VIEW
  return {
    ...DEFAULT_VIEW,
    columns: [
      { id: 'title', width: 250 },
      ...fieldColumns.map((name) => ({ id: name, width: 150 })),
      { id: 'modified', width: 130 }
    ]
  }
}

/**
 * The folder view commands of Step 30b (`commands/folder_view.rs`), in Electron's response
 * shapes: reads and `setConfig` reject on failure; a view write answers `{ success: false, error }`.
 * `getFolderSuggestions` (the inbox's AI filing) still forwards to `window.api.folderView`.
 */
const ported = {
  getConfig: async (folderPath: string) => {
    const stored = await commands.folderViewGetConfig(folderPath)
    const kept = Object.fromEntries(
      Object.entries(stored ?? {}).filter(([, value]) => value !== null && value !== undefined)
    )
    const saved = Array.isArray(stored?.views) && stored.views.length > 0
    // Electron answered a folder with no saved view with the default config alone, dropping
    // its formulas and summaries; they stay here, so a write of the config keeps them.
    const config = { ...kept, path: folderPath, views: saved ? kept.views : [DEFAULT_VIEW] }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the `.folder.md` keys as the file holds them, which `FolderViewConfig` names
    return { config: config as FolderViewConfig, isDefault: !saved }
  },

  /** Rejects on failure: the hook's callers read no `success` and surface the error. */
  setConfig: async (folderPath: string, config: Partial<FolderViewConfig>) => {
    await commands.folderViewSetConfig(folderPath, cleared(config))
    return { success: true }
  },

  getViews: async (scope: ViewScope): Promise<GetViewsResponse> => {
    const saved = await commands.folderViewGetViews(scope)
    if (!saved.views) return { views: [defaultView(saved.fieldColumns)], defaultIndex: 0 }
    // Rust answers only the stored entries that are objects with a name, as stored.
    const views: unknown = saved.views
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- saved views, as above
    return { views: views as ViewConfig[], defaultIndex: saved.defaultIndex }
  },

  setView: (scope: ViewScope, view: ViewConfig, previousName?: string) =>
    settled(() => commands.folderViewSetView(scope, toJson(view), previousName ?? null)),

  deleteView: (scope: ViewScope, viewName: string) =>
    settled(() => commands.folderViewDeleteView(scope, viewName)),

  listWithProperties: async (
    options: Parameters<FolderViewClientAPI['listWithProperties']>[0]
  ): Promise<ListWithPropertiesResponse> =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `RowView` is `NoteWithProperties` with JSON property values
    (await commands.folderViewList(options)) as ListWithPropertiesResponse,

  getAvailableProperties: async (scope: ViewScope): Promise<GetAvailablePropertiesResponse> =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the property types are `PropertyType` names
    (await commands.folderViewAvailableProperties(scope)) as GetAvailablePropertiesResponse,

  folderExists: (folderPath: string) => commands.folderViewFolderExists(folderPath)
}

export const folderViewService: FolderViewService = createWindowApiForwarder<
  FolderViewService,
  keyof typeof ported
>(() => window.api.folderView, ported)
