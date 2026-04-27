import type { MockRouteMap } from '../types'

// deferred:M8 - PDF/HTML export is owned by the export milestone.
export const exportRoutes: MockRouteMap = {
  notes_export_pdf: async () => ({
    success: false,
    error: 'export-deferred-m8'
  }),
  notes_export_html: async () => ({
    success: false,
    error: 'export-deferred-m8'
  })
}
