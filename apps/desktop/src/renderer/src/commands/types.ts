import type { CommandIdsOf, CommandOwner } from '@memry/contracts/commands'
import type { TabType } from '@/contexts/tabs/types'

/** Who asked for the command. Only `'keyboard'` is held back while hint mode or a vault switch is active. */
export type CommandSource = 'keyboard' | 'menu' | 'palette' | 'ui'

/**
 * - `ran`: the command's `run` returned (or resolved).
 * - `unavailable`: no owner is registered for it in the active context, or it is disabled.
 * - `blocked`: a keystroke arrived while hint mode or a vault switch is active.
 * - `failed`: `run` threw or rejected. Logged, and the user sees a toast.
 */
export type CommandOutcome = 'ran' | 'unavailable' | 'blocked' | 'failed'

export interface RunContext {
  readonly source: CommandSource
}

export interface CommandImpl {
  /** Never prompts. A destructive command confirms inside its own `run`. */
  run: (ctx: RunContext) => void | Promise<void>
  /** `false` makes the command unavailable: its key passes through and the palette hides it. */
  enabled?: boolean
  /** Replaces the i18n label, e.g. "Unpin Tab". */
  label?: string
}

/** Every id the owner's slice of `COMMANDS` names, so a new command cannot ship without behavior. */
export type OwnerImpls<O extends CommandOwner> = { readonly [K in CommandIdsOf<O>]: CommandImpl }

/** The tab the user is working in. Published by the tabs bridge and nobody else. */
export interface ActiveContext {
  readonly activeTabId: string | null
  readonly activeGroupId: string
  /** What the active tab shows. Absent where only the tab's identity matters. */
  readonly activeTabType?: TabType | null
}
