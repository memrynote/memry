import type { HostMsg } from '@memry/contracts/webview-bridge'

/**
 * Which host messages the mounted document may act on (#2030).
 *
 * One WebView now serves every note, so a message is no longer addressed by
 * the fact that it arrived at all. The three messages that mutate the document
 * carry an id, and the rule for all of them lives here rather than repeated at
 * three `switch` arms, because the failure it prevents is silent: an edit
 * applied to the wrong note reads as a note that changed on its own.
 *
 * `y-update` has always been addressed and stays strict. `exec` and
 * `insert-attachment` gained an OPTIONAL id, so an unaddressed one still means
 * "whatever is mounted" — which is what `exec: flush` needs, since flushing
 * the bridge belongs to no document.
 */
export function isForMountedDoc(msg: HostMsg, mountedDocId: string | null): boolean {
  switch (msg.type) {
    case 'y-update':
      return msg.docId === mountedDocId
    case 'exec':
    case 'insert-attachment':
      return msg.docId === undefined || msg.docId === mountedDocId
    default:
      return true
  }
}
