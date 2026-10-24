/**
 * The seam to the portals IPC (`portals:*`). One owner: the insert flows'
 * `portal-flows/portal-api.ts` names the preload shape and the portal window
 * reuses it, so there is a single place that reads `window.api.portals`.
 *
 * @module note/content-area/portal/portal-api
 */

export {
  getPortalUsage,
  onPortalUsageChanged,
  searchPortalBlocks,
  stampPortalAnchor
} from '../portal-flows/portal-api'
export type { PortalHost, PortalSearchResultItem } from '../portal-flows/portal-api'
