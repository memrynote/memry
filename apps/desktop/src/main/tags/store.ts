export {
  findNotesWithTagInfo,
  pinNoteToTag,
  unpinNoteFromTag,
  renameTag,
  deleteTag,
  removeTagFromNote,
  getOrCreateTag,
  deleteTagDefinition,
  renameTagDefinition,
  updateTagColor,
  updateTagIcon,
  getNoteTags,
  getNoteCacheById,
  noteIdsWithTag,
  findTagDefinition
} from '@main/database/queries/notes'
export { getAllTagsWithCounts, mergeTagInNotes, mergeTagInTasks } from '@main/database/queries/tags'
export {
  listTagCategories,
  createTagCategory,
  renameTagCategory,
  deleteTagCategory,
  reorderTags,
  reorderCategories,
  type TagCategoryRow,
  type TagAssignment
} from '@main/database/queries/tag-categories'
export { listTagItems, type TagItem } from '@main/database/queries/tag-items'
export { readTagViews } from '@main/database/queries/tag-definitions'
export { saveTagViews as writeTagViews } from './schema/views'
