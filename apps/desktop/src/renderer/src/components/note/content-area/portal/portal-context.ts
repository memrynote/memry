import { createContext, useContext } from 'react'
import { ROOT_PORTAL_ANCESTRY, type PortalAncestry } from './portal-state'

/**
 * The portal windows the reader is already inside, outermost first. A portal
 * window provides it for the editor it mounts; a portal in an ordinary note
 * sees the empty root. This is where the cycle and depth guard reads from.
 */
export const PortalAncestryContext = createContext<PortalAncestry>(ROOT_PORTAL_ANCESTRY)

export function usePortalAncestry(): PortalAncestry {
  return useContext(PortalAncestryContext)
}
