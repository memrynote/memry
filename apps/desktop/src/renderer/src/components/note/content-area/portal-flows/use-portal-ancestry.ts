/**
 * The notes whose portals the editor is nested in, outermost first, as plain
 * ids: what the insert-time cycle guard compares a candidate source against.
 * Read from the context a portal window provides for the editor it mounts.
 *
 * @module note/content-area/portal-flows/use-portal-ancestry
 */

import { useMemo } from 'react'
import { usePortalAncestry } from '../portal/portal-context'

export function usePortalAncestryNotes(): readonly string[] {
  const ancestry = usePortalAncestry()
  return useMemo(() => ancestry.frames.map((frame) => frame.note), [ancestry])
}
