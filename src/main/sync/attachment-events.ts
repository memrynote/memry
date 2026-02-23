import { EventEmitter } from 'node:events'
import { createLogger } from '../lib/logger'

const log = createLogger('AttachmentEvents')

interface AttachmentSavedEvent {
  noteId: string
  diskPath: string
}

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
}

export const attachmentEvents = new AttachmentEventBus()
