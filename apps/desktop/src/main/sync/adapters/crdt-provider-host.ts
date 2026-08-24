import * as Y from 'yjs'
import type { CrdtProviderHost, CrdtTransport } from '@memry/sync-client/adapters'
import { createLogger } from '../../lib/logger'
import type { CrdtProvider } from '../crdt-provider'

const log = createLogger('CrdtProviderHost')

/**
 * Seam 8 implemented over the engine-owned `CrdtProvider`.
 *
 * Desktop's renderer editors keep using the IPC provider path directly
 * (`applyIpcUpdate` / window broadcasts) — this host exists for transports that
 * speak the seam: it opens the engine's doc, forwards its updates to the UI,
 * and applies UI frames back under a per-attachment origin so the echo guard
 * holds. The origin object is the loop-breaker: updates this attachment
 * applies are never sent back to the same transport, and everything else —
 * engine merges, other windows, network pulls — is.
 */
export class DesktopCrdtProviderHost implements CrdtProviderHost {
  constructor(private readonly provider: Pick<CrdtProvider, 'open'>) {}

  attach(docId: string, transport: CrdtTransport): () => void {
    let detached = false
    let doc: Y.Doc | null = null
    /** Frames arriving before the async open resolves; replayed in order. */
    const pendingFromUi: Uint8Array[] = []
    const origin = { source: 'crdt-provider-host', tag: transport.originTag }

    const onDocUpdate = (update: Uint8Array, updateOrigin: unknown): void => {
      if (updateOrigin === origin) return
      transport.sendToUi([update])
    }

    const unsubscribeUi = transport.onFromUi((frames) => {
      if (detached) return
      if (!doc) {
        pendingFromUi.push(...frames)
        return
      }
      for (const frame of frames) Y.applyUpdate(doc, frame, origin)
    })

    void this.provider
      .open(docId)
      .then((opened) => {
        if (detached) return
        doc = opened
        doc.on('update', onDocUpdate)
        // A late attach must not start blind: hand the transport the full
        // current state first, then replay what the UI sent while opening.
        transport.sendToUi([Y.encodeStateAsUpdate(doc)])
        for (const frame of pendingFromUi.splice(0)) Y.applyUpdate(doc, frame, origin)
      })
      .catch((err) => {
        log.error('CrdtProviderHost attach failed to open the doc', { docId, error: err })
      })

    return () => {
      detached = true
      unsubscribeUi()
      doc?.off('update', onDocUpdate)
      doc = null
    }
  }
}
