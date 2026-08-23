import { SyncEventEmitter } from '@memry/sync-client/emitter'
import { createLogger } from './logging'

const log = createLogger('AttachmentEvents')

interface AttachmentSavedEvent {
  noteId: string
  diskPath: string
}

interface AttachmentDownloadNeededEvent {
  noteId: string
  attachmentId: string
  /**
   * Where to materialize the file. With `intoDir` unset this is the exact
   * target file path (binary-note flow). With `intoDir: true` it is the
   * note's attachments DIRECTORY — the final filename is only known after
   * the encrypted manifest is fetched and decrypted (embedded-attachment flow).
   */
  diskPath: string
  intoDir?: boolean
}

type DownloadNeededHandler = (event: AttachmentDownloadNeededEvent) => void

type SavedHandler = (event: AttachmentSavedEvent) => void

class AttachmentEventBus extends SyncEventEmitter {
  /**
   * Returns whether the event reached at least one listener.
   *
   * `unregisterAttachmentHandlers()` calls `removeAllListeners(...)`, so a
   * zero-listener window is real during sync-runtime restart, sign-out/in and
   * token churn. Discarding `EventEmitter.emit`'s boolean made a drop
   * indistinguishable from a delivery, and callers that dedupe (see
   * `requestEmbeddedAttachmentDownloads` in item-handlers/note-handler.ts)
   * recorded the request anyway — so the attachment was never asked for again
   * for the life of the process.
   *
   * Backward compatibility: widening the return type from `void` to `boolean`
   * is purely local to this process. Nothing here is persisted, sent over IPC,
   * or put on the wire, so no older build and no on-disk/served payload can
   * observe the change; existing callers that ignore the value keep compiling
   * and behaving exactly as before.
   */
  emitSaved(event: AttachmentSavedEvent): boolean {
    log.debug('attachment saved', { noteId: event.noteId })
    const delivered = this.emit('saved', event)
    if (!delivered) {
      // noteId only — the absolute host path must never reach the log.
      log.warn('attachment saved event dropped: no listener registered', { noteId: event.noteId })
    }
    return delivered
  }

  onSaved(handler: SavedHandler): void {
    this.on('saved', handler)
  }

  offSaved(handler: SavedHandler): void {
    this.off('saved', handler)
  }

  /** See {@link emitSaved} — same delivery signal, same compat reasoning. */
  emitDownloadNeeded(event: AttachmentDownloadNeededEvent): boolean {
    log.debug('attachment download needed', {
      noteId: event.noteId,
      attachmentId: event.attachmentId
    })
    const delivered = this.emit('download-needed', event)
    if (!delivered) {
      // Ids only — `diskPath` must never reach the log.
      log.warn('attachment download-needed event dropped: no listener registered', {
        noteId: event.noteId,
        attachmentId: event.attachmentId
      })
    }
    return delivered
  }

  onDownloadNeeded(handler: DownloadNeededHandler): void {
    this.on('download-needed', handler)
  }

  offDownloadNeeded(handler: DownloadNeededHandler): void {
    this.off('download-needed', handler)
  }
}

export const attachmentEvents = new AttachmentEventBus()
