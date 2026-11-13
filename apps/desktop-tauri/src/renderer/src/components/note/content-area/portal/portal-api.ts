/**
 * The seam to the portals commands (`portals_*`). One owner: the insert flows'
 * `portal-flows/portal-api.ts` names the command shapes and the portal window
 * reuses it, so there is a single place that calls them.
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
