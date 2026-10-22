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

/**
 * The id of this draw of the portal block, made once per mounted PortalBlock
 * render. Together with the block id it keys the portal's window, so two
 * editors showing the same block never share one.
 */
export const PortalInstanceContext = createContext<string | null>(null)

export function usePortalInstanceId(): string {
  const id = useContext(PortalInstanceContext)
  if (id === null) throw new Error('A portal view must render inside a PortalBlock')
  return id
}
