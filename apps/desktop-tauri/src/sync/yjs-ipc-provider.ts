import * as Y from 'yjs'
import { Observable } from 'lib0/observable'
import { createLogger } from '@/lib/logger'
import { invoke } from '@/lib/ipc/invoke'
import { subscribeEvent } from '@/lib/ipc/forwarder'

const log = createLogger('YjsIpcProvider')
const MAX_INLINE_UPDATE_BYTES = 8 * 1024
const CHUNK_SIZE_BYTES = 4 * 1024

export interface YjsIpcProviderConfig {
  noteId: string
  doc: Y.Doc
}

export class YjsIpcProvider extends Observable<string> {
  readonly noteId: string
  readonly doc: Y.Doc
  private synced = false
  private destroyed = false
  private updateHandler: ((update: Uint8Array, origin: unknown) => void) | null = null
  private ipcCleanup: (() => void) | null = null

  constructor(config: YjsIpcProviderConfig) {
    super()
    this.noteId = config.noteId
    this.doc = config.doc
  }

  async connect(): Promise<void> {
    this.updateHandler = (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote' || origin === 'ipc-provider') return
      this.sendUpdate(update)
    }
    this.doc.on('update', this.updateHandler)

    this.ipcCleanup = subscribeEvent<{ noteId: string; update: number[]; origin: number }>(
      'crdt-update',
      (data) => {
        if (data.noteId !== this.noteId) return
        const update = new Uint8Array(data.update)
        Y.applyUpdate(this.doc, update, 'remote')
        log.debug('Applied remote update', { noteId: this.noteId, bytes: update.byteLength })
      }
    )

    await this.openDoc()
    if (this.destroyed) return
    await this.performSyncHandshake()
  }

  disconnect(): void {
    if (this.updateHandler) {
      this.doc.off('update', this.updateHandler)
      this.updateHandler = null
    }

    if (this.ipcCleanup) {
      this.ipcCleanup()
      this.ipcCleanup = null
    }

    invoke('crdt_close_doc', { noteId: this.noteId }).catch((err: unknown) => {
      log.debug('closeDoc IPC failed (expected during teardown)', {
        noteId: this.noteId,
        error: err
      })
    })
    this.synced = false
    this.emit('status', [{ status: 'disconnected' }])
  }

  get isSynced(): boolean {
    return this.synced
  }

  destroy(): void {
    this.destroyed = true
    this.disconnect()
    super.destroy()
  }

  private async openDoc(): Promise<void> {
    try {
      await invoke('crdt_open_doc', { noteId: this.noteId })
    } catch {
      log.error('Failed to open doc', { noteId: this.noteId })
    }
  }

  private async performSyncHandshake(): Promise<void> {
    if (this.destroyed) return

    const stateVector = Y.encodeStateVector(this.doc)

    const result = await invoke<{ diff: number[]; stateVector: number[] }>('crdt_sync_step_1', {
      noteId: this.noteId,
      stateVector: Array.from(stateVector)
    })

    if (this.destroyed) return

    if (result) {
      const diff = new Uint8Array(result.diff)
      if (diff.byteLength > 0) {
        Y.applyUpdate(this.doc, diff, 'ipc-provider')
      }

      const localDiff = Y.encodeStateAsUpdate(this.doc, new Uint8Array(result.stateVector))
      if (localDiff.byteLength > 0) {
        await this.sendHandshakeDiff(localDiff)
      }
    }

    if (this.destroyed) return

    this.synced = true
    this.emit('synced', [{ synced: true }])
    this.emit('status', [{ status: 'connected' }])
    log.debug('Sync handshake complete', { noteId: this.noteId })
  }

  private sendUpdate(update: Uint8Array): void {
    void this.persistUpdate(update).catch((err: unknown) => {
      log.error('Failed to persist CRDT update', { noteId: this.noteId, error: err })
    })
  }

  private async sendHandshakeDiff(diff: Uint8Array): Promise<void> {
    if (diff.byteLength <= MAX_INLINE_UPDATE_BYTES) {
      await invoke('crdt_sync_step_2', {
        noteId: this.noteId,
        diff: Array.from(diff)
      })
      return
    }

    await this.persistChunkedUpdate(diff)
  }

  private async persistUpdate(update: Uint8Array): Promise<void> {
    if (update.byteLength <= MAX_INLINE_UPDATE_BYTES) {
      await invoke('crdt_apply_update', {
        input: {
          noteId: this.noteId,
          update: Array.from(update),
          origin: null
        }
      })
      return
    }

    await this.persistChunkedUpdate(update)
  }

  private async persistChunkedUpdate(update: Uint8Array): Promise<void> {
    const transferId = this.nextTransferId()
    await invoke('crdt_apply_update_chunk_start', {
      input: {
        noteId: this.noteId,
        transferId,
        totalBytes: update.byteLength
      }
    })

    for (let offset = 0; offset < update.byteLength; offset += CHUNK_SIZE_BYTES) {
      const bytes = update.slice(offset, offset + CHUNK_SIZE_BYTES)
      await invoke('crdt_apply_update_chunk_append', {
        input: {
          transferId,
          offset,
          bytes: Array.from(bytes)
        }
      })
    }

    await invoke('crdt_apply_update_chunk_finish', {
      input: {
        noteId: this.noteId,
        transferId,
        origin: null
      }
    })
  }

  private nextTransferId(): string {
    const suffix = Math.random().toString(36).slice(2)
    return `${this.noteId}-${Date.now()}-${suffix}`
  }
}
