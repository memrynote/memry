import { useSyncExternalStore } from 'react'
import { COMMANDS, type CommandId, type CommandOwner } from '@memry/contracts/commands'
import type { TabType } from '@/contexts/tabs/types'
import { createLogger } from '@/lib/logger'
import type { ActiveContext, CommandImpl } from './types'

const log = createLogger('Commands')

type ImplMap = Partial<Record<CommandId, CommandImpl>>

/** One registration per mounted owner call site. `read` returns the owner's latest closures. */
interface Registration {
  readonly read: () => ImplMap
}

/**
 * Registrations by owner, then by scope key. An app owner registers once under
 * its own name. A tab owner registers once per open tab under the tab's id, so
 * two panes showing the same page keep two registrations and only the active
 * tab's one resolves.
 */
const slots = new Map<CommandOwner, Map<string, Registration>>()

let context: ActiveContext = { activeTabId: null, activeGroupId: '' }

export interface AvailableCommand {
  readonly id: CommandId
  /** Dynamic label override, e.g. "Unpin Tab". Absent: use the i18n label. */
  readonly label?: string
}

export interface AvailabilitySnapshot {
  readonly activeTabId: string | null
  readonly activeTabType: TabType | null
  readonly commands: readonly AvailableCommand[]
}

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- COMMANDS is keyed by CommandId; Object.keys only widens to string
const COMMAND_IDS = Object.keys(COMMANDS) as CommandId[]

let snapshot: AvailabilitySnapshot = { activeTabId: null, activeTabType: null, commands: [] }
let signature = ''
const listeners = new Set<() => void>()

function resolveImpl(id: CommandId): CommandImpl | undefined {
  const owner = COMMANDS[id].owner
  const ownerSlots = slots.get(owner)
  if (!ownerSlots) return undefined
  const registration =
    ownerSlots.get(owner) ??
    (context.activeTabId === null ? undefined : ownerSlots.get(context.activeTabId))
  return registration?.read()[id]
}

/** Synchronous, so the keydown listener can decide whether to consume the key. */
export function isCommandAvailable(id: CommandId): boolean {
  const impl = resolveImpl(id)
  return impl !== undefined && impl.enabled !== false
}

export function getCommandImpl(id: CommandId): CommandImpl | undefined {
  const impl = resolveImpl(id)
  return impl !== undefined && impl.enabled !== false ? impl : undefined
}

/**
 * Recompute what is available and tell subscribers only when it changed. Owners
 * call this after committing new closures, so a re-render that changes nothing
 * a palette could show stays silent.
 */
export function revalidateCommands(): void {
  const commands: AvailableCommand[] = []
  for (const id of COMMAND_IDS) {
    const impl = resolveImpl(id)
    if (impl === undefined || impl.enabled === false) continue
    commands.push(impl.label === undefined ? { id } : { id, label: impl.label })
  }
  const activeTabType = context.activeTabType ?? null
  const next = JSON.stringify([context.activeTabId, activeTabType, commands])
  if (next === signature) return
  signature = next
  snapshot = { activeTabId: context.activeTabId, activeTabType, commands }
  for (const listener of Array.from(listeners)) listener()
}

/**
 * Register an owner's behavior while its call site is mounted. A second
 * registration of the same slot warns in development and replaces the first:
 * HMR and overlapping workspace mounts can produce one, and neither is worth a crash.
 */
export function registerCommands(
  owner: CommandOwner,
  scopeKey: string,
  read: () => ImplMap
): () => void {
  let ownerSlots = slots.get(owner)
  if (!ownerSlots) {
    ownerSlots = new Map()
    slots.set(owner, ownerSlots)
  }
  if (import.meta.env.DEV && ownerSlots.has(scopeKey)) {
    log.warn(`Duplicate command registration for "${owner}" in scope "${scopeKey}"`)
  }
  const registration: Registration = { read }
  ownerSlots.set(scopeKey, registration)
  revalidateCommands()

  return () => {
    // A replaced registration's late cleanup must not remove its replacement.
    if (ownerSlots.get(scopeKey) !== registration) return
    ownerSlots.delete(scopeKey)
    revalidateCommands()
  }
}

/** Single writer: the tabs bridge. Tab-scoped owners resolve against `activeTabId`. */
export function publishActiveContext(next: ActiveContext): void {
  if (
    next.activeTabId === context.activeTabId &&
    next.activeGroupId === context.activeGroupId &&
    (next.activeTabType ?? null) === (context.activeTabType ?? null)
  ) {
    return
  }
  context = next
  revalidateCommands()
}

export function getActiveContext(): ActiveContext {
  return context
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): AvailabilitySnapshot {
  return snapshot
}

/** The commands that can run right now. Re-renders only when that set, a label, or the active tab changes. */
export function useAvailableCommands(): AvailabilitySnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Test seam: drop every registration and the active context. */
export function resetCommandStoreForTests(): void {
  slots.clear()
  context = { activeTabId: null, activeGroupId: '' }
  signature = ''
  snapshot = { activeTabId: null, activeTabType: null, commands: [] }
  listeners.clear()
}
