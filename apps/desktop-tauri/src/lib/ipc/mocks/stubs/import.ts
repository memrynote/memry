import type { MockRouteMap } from '../types'

// deferred:M8 - bulk import and native import dialogs are not M5 commands.
export const importRoutes: MockRouteMap = {
  notes_import_files: async () => ({
    success: false,
    imported: 0,
    failed: 0,
    errors: ['import-deferred-m8'],
    importedFiles: []
  }),
  notes_show_import_dialog: async () => ({
    canceled: true,
    filePaths: []
  })
}
