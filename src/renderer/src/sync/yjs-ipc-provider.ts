/**
 * Yjs IPC Provider for Renderer Process
 *
 * Connects a Y.Doc in the renderer process to the main process CrdtProvider
 * via IPC. Handles initial sync handshake and ongoing update synchronization.
 *
 * T129c: Create YjsIPCProvider for renderer
 * T129d: Initial Sync Handshake
 * T129e: Keep Awareness Local-Only
 *
 * @module sync/yjs-ipc-provider
 */

import * as Y from 'yjs'
import { Observable } from 'lib0/observable'
import { Awareness } from 'y-protocols/awareness'

import { uint8ArrayToBase64, base64ToUint8Array } from '@shared/utils/encoding'

export interface YjsIPCProviderEvents {
  synced: []
  'connection-error': [Error]
  destroy: []
}

export class YjsIPCProvider extends Observable<keyof YjsIPCProviderEvents> {
  private doc: Y.Doc
  private noteId: string
  private _synced = false
  private _connected = false
  private _destroyed = false
  private applyingRemote = false
  private unsubscribeRemoteUpdate: (() => void) | null = null

  public readonly awareness: Awareness

  constructor(noteId: string, doc: Y.Doc) {
    super()
    this.noteId = noteId
    this.doc = doc
    this.awareness = new Awareness(doc)
  }

  get synced(): boolean {
    return this._synced
  }

  get connected(): boolean {
    return this._connected
  }

  async connect(): Promise<void> {
    if (this._connected || this._destroyed) {
      return
    }

    try {
      const localSV = Y.encodeStateVector(this.doc)
      const localSVBase64 = uint8ArrayToBase64(localSV)

      const response = await window.api.yjs.syncRequest(this.noteId, localSVBase64)

      if (response.update && response.update.length > 0) {
        const updateBytes = base64ToUint8Array(response.update)
        Y.applyUpdate(this.doc, updateBytes, 'remote')
      }

      this.doc.on('update', this.handleDocUpdate)

      this.unsubscribeRemoteUpdate = window.api.onYjsUpdateReceived(this.handleRemoteUpdate)

      this._connected = true
      this._synced = true
      this.emit('synced', [])
    } catch (error) {
      console.error('[YjsIPCProvider] Connection failed:', error)
      this.emit('connection-error', [error instanceof Error ? error : new Error(String(error))])
      throw error
    }
  }

  disconnect(): void {
    if (!this._connected) {
      return
    }

    this.doc.off('update', this.handleDocUpdate)

    if (this.unsubscribeRemoteUpdate) {
      this.unsubscribeRemoteUpdate()
      this.unsubscribeRemoteUpdate = null
    }

    this._connected = false
    this._synced = false
  }

  private handleDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === 'remote' || this.applyingRemote) {
      return
    }

    const updateBase64 = uint8ArrayToBase64(update)
    void window.api.yjs.applyUpdate(this.noteId, updateBase64, 'local').catch((error) => {
      console.error('[YjsIPCProvider] Failed to send update:', error)
    })
  }

  private handleRemoteUpdate = (data: {
    noteId: string
    update: string
    sourceWindowId?: number
  }): void => {
    if (data.noteId !== this.noteId) {
      return
    }

    try {
      this.applyingRemote = true
      const updateBytes = base64ToUint8Array(data.update)
      Y.applyUpdate(this.doc, updateBytes, 'remote')
    } catch (error) {
      console.error('[YjsIPCProvider] Failed to apply remote update:', error)
    } finally {
      this.applyingRemote = false
    }
  }

  destroy(): void {
    if (this._destroyed) {
      return
    }

    this.disconnect()
    this.awareness.destroy()
    this._destroyed = true
    this.emit('destroy', [])
    super.destroy()
  }
}

export function createYjsIPCProvider(noteId: string, doc: Y.Doc): YjsIPCProvider {
  return new YjsIPCProvider(noteId, doc)
}
