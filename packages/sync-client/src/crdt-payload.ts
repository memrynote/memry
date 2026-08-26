/**
 * Size budgets for the CRDT incremental push path, in base64 characters —
 * that is what actually rides on the wire, and base64 inflates bytes by 4/3.
 *
 * Per update: the server stores every update as a BLOB inside a D1
 * `crdt_updates` row (`apps/sync-server/src/services/crdt.ts`), and a D1 row is
 * capped at 1,000,000 bytes. 1,200,000 chars decode to 900,000 bytes, which
 * leaves the rest of the row (ids, sequence, device, timestamps) inside the cap.
 * The route's own 5MB check is not the binding limit here; D1 is.
 *
 * Per request: `/sync/*` bodies are capped at 8 MiB (`MAX_BODY_BYTES_SYNC` in
 * `apps/sync-server/src/index.ts`), so a 6,000,000 char budget leaves ample room
 * for the JSON envelope around the updates.
 */
export const MAX_CRDT_UPDATE_PAYLOAD_CHARS = 1_200_000
export const MAX_CRDT_REQUEST_PAYLOAD_CHARS = 6_000_000

/**
 * The server's cap on `POST /sync/crdt/snapshot/batch`'s `snapshots` array.
 *
 * Sending more is a 400, so every producer chunks at this number rather than
 * discovering the ceiling on the wire. It lives here, next to the other CRDT
 * wire budgets, because both the provider (which decides how many notes to
 * prepare in one round) and the HTTP layer need it and neither should import
 * the other.
 */
export const MAX_CRDT_SNAPSHOT_BATCH_ENTRIES = 50

export interface CrdtUpdatePushPlan {
  /** Batches to POST in order. Every batch fits both budgets. */
  requests: string[][]
  /** Updates no single incremental request can carry. */
  oversized: string[]
}

/**
 * Split an encoded batch into requests the server will accept.
 *
 * Nothing is discarded: an update either lands in a request or in `oversized`,
 * and the caller must route `oversized` somewhere that converges (a full
 * snapshot push) rather than dropping it.
 */
export function planCrdtUpdatePush(b64Updates: string[]): CrdtUpdatePushPlan {
  const requests: string[][] = []
  const oversized: string[] = []
  let current: string[] = []
  let currentChars = 0

  for (const update of b64Updates) {
    if (update.length > MAX_CRDT_UPDATE_PAYLOAD_CHARS) {
      oversized.push(update)
      continue
    }
    if (current.length > 0 && currentChars + update.length > MAX_CRDT_REQUEST_PAYLOAD_CHARS) {
      requests.push(current)
      current = []
      currentChars = 0
    }
    current.push(update)
    currentChars += update.length
  }
  if (current.length > 0) requests.push(current)

  return { requests, oversized }
}
