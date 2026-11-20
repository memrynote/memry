import type {
  AttachmentMaterializedEvent,
  AttachmentUploadFailedEvent
} from '@memry/contracts/ipc-events'
import { events } from '../../../generated/bindings'
import { subscribeToEvent } from './tauri-event'

/**
 * `sync:attachment-materialized`: a download of the note's attachment landed, so an open note
 * resolves its attachments again.
 */
export function onAttachmentMaterialized(
  callback: (event: AttachmentMaterializedEvent) => void
): () => void {
  return subscribeToEvent(events.syncAttachmentMaterializedEvent, callback)
}

/**
 * `sync:attachment-upload-failed`: an attachment of the note failed to download or will not
 * upload. Rust sends no `errorCategory`, so the renderer shows its generic message.
 */
export function onAttachmentUploadFailed(
  callback: (event: AttachmentUploadFailedEvent) => void
): () => void {
  return subscribeToEvent(events.syncAttachmentUploadFailedEvent, callback)
}
