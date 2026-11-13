/**
 * The renderer's seam to the portals commands (`portals_*`). Every call the
 * flows make goes through here, so the command shapes are named in one place.
 *
 * @module note/content-area/portal-flows/portal-api
 */

import type {
  PortalHost,
  PortalSearchInput,
  PortalSearchResult,
  PortalStampAnchorResult
} from '@memry/contracts/portals-api'
import { commands, events } from '../../../../../../generated/bindings'
import { subscribeToEvent } from '@/services/tauri-event'

export type { PortalHost, PortalSearchResultItem } from '@memry/contracts/portals-api'

/** Hosts that show `noteId` (or one block of it) through a portal. */
export async function getPortalUsage(noteId: string, anchor?: string): Promise<PortalHost[]> {
  const result = await commands.portalsGetUsage(noteId, anchor || null)
  return result.hosts.map(({ ordinal, ...host }) => (ordinal == null ? host : { ...host, ordinal }))
}

export async function stampPortalAnchor(
  noteId: string,
  blockId: string
): Promise<PortalStampAnchorResult> {
  const { anchor, reason } = await commands.portalsStampAnchor(noteId, blockId)
  if (anchor !== null) return { success: true, anchor }
  if (reason === null) throw new Error('portals_stamp_anchor answered neither anchor nor reason')
  return { success: false, reason }
}

export function searchPortalBlocks(input: PortalSearchInput): Promise<PortalSearchResult> {
  return commands.portalsSearch({
    text: input.text ?? null,
    tag: input.tag ?? null,
    limit: input.limit
  })
}

/** Fires with the source notes whose usage changed; returns the unsubscribe. */
export function onPortalUsageChanged(callback: (noteIds: string[]) => void): () => void {
  return subscribeToEvent(events.portalsUsageChangedEvent, (event) => callback(event.noteIds))
}
