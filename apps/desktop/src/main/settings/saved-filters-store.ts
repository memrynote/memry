import * as settingsQueries from '@main/database/queries/settings'

type SavedFiltersDb = Parameters<typeof settingsQueries.listSavedFilters>[0]

export function listSavedFilters(db: SavedFiltersDb) {
  return settingsQueries.listSavedFilters(db)
}

export function getNextSavedFilterPosition(db: SavedFiltersDb) {
  return settingsQueries.getNextSavedFilterPosition(db)
}

export function insertSavedFilter(
  db: SavedFiltersDb,
  filter: Parameters<typeof settingsQueries.insertSavedFilter>[1]
) {
  return settingsQueries.insertSavedFilter(db, filter)
}

export function savedFilterExists(db: SavedFiltersDb, id: string) {
  return settingsQueries.savedFilterExists(db, id)
}

export function updateSavedFilter(
  db: SavedFiltersDb,
  id: string,
  updates: Parameters<typeof settingsQueries.updateSavedFilter>[2]
) {
  return settingsQueries.updateSavedFilter(db, id, updates)
}

export function getSavedFilterById(db: SavedFiltersDb, id: string) {
  return settingsQueries.getSavedFilterById(db, id)
}

export function deleteSavedFilter(db: SavedFiltersDb, id: string) {
  return settingsQueries.deleteSavedFilter(db, id)
}

export function reorderSavedFilters(db: SavedFiltersDb, ids: string[], positions: number[]) {
  return settingsQueries.reorderSavedFilters(db, ids, positions)
}
