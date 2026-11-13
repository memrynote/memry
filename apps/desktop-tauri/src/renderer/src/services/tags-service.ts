import type {
  GetNotesByTagResponse,
  GetAllWithCountsResponse,
  MergeTagResponse,
  TagOperationResponse,
  DeleteTagResponse,
  TagRenamedEvent,
  TagColorUpdatedEvent,
  TagDeletedEvent,
  TagNotesChangedEvent,
  TagAssignment,
  ListCategoriesResponse,
  CategoryOperationResponse,
  CreateCategoryResponse,
  TagsClientAPI
} from '../../../preload/index.d'
import type {
  ImpactQuery,
  ImpactResult,
  TagSchemaCommand,
  TagSchemaCommandResult,
  TagSchemaSnapshot,
  TagsProgressEvent
} from '@memry/contracts/tag-schema-api'
import type { RenameTagResponse } from '@memry/contracts/tags-api'
import type { GetLinkedHereResponse, SearchObjectsResponse } from '@memry/contracts/tag-objects-api'
import { commands, events } from '../../../generated/bindings'
import type { KeptNoteView, UnfinishedRenameView } from '../../../generated/bindings'
import { commandErrorCode, extractErrorMessage } from '../lib/ipc-error'
import { subscribeToEvent } from './tauri-event'

/**
 * Tags service. The methods in `ported` are the Rust commands of Step 13j (`commands/tags.rs`);
 * every other method still forwards to `window.api.tags`.
 *
 * `TagsClientAPI` is the shape of `window.api.tags` (the wire-level IPC
 * surface); most methods here forward 1:1 and are checked against it via
 * `TagsService` below. The three tag category methods that take flat
 * arguments (`createCategory`, `renameCategory`, `deleteCategory`) are
 * deliberately overridden for ergonomic call sites.
 */
type TagsService = Omit<
  TagsClientAPI,
  'createCategory' | 'renameCategory' | 'deleteCategory' | 'deleteTag' | 'mergeTag'
> & {
  createCategory: (name: string) => Promise<CreateCategoryResponse>
  renameCategory: (id: string, name: string) => Promise<CategoryOperationResponse>
  deleteCategory: (id: string) => Promise<CategoryOperationResponse>
  deleteTag: (tag: string) => Promise<DeleteTagResult>
  mergeTag: (input: { source: string; target: string }) => Promise<MergeTagResult>
}

/** A failed write as Electron's tag handlers answer it: the error's message. */
function failure(error: unknown): { success: false; error?: string } {
  const message = extractErrorMessage(error, '')
  return message ? { success: false, error: message } : { success: false }
}

/** A rename's answer; a failed one keeps its command's `code`, which tells a refusal apart. */
export type RenameTagResult = RenameTagResponse & { code?: string }

/**
 * The notes a merge or delete could not write, and whether asking again can finish them all;
 * a failed one keeps its command's `code`, which tells a refusal apart.
 */
export interface TagsKept {
  failedNotes?: KeptNoteView[]
  retryFinishes?: boolean
  code?: string
}

export type DeleteTagResult = DeleteTagResponse & TagsKept

export type MergeTagResult = MergeTagResponse & TagsKept

/** {@link failure}, keeping the command's `code`. */
function coded(error: unknown): { success: false; error?: string; code?: string } {
  const code = commandErrorCode(error)
  return { ...failure(error), ...(code ? { code } : {}) }
}

/** Runs a write that answers `{ success }`, a rejection becoming `{ success: false }`. */
async function settled(write: () => Promise<unknown>): Promise<TagOperationResponse> {
  try {
    await write()
    return { success: true }
  } catch (error) {
    return failure(error)
  }
}

/**
 * The tag commands of Step 13j. The list and a tag's notes reject on failure, as Electron's
 * handlers rethrow; the writes answer `{ success: false, error }`, as its handlers do.
 */
const ported = {
  getNotesByTag: (input: {
    tag: string
    sortBy?: 'modified' | 'created' | 'title'
    sortOrder?: 'asc' | 'desc'
    includeDescendants?: boolean
  }): Promise<GetNotesByTagResponse> => commands.tagsGetNotesByTag(input),

  updateTagColor: (input: { tag: string; color: string }): Promise<TagOperationResponse> =>
    settled(() => commands.tagsUpdateColor(input.tag, input.color)),

  /** A raw emoji or "icon:Name"; null clears it. */
  updateTagIcon: (input: { tag: string; icon: string | null }): Promise<TagOperationResponse> =>
    settled(() => commands.tagsUpdateIcon(input.tag, input.icon)),

  getAllWithCounts: async (): Promise<GetAllWithCountsResponse> => ({
    tags: await commands.tagsGetAllWithCounts()
  }),

  listCategories: async (): Promise<ListCategoriesResponse> => {
    try {
      return { success: true, categories: await commands.tagsListCategories() }
    } catch (error) {
      return failure(error)
    }
  },

  createCategory: async (name: string): Promise<CreateCategoryResponse> => {
    try {
      return { success: true, category: await commands.tagsCreateCategory(name) }
    } catch (error) {
      return failure(error)
    }
  },

  renameCategory: (id: string, name: string): Promise<CategoryOperationResponse> =>
    settled(() => commands.tagsRenameCategory(id, name)),

  /** Its tags become uncategorized, not deleted. */
  deleteCategory: (id: string): Promise<CategoryOperationResponse> =>
    settled(() => commands.tagsDeleteCategory(id)),

  /** A drag result: tag assignments and/or category order, in one call. */
  reorder: (payload: {
    tags?: TagAssignment[]
    categories?: { id: string; sortOrder: number }[]
  }): Promise<CategoryOperationResponse> => settled(() => commands.tagsReorder(payload)),

  pinNoteToTag: (input: { noteId: string; tag: string }): Promise<TagOperationResponse> =>
    settled(() => commands.tagsPinNoteToTag(input.noteId, input.tag)),

  unpinNoteFromTag: (input: { noteId: string; tag: string }): Promise<TagOperationResponse> =>
    settled(() => commands.tagsUnpinNoteFromTag(input.noteId, input.tag)),

  /** Every tag's resolved schema, the notes that are objects, and the ready-made tags. */
  getSchemaSnapshot: (): Promise<TagSchemaSnapshot> => commands.tagsGetSchemaSnapshot(),

  /** What a schema change would reach, counted for its dialog. */
  previewImpact: (query: ImpactQuery): Promise<ImpactResult> => commands.tagsPreviewImpact(query),
  /** The objects whose title matches, for the `@` menu and the relation picker. */
  searchObjects: (input: {
    query: string
    tag?: string
    limit?: number
  }): Promise<SearchObjectsResponse> => commands.tagsSearchObjects(input),

  /** One schema command; rejects with the refusal's message. A field rename tells its progress. */
  editSchema: (command: TagSchemaCommand): Promise<TagSchemaCommandResult> =>
    commands.tagsEditSchema(command),
  /** What points at a note: relation fields, task fields and wiki links. */
  getLinkedHere: (input: {
    noteId: string
    limitPerGroup?: number
  }): Promise<GetLinkedHereResponse> => commands.tagsGetLinkedHere(input),

  /** Renames the tag and its children in every note's file and record; `runId` names its progress. */
  renameTag: async (input: {
    oldName: string
    newName: string
    runId?: string
  }): Promise<RenameTagResult> => {
    try {
      return { success: true, ...(await commands.tagsRename(input)) }
    } catch (error) {
      return coded(error)
    }
  },

  /** Takes the tag itself, not its children, off every note, journal day and task. */
  deleteTag: async (tag: string): Promise<DeleteTagResult> => {
    try {
      return { success: true, ...(await commands.tagsDelete(tag)) }
    } catch (error) {
      return coded(error)
    }
  },

  removeTagFromNote: (input: { noteId: string; tag: string }): Promise<TagOperationResponse> =>
    settled(() => commands.tagsRemoveFromNote(input)),

  /** Merges the tag itself into `target` in every note, journal day and task. */
  mergeTag: async (input: { source: string; target: string }): Promise<MergeTagResult> => {
    try {
      return { success: true, ...(await commands.tagsMerge(input)) }
    } catch (error) {
      return coded(error)
    }
  }
}

/**
 * The rename left with notes it could not write, if any; none while one runs. Tauri only:
 * Electron forgets the notes it could not write.
 */
export function unfinishedTagRename(): Promise<UnfinishedRenameView | null> {
  return commands.tagsRenameUnfinished()
}

/**
 * Stops the rename left unfinished: the notes it wrote keep the new name, the ones it left the
 * old. `false` when none was left; rejects while a rename runs.
 */
export function stopTagRename(): Promise<boolean> {
  return commands.tagsRenameAbandon()
}

/** The tag methods served from Rust; `window.api.tags` is typed without them. */
export type PortedTagMethod = keyof typeof ported

export const tagsService: TagsService = {
  ...ported,

  /** Whether "Fill from note" shows, and what the first-run disclosure names. */
  getFillStatus: () => commands.tagsFillStatus(),

  /** Proposals for a note's empty fields from the inline AI model; the key stays in Rust. */
  fillFields: async (input) => {
    const result = await commands.tagsFillFields(input)
    if (result.kind !== 'proposals') return result
    // `create` is absent rather than null in `FieldFillProposal`.
    return {
      kind: 'proposals',
      proposals: result.proposals.map(({ create, ...proposal }) =>
        create ? { ...proposal, create } : proposal
      )
    }
  }
}

// ============================================================================
// Event Subscription Helpers
// ============================================================================

/**
 * Subscribe to tag renamed events.
 * @returns Unsubscribe function
 */
export function onTagRenamed(callback: (event: TagRenamedEvent) => void): () => void {
  return subscribeToEvent(events.tagRenamedEvent, callback)
}

/**
 * Subscribe to a tag rename's or a field rename's progress, each named by its `runId`.
 * @returns Unsubscribe function
 */
export function onTagsProgress(callback: (event: TagsProgressEvent) => void): () => void {
  return subscribeToEvent(events.tagsProgressEvent, callback)
}

/**
 * Subscribe to tag color updated events.
 * @returns Unsubscribe function
 */
export function onTagColorUpdated(callback: (event: TagColorUpdatedEvent) => void): () => void {
  return subscribeToEvent(events.tagColorUpdatedEvent, callback)
}

/**
 * Subscribe to tag deleted events: a tag deleted or merged into another.
 * @returns Unsubscribe function
 */
export function onTagDeleted(callback: (event: TagDeletedEvent) => void): () => void {
  return subscribeToEvent(events.tagDeletedEvent, callback)
}

/**
 * Subscribe to tag notes changed events (pin, unpin, removed; Rust sends no add yet).
 * @returns Unsubscribe function
 */
export function onTagNotesChanged(
  callback: (event: TagNotesChangedEvent) => void,
  onListening?: () => void
): () => void {
  return subscribeToEvent(events.tagNotesChangedEvent, callback, onListening)
}

/**
 * Subscribe to the property definitions a tag field or a ready-made tag created.
 * @returns Unsubscribe function
 */
export function onPropertyDefinitionChanged(
  callback: (event: { name: string }) => void
): () => void {
  return subscribeToEvent(events.propertyDefinitionChangedEvent, callback)
}

/**
 * Subscribe to tag category changed events (create/rename/delete/reorder). `onListening` runs
 * once they reach this page; a change before then sends its event to nobody.
 * @returns Unsubscribe function
 */
export function onTagCategoriesChanged(callback: () => void, onListening?: () => void): () => void {
  return subscribeToEvent(events.tagCategoriesChangedEvent, () => callback(), onListening)
}

/** The subscriptions above that Rust events serve; `window.api` is typed without them. */
export type PortedTagEvent =
  | 'onPropertyDefinitionChanged'
  | 'onTagColorUpdated'
  | 'onTagCategoriesChanged'
  | 'onTagDeleted'
  | 'onTagNotesChanged'
  | 'onTagRenamed'
  | 'onTagsProgress'

// ============================================================================
// Type Re-exports
// ============================================================================

export type {
  GetNotesByTagResponse,
  GetAllWithCountsResponse,
  MergeTagResponse,
  TagOperationResponse,
  RenameTagResponse,
  DeleteTagResponse,
  TagNoteItem,
  TagWithCount,
  TagRenamedEvent,
  TagColorUpdatedEvent,
  TagDeletedEvent,
  TagNotesChangedEvent,
  TagCategoryRow,
  TagAssignment,
  ListCategoriesResponse,
  CategoryOperationResponse,
  CreateCategoryResponse
} from '../../../preload/index.d'
