/**
 * Tab Identity Context
 *
 * Published by `TabContent` so anything rendered inside a tab can learn WHICH
 * tab it is in. `useActiveTab()` answers a different question — it returns the
 * globally active tab — and is therefore wrong for a page living in the inactive
 * pane of a split view. New tab-scoped state (scroll restore, view state) must
 * key off this context instead.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react'

export interface TabIdentity {
  /** Id of the tab this subtree is rendered inside */
  tabId: string
  /** Id of the tab group (pane) that owns the tab */
  groupId: string
  /** Entity the tab currently points at, if any (note id, canvas id, …) */
  entityId?: string
}

const TabIdentityContext = createContext<TabIdentity | null>(null)

interface TabIdentityProviderProps extends TabIdentity {
  children: ReactNode
}

export function TabIdentityProvider({
  tabId,
  groupId,
  entityId,
  children
}: TabIdentityProviderProps): React.JSX.Element {
  const value = useMemo<TabIdentity>(
    () => ({ tabId, groupId, entityId }),
    [tabId, groupId, entityId]
  )

  return <TabIdentityContext.Provider value={value}>{children}</TabIdentityContext.Provider>
}

/**
 * Identity of the tab the caller is rendered in, or `null` outside a tab
 * (settings panes, dialogs, tests). Consumers must treat `null` as "no tab-scoped
 * state available" and degrade rather than throw.
 */
export function useTabIdentity(): TabIdentity | null {
  return useContext(TabIdentityContext)
}
