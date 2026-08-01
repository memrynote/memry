import { TagsChannels } from '@memry/contracts/ipc-channels'
import { invoke, subscribe } from '../lib/ipc'

export const tagsApi = {
  getNotesByTag: (input: {
    tag: string
    sortBy?: 'modified' | 'created' | 'title'
    sortOrder?: 'asc' | 'desc'
    includeDescendants?: boolean
  }) => invoke(TagsChannels.invoke.GET_NOTES_BY_TAG, input),
  pinNoteToTag: (input: { noteId: string; tag: string }) =>
    invoke(TagsChannels.invoke.PIN_NOTE_TO_TAG, input),
  unpinNoteFromTag: (input: { noteId: string; tag: string }) =>
    invoke(TagsChannels.invoke.UNPIN_NOTE_FROM_TAG, input),
  renameTag: (input: { oldName: string; newName: string }) =>
    invoke(TagsChannels.invoke.RENAME_TAG, input),
  updateTagColor: (input: { tag: string; color: string }) =>
    invoke(TagsChannels.invoke.UPDATE_TAG_COLOR, input),
  updateTagIcon: (input: { tag: string; icon: string | null }) =>
    invoke(TagsChannels.invoke.UPDATE_TAG_ICON, input),
  deleteTag: (tag: string) => invoke(TagsChannels.invoke.DELETE_TAG, tag),
  removeTagFromNote: (input: { noteId: string; tag: string }) =>
    invoke(TagsChannels.invoke.REMOVE_TAG_FROM_NOTE, input),
  getAllWithCounts: () => invoke(TagsChannels.invoke.GET_ALL_WITH_COUNTS),
  mergeTag: (input: { source: string; target: string }) =>
    invoke(TagsChannels.invoke.MERGE_TAG, input),
  listCategories: () => invoke(TagsChannels.invoke.LIST_CATEGORIES),
  createCategory: (input: { name: string }) => invoke(TagsChannels.invoke.CREATE_CATEGORY, input),
  renameCategory: (input: { id: string; name: string }) =>
    invoke(TagsChannels.invoke.RENAME_CATEGORY, input),
  deleteCategory: (input: { id: string }) => invoke(TagsChannels.invoke.DELETE_CATEGORY, input),
  reorder: (input: {
    tags?: { tag: string; categoryId: string | null; sortOrder: number }[]
    categories?: { id: string; sortOrder: number }[]
  }) => invoke(TagsChannels.invoke.REORDER, input)
}

export const tagEvents = {
  onTagRenamed: (
    callback: (event: { oldName: string; newName: string; affectedNotes: number }) => void
  ): (() => void) =>
    subscribe<{ oldName: string; newName: string; affectedNotes: number }>(
      TagsChannels.events.RENAMED,
      callback
    ),

  onTagColorUpdated: (callback: (event: { tag: string; color: string }) => void): (() => void) =>
    subscribe<{ tag: string; color: string }>(TagsChannels.events.COLOR_UPDATED, callback),

  onTagDeleted: (callback: (event: { tag: string; affectedNotes: number }) => void): (() => void) =>
    subscribe<{ tag: string; affectedNotes: number }>(TagsChannels.events.DELETED, callback),

  onTagNotesChanged: (
    callback: (event: {
      tag: string
      noteId: string
      action: 'pinned' | 'unpinned' | 'removed' | 'added'
    }) => void
  ): (() => void) =>
    subscribe<{
      tag: string
      noteId: string
      action: 'pinned' | 'unpinned' | 'removed' | 'added'
    }>(TagsChannels.events.NOTES_CHANGED, callback),

  onTagCategoriesChanged: (callback: () => void): (() => void) =>
    subscribe(TagsChannels.events.CATEGORIES_CHANGED, callback)
}
