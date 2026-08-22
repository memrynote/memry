/**
 * Seam 8 — how a UI surface attaches to an engine-owned Y.Doc.
 *
 * Desktop: the IPC provider (renderer ↔ main). Mobile: the WebView bridge
 * provider. `originTag` is what stops an echo loop — desktop tags updates with
 * `sourceWindowId`, mobile with the bridge session id; an untagged transport
 * re-applies its own writes forever.
 */
export interface CrdtTransport {
  /** Batched on purpose: one frame per keystroke is what the bridge rig ruled out. */
  sendToUi(frames: Uint8Array[]): void
  onFromUi(cb: (frames: Uint8Array[]) => void): () => void
  originTag: string
}

export interface CrdtProviderHost {
  /** Returns the detach function for this attachment. */
  attach(docId: string, transport: CrdtTransport): () => void
}
