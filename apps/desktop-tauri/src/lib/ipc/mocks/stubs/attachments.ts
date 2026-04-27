import type { MockRouteMap } from '../types'

// deferred:M6 - real R2 upload/download lives in the sync engine milestone.
export const attachmentsRoutes: MockRouteMap = {
  notes_upload_attachment: async () => ({
    success: false,
    error: 'attachments-deferred-m6'
  }),
  notes_list_attachments: async () => [],
  notes_delete_attachment: async () => ({
    success: false,
    error: 'attachments-deferred-m6'
  })
}
