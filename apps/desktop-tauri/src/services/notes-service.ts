import type {
  AttachmentInfo,
  AttachmentResult,
  CreatePropertyDefinitionInput,
  CreatePropertyDefinitionResponse,
  DeleteAttachmentResponse,
  ExportNoteInput,
  ExportNoteResponse,
  FileMetadata,
  FolderConfig,
  FolderInfo,
  ImportDialogResponse,
  ImportFilesResponse,
  Note,
  NoteCreatedEvent,
  NoteCreateInput,
  NoteCreateResponse,
  NoteDeletedEvent,
  NoteExternalChangeEvent,
  NoteLinksResponse,
  NoteListItem,
  NoteListOptions,
  NoteListResponse,
  NoteMovedEvent,
  NotePositionsResponse,
  NoteRenamedEvent,
  NotesClientAPI,
  NoteUpdateInput,
  NoteUpdateResponse,
  NoteUpdatedEvent,
  PropertyDefinition,
  RestoreVersionResponse,
  SnapshotDetail,
  SnapshotListItem,
  UpdatePropertyDefinitionInput,
  WikiLinkPreview,
  WikiLinkResolution
} from '@memry/rpc/notes'
import { createInvokeForwarder, subscribeEvent } from '@/lib/ipc/forwarder'
import { invoke } from '@/lib/ipc/invoke'
import { NOTE_METHODS_WITH_DATES, reviveNoteDates } from './notes-response-adapter'

export type {
  AttachmentInfo,
  AttachmentResult,
  CreatePropertyDefinitionInput,
  CreatePropertyDefinitionResponse,
  DeleteAttachmentResponse,
  ExportNoteInput,
  ExportNoteResponse,
  FileMetadata,
  FolderConfig,
  FolderInfo,
  ImportDialogResponse,
  ImportFilesResponse,
  Note,
  NoteCreatedEvent,
  NoteCreateInput,
  NoteCreateResponse,
  NoteDeletedEvent,
  NoteExternalChangeEvent,
  NoteLinksResponse,
  NoteListItem,
  NoteListOptions,
  NoteListResponse,
  NoteMovedEvent,
  NotePositionsResponse,
  NoteRenamedEvent,
  NotesClientAPI,
  NoteUpdateInput,
  NoteUpdateResponse,
  NoteUpdatedEvent,
  PropertyDefinition,
  RestoreVersionResponse,
  SnapshotDetail,
  SnapshotListItem,
  UpdatePropertyDefinitionInput,
  WikiLinkPreview,
  WikiLinkResolution
}

// Tauri ships note timestamps as ISO strings, but the renderer (and the
// `Note` / `NoteListItem` types) expect `Date` objects. Wrap the forwarder
// so methods that return note DTOs get a Date-revival pass at the IPC
// boundary, keeping consumers like `notes-tree-utils` (`modified.getTime()`)
// working without per-call-site changes. Methods that don't ship Dates
// (positions, exists, tags, etc.) bypass the wrapper.
const rawNotesService = createInvokeForwarder<NotesClientAPI>('notes')

export const notesService: NotesClientAPI = new Proxy(rawNotesService, {
  get(target, property, receiver) {
    if (typeof property !== 'string') {
      return Reflect.get(target, property, receiver)
    }
    const original = Reflect.get(target, property, receiver) as (
      ...args: unknown[]
    ) => Promise<unknown>
    const realMethod = getRealM5Method(property)
    if (realMethod) {
      return realMethod
    }
    if (property === 'update') {
      return async (...args: unknown[]) =>
        reviveNoteDates(await original(...normalizeUpdateArgs(args)))
    }
    if (!NOTE_METHODS_WITH_DATES.has(property)) {
      return original
    }
    return async (...args: unknown[]) => reviveNoteDates(await original(...args))
  }
}) as NotesClientAPI

type FolderConfigRecord = FolderConfig & {
  path?: string
  templateJson?: string | null
}

function getRealM5Method(property: string): ((...args: unknown[]) => Promise<unknown>) | null {
  switch (property) {
    case 'deleteFolder':
      return async (path) =>
        invoke('notes_delete_folder', {
          input: { path: String(path), recursive: false }
        })
    case 'getFolderConfig':
      return async (folderPath) =>
        normalizeFolderConfigResponse(
          await invoke<FolderConfigRecord | null>('notes_get_folder_config', {
            args: [folderPath]
          })
        )
    case 'setFolderConfig':
      return async (folderPath, config) =>
        invoke('notes_set_folder_config', {
          input: toFolderConfigInput(String(folderPath), config)
        })
    case 'reorder':
      return async (folderPath, notePaths) =>
        invoke('notes_reorder', {
          input: { folderPath: String(folderPath), notePaths }
        })
    case 'createPropertyDefinition':
      return async (input) =>
        invoke<CreatePropertyDefinitionResponse>('notes_create_property_definition', { input })
    case 'updatePropertyDefinition':
      return async (input) =>
        invoke<CreatePropertyDefinitionResponse>('notes_update_property_definition', { input })
    case 'ensurePropertyDefinition':
      return async (name, type) =>
        invoke('notes_ensure_property_definition', {
          input: { name, type }
        })
    case 'addPropertyOption':
      return async (propertyName, option) =>
        invoke('notes_add_property_option', {
          input: { propertyName, option }
        })
    case 'addStatusOption':
      return async (propertyName, categoryKey, option) =>
        invoke('notes_add_status_option', {
          input: { propertyName, categoryKey, option }
        })
    case 'removePropertyOption':
      return async (propertyName, optionValue) =>
        invoke('notes_remove_property_option', {
          input: { propertyName, optionValue }
        })
    case 'renamePropertyOption':
      return async (propertyName, oldValue, newValue) =>
        invoke('notes_rename_property_option', {
          input: { propertyName, oldValue, newValue }
        })
    case 'updateOptionColor':
      return async (propertyName, optionValue, newColor) =>
        invoke('notes_update_option_color', {
          input: { propertyName, optionValue, newColor }
        })
    case 'deletePropertyDefinition':
      return async (name) =>
        invoke('notes_delete_property_definition', {
          input: { name }
        })
    default:
      return null
  }
}

function toFolderConfigInput(
  path: string,
  config: unknown
): {
  path: string
  icon: string | null
  templateJson: string | null
} {
  const record = isRecord(config) ? config : {}
  const template = record.template ?? record.templateJson
  return {
    path,
    icon: typeof record.icon === 'string' ? record.icon : null,
    templateJson: typeof template === 'string' ? template : null
  }
}

function normalizeFolderConfigResponse(config: FolderConfigRecord | null): FolderConfig | null {
  if (!config) return null
  return {
    icon: config.icon ?? null,
    template: config.template ?? config.templateJson ?? undefined,
    inherit: config.inherit
  }
}

function normalizeUpdateArgs(args: unknown[]): unknown[] {
  const [input] = args
  if (args.length !== 1 || !isRecord(input) || input.emoji !== null) {
    return args
  }
  const normalized = { ...input }
  delete normalized.emoji
  const { frontmatter } = normalized
  return [
    {
      ...normalized,
      frontmatter: {
        ...(isRecord(frontmatter) ? frontmatter : {}),
        emoji: null
      }
    }
  ]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function onNoteCreated(callback: (event: NoteCreatedEvent) => void): () => void {
  return subscribeEvent<NoteCreatedEvent>('note-created', callback)
}

export function onNoteUpdated(callback: (event: NoteUpdatedEvent) => void): () => void {
  return subscribeEvent<NoteUpdatedEvent>('note-updated', callback)
}

export function onNoteDeleted(callback: (event: NoteDeletedEvent) => void): () => void {
  return subscribeEvent<NoteDeletedEvent>('note-deleted', callback)
}

export function onNoteRenamed(callback: (event: NoteRenamedEvent) => void): () => void {
  return subscribeEvent<NoteRenamedEvent>('note-renamed', callback)
}

export function onNoteMoved(callback: (event: NoteMovedEvent) => void): () => void {
  return subscribeEvent<NoteMovedEvent>('note-moved', callback)
}

export function onNoteExternalChange(
  callback: (event: NoteExternalChangeEvent) => void
): () => void {
  return subscribeEvent<NoteExternalChangeEvent>('note-external-change', callback)
}

export function onTagsChanged(callback: () => void): () => void {
  return subscribeEvent<void>('tags-changed', callback)
}

export function onFolderConfigUpdated(callback: (event: { path: string }) => void): () => void {
  return subscribeEvent<{ path: string }>('folder-config-updated', callback)
}
