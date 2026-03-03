import { EventEmitter } from 'node:events'
import { createLogger } from '../lib/logger'

const log = createLogger('AttachmentEvents')

interface AttachmentSavedEvent {
  noteId: string
  diskPath: string
}

interface AttachmentDownloadNeededEvent {
  noteId: string
  attachmentId: string
  diskPath: string
}

type DownloadNeededHandler = (event: AttachmentDownloadNeededEvent) => void

type SavedHandler = (event: AttachmentSavedEvent) => void

class AttachmentEventBus extends EventEmitter {
  emitSaved(event: AttachmentSavedEvent): void {
    log.debug('attachment saved', { noteId: event.noteId })
    this.emit('saved', event)
  }

  onSaved(handler: SavedHandler): void {
    this.on('saved', handler)
  }

  offSaved(handler: SavedHandler): void {
    this.off('saved', handler)
  }

  emitDownloadNeeded(event: AttachmentDownloadNeededEvent): void {
    log.debug('attachment download needed', {
      noteId: event.noteId,
      attachmentId: event.attachmentId
    })
    this.emit('download-needed', event)
  }

  onDownloadNeeded(handler: DownloadNeededHandler): void {
    this.on('download-needed', handler)
  }

  offDownloadNeeded(handler: DownloadNeededHandler): void {
    this.off('download-needed', handler)
  }
}

export const attachmentEvents = new AttachmentEventBus()
