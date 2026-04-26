import type { MockRouteMap } from '../types'

// deferred:M8 - version snapshots/restore/delete are owned by the history milestone.
export const versionsRoutes: MockRouteMap = {
  notes_get_versions: async () => [],
  notes_get_version: async () => null,
  notes_restore_version: async () => ({
    success: false,
    note: null,
    error: 'versions-deferred-m8'
  }),
  notes_delete_version: async () => ({
    success: false,
    error: 'versions-deferred-m8'
  })
}
