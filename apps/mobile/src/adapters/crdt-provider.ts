import type { CrdtProviderHost, CrdtTransport } from '@memry/sync-client/adapters'
import { createLogger } from '../lib/logger'

const log = createLogger('MobileCrdtProviderHost')

/**
 * Seam 8 on mobile, US1 shape: read-only US1 opens no engine-owned docs, so
 * this host only honours the structural contract — `attach` subscribes the
 * transport synchronously and returns a working detach. Phase 4's WebView
 * bridge doc manager replaces the body of `attach` with real Y.Doc wiring
 * (origin-tagged against echo loops).
 */
export function createMobileCrdtProviderHost(): CrdtProviderHost {
  return {
    attach(docId: string, transport: CrdtTransport): () => void {
      const unsubscribe = transport.onFromUi((frames) => {
        log.warn('CRDT frames received while the mobile write path is not wired (US1 read-only)', {
          docId,
          frames: frames.length,
          originTag: transport.originTag
        })
      })
      return () => {
        unsubscribe()
      }
    }
  }
}
