// Thin store wrapper so IPC handlers reach home-page persistence without importing
// database/queries directly (architecture boundary; mirrors bookmarks/store, tags/store).
export {
  listHomePages,
  getHomePage,
  insertHomePage,
  updateHomePage,
  deleteHomePage,
  reorderHomePages
} from '@main/database/queries/home-pages'
