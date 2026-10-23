/**
 * Inside a portal window, "delete this block" has a gentler answer: hide it
 * from the portal. The portal window provides the handler; the delete guard in
 * the nested editor reads it. Outside a portal there is no provider, and the
 * guard offers no such answer.
 *
 * @module note/content-area/portal-flows/portal-remove-context
 */

import { createContext } from 'react'

export type RemoveFromPortal = (blockIds: readonly string[]) => void

export const PortalRemoveFromContext = createContext<RemoveFromPortal | undefined>(undefined)
