import { createContext, useContext, type ReactNode } from 'react'

/**
 * The vault a workspace subtree belongs to. The renderer keeps recently visited
 * vaults mounted (hidden) next to the open one, so "the open vault" and "the
 * vault this component renders" can differ. Null outside any workspace, e.g.
 * on onboarding.
 */
const VaultScopeContext = createContext<string | null>(null)

export function VaultScopeProvider({
  vaultPath,
  children
}: {
  vaultPath: string
  children: ReactNode
}) {
  return <VaultScopeContext.Provider value={vaultPath}>{children}</VaultScopeContext.Provider>
}

export function useVaultScope(): string | null {
  return useContext(VaultScopeContext)
}
