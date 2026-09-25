import type { RecordPullItemResponse, RecordSyncItemType } from '@memry/contracts/sync-api'
import { SYNC_SOCKET_ITEMS_HEADER } from '@memry/contracts/sync-socket'

import type { Bindings } from '../types'
import { resolveSyncSubscription, SYNC_TYPES_HEADER } from './sync-types'

/**
 * Socket items (#2300, protocol 09 §9.13): the committed `/sync/pull` items of a
 * record push, attached to the `changes_available` frame of every socket that
 * opted in. The whole policy lives here: budget, kill switch, handshake
 * negotiation and the per-socket frame.
 */

/** Upper bound on one push's items on a frame. The env var can lower it, never raise it. */
export const DEFAULT_SOCKET_ITEMS_MAX_BYTES = 64 * 1024

/** `SYNC_SOCKET_ITEMS_MAX_BYTES="0"` turns every frame back to hint-only without a client release. */
export function socketItemsMaxBytes(env: Pick<Bindings, 'SYNC_SOCKET_ITEMS_MAX_BYTES'>): number {
  const raw = env.SYNC_SOCKET_ITEMS_MAX_BYTES?.trim()
  if (!raw) return DEFAULT_SOCKET_ITEMS_MAX_BYTES
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SOCKET_ITEMS_MAX_BYTES
  return Math.min(Math.floor(parsed), DEFAULT_SOCKET_ITEMS_MAX_BYTES)
}

/**
 * All or nothing: the committed items when their serialized size fits, else
 * undefined (today's hint-only frame). Never a truncated list: the wake pull
 * runs either way, so a partial list saves no round trip.
 */
export function selectSocketItems(
  items: readonly RecordPullItemResponse[],
  maxBytes: number
): RecordPullItemResponse[] | undefined {
  if (maxBytes <= 0 || items.length === 0) return undefined
  const size = new TextEncoder().encode(JSON.stringify(items)).byteLength
  return size <= maxBytes ? [...items] : undefined
}

/**
 * The record types a socket receives items for, or undefined when it did not
 * opt in. Types resolve exactly as on HTTP (`X-Memry-Sync-Types`), so a type
 * or `note_body` the socket never declared cannot reach it.
 */
export function socketItemTypesFromHandshake(headers: Headers): RecordSyncItemType[] | undefined {
  if (headers.get(SYNC_SOCKET_ITEMS_HEADER) !== '1') return undefined
  return [...resolveSyncSubscription(headers.get(SYNC_TYPES_HEADER)).recordTypes]
}

/**
 * One broadcast's frames, serialized once per distinct declared-type set. A
 * socket without item types, a broadcast without items, and a filter that
 * leaves nothing all get the hint-only frame, byte-identical to the frame sent
 * before socket items existed.
 */
export class SocketFrames {
  private readonly hintFrame: string
  private readonly byTypes = new Map<string, string>()

  constructor(
    private readonly base: { type: string; payload: Record<string, unknown> },
    private readonly items: readonly RecordPullItemResponse[] | undefined,
    private readonly committedAtMs: number | undefined
  ) {
    this.hintFrame = JSON.stringify(base)
  }

  /** Items this frame carries for these types; 0 means the hint-only frame. */
  itemCountFor(socketItemTypes: readonly RecordSyncItemType[] | undefined): number {
    return this.itemsFor(socketItemTypes).length
  }

  forSocket(socketItemTypes: readonly RecordSyncItemType[] | undefined): string {
    const items = this.itemsFor(socketItemTypes)
    if (items.length === 0) return this.hintFrame
    const key = socketItemTypes!.join(',')
    let frame = this.byTypes.get(key)
    if (frame === undefined) {
      frame = JSON.stringify({
        type: this.base.type,
        payload: {
          ...this.base.payload,
          ...(this.committedAtMs !== undefined ? { committedAtMs: this.committedAtMs } : {}),
          items
        }
      })
      this.byTypes.set(key, frame)
    }
    return frame
  }

  private itemsFor(
    socketItemTypes: readonly RecordSyncItemType[] | undefined
  ): RecordPullItemResponse[] {
    if (!socketItemTypes || !this.items || this.base.type !== 'changes_available') return []
    return this.items.filter((item) => socketItemTypes.includes(item.type))
  }
}
