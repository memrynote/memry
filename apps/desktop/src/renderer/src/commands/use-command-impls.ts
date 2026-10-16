import { useEffect, useRef } from 'react'
import type { CommandId, CommandOwner } from '@memry/contracts/commands'
import { useTabIdentity } from '@/contexts/tabs/tab-identity'
import { registerCommands, revalidateCommands } from './store'
import type { CommandImpl, OwnerImpls } from './types'

type ImplMap = Partial<Record<CommandId, CommandImpl>>

/**
 * `scopeKey === null` registers nothing (a tab owner rendered outside a tab).
 * Closures go into a ref in an effect, never during render, so a render React
 * discards cannot leak its closures into the keyboard path.
 */
function useRegistration(owner: CommandOwner, scopeKey: string | null, impls: ImplMap): void {
  const implsRef = useRef(impls)

  useEffect(() => {
    implsRef.current = impls
    revalidateCommands()
  })

  useEffect(() => {
    if (scopeKey === null) return
    return registerCommands(owner, scopeKey, () => implsRef.current)
  }, [owner, scopeKey])
}

/**
 * Supply the behavior for an owner that exists once per app. Call it from one
 * mounted component; the type demands every id the owner's slice names.
 */
export function useAppCommands<O extends CommandOwner>(owner: O, impls: OwnerImpls<O>): void {
  useRegistration(owner, owner, impls)
}

/**
 * Supply the behavior for an owner that exists once per open tab (a page). The
 * registration is keyed by the tab it renders in, so only the active tab's
 * implementation resolves. Outside a tab it registers nothing.
 */
export function useTabCommands<O extends CommandOwner>(owner: O, impls: OwnerImpls<O>): void {
  useRegistration(owner, useTabIdentity()?.tabId ?? null, impls)
}
