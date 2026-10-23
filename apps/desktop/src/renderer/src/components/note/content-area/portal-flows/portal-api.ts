/**
 * The renderer's seam to the portals IPC (`portals:*`). Every call the flows
 * make goes through here, so the preload shape is named in one place.
 *
 * @module note/content-area/portal-flows/portal-api
 */

import type {
  PortalGetUsageInput,
  PortalGetUsageResult,
  PortalHost,
  PortalSearchInput,
  PortalSearchResult,
  PortalStampAnchorInput,
  PortalStampAnchorResult
} from '@memry/contracts/portals-api'

export type { PortalHost, PortalSearchResultItem } from '@memry/contracts/portals-api'

/** What the preload exposes as `window.api.portals`. */
export interface PortalsPreloadApi {
  getUsage: (input: PortalGetUsageInput) => Promise<PortalGetUsageResult>
  stampAnchor: (input: PortalStampAnchorInput) => Promise<PortalStampAnchorResult>
  search: (input: PortalSearchInput) => Promise<PortalSearchResult>
  /** Fires with the source notes whose usage changed; returns the unsubscribe. */
  onUsageChanged: (callback: (event: { noteIds: string[] }) => void) => () => void
}

function portalsApi(): PortalsPreloadApi {
  const api = (window.api as unknown as { portals?: PortalsPreloadApi }).portals
  if (!api) throw new Error('portals API is not available in this build')
  return api
}

/** Hosts that show `noteId` (or one block of it) through a portal. */
export async function getPortalUsage(noteId: string, anchor?: string): Promise<PortalHost[]> {
  const result = await portalsApi().getUsage(anchor ? { noteId, anchor } : { noteId })
  return result.hosts
}

export function stampPortalAnchor(
  noteId: string,
  blockId: string
): Promise<PortalStampAnchorResult> {
  return portalsApi().stampAnchor({ noteId, blockId })
}

export function searchPortalBlocks(input: PortalSearchInput): Promise<PortalSearchResult> {
  return portalsApi().search(input)
}

export function onPortalUsageChanged(callback: (noteIds: string[]) => void): () => void {
  return portalsApi().onUsageChanged((event) => callback(event.noteIds))
}
