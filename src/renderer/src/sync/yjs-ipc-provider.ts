import * as Y from 'yjs'
import { Observable } from 'lib0/observable'
import { createLogger } from '@/lib/logger'

const log = createLogger('YjsIpcProvider')

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

    this.ipcCleanup = window.api.onCrdtStateChanged(
      (data: { noteId: string; update: number[]; origin: string }) => {
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

    window.api.syncCrdt.closeDoc({ noteId: this.noteId })
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
      await window.api.syncCrdt.openDoc({ noteId: this.noteId })
    } catch {
      log.error('Failed to open doc', { noteId: this.noteId })
    }
  }

  private async performSyncHandshake(): Promise<void> {
    if (this.destroyed) return

    const stateVector = Y.encodeStateVector(this.doc)

    const result = await window.api.syncCrdt.syncStep1({
      noteId: this.noteId,
      stateVector: Array.from(stateVector)
    })

    if (this.destroyed) return

    if (result) {
      const diff = new Uint8Array(result.diff)
      Y.applyUpdate(this.doc, diff, 'ipc-provider')

      const localDiff = Y.encodeStateAsUpdate(this.doc, new Uint8Array(result.stateVector))
      if (localDiff.byteLength > 0) {
        await window.api.syncCrdt.syncStep2({
          noteId: this.noteId,
          diff: Array.from(localDiff)
        })
      }
    }

    if (this.destroyed) return

    this.synced = true
    this.emit('synced', [{ synced: true }])
    this.emit('status', [{ status: 'connected' }])
    log.debug('Sync handshake complete', { noteId: this.noteId })
  }

  private sendUpdate(update: Uint8Array): void {
    window.api.syncCrdt.applyUpdate({
      noteId: this.noteId,
      update: Array.from(update)
    })
  }
}
