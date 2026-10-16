import type {
  CommandContext,
  CommandGroup,
  CommandId,
  KeyboardCommandId
} from '@memry/contracts/commands'
import type { TabType } from '@/contexts/tabs/types'
import { rankCommands, type RankableCommand } from './rank-commands'

export interface PaletteCommand extends RankableCommand {
  readonly id: CommandId
  readonly group: CommandGroup
  readonly context: CommandContext
  /** Set when the command has a key, so the row can show its current binding. */
  readonly keyboardId?: KeyboardCommandId
}

type TabContext = Exclude<CommandContext, 'app'>

const isTabCommand = (
  command: PaletteCommand
): command is PaletteCommand & { readonly context: TabContext } => command.context !== 'app'

/**
 * What the active tab's section is called. A tag page runs the folder view's
 * commands, so the command's own context would call it a folder.
 */
export type ContextHeading = TabContext | 'tag'

export type SectionKind =
  /** The active tab's commands. */
  | { readonly kind: 'context'; readonly context: ContextHeading }
  | { readonly kind: 'recent' }
  | { readonly kind: 'group'; readonly group: CommandGroup }
  /** Ranked matches for a typed query, under no heading. */
  | { readonly kind: 'results' }

export type PaletteSection = SectionKind & { readonly commands: readonly PaletteCommand[] }

/** Where each group sits when no query is typed. A new group does not compile until it is placed. */
const GROUP_RANK = {
  navigation: 0,
  create: 1,
  tabs: 2,
  editor: 3,
  view: 4,
  settings: 5,
  sync: 6,
  help: 7,
  app: 8,
  note: 9,
  project: 10,
  tasks: 11,
  canvas: 12,
  folder: 13,
  file: 14
} as const satisfies Record<CommandGroup, number>

const GROUP_ORDER = (Object.keys(GROUP_RANK) as CommandGroup[]).sort(
  (a, b) => GROUP_RANK[a] - GROUP_RANK[b]
)

/**
 * What the palette lists. With no query: the active tab's commands, then the
 * recents, then the rest by group, each command once. With one: the ranked
 * matches, flat, because the heading a command sits under no longer matters.
 */
export function buildSections(
  commands: readonly PaletteCommand[],
  query: string,
  recents: readonly CommandId[],
  activeTabType: TabType | null = null
): PaletteSection[] {
  if (query.trim() !== '') {
    const commandsByRank = rankCommands(commands, query, recents)
    return commandsByRank.length === 0 ? [] : [{ kind: 'results', commands: commandsByRank }]
  }

  const sections: PaletteSection[] = []
  const shown = new Set<CommandId>()
  const take = (picked: readonly PaletteCommand[]): readonly PaletteCommand[] => {
    for (const command of picked) shown.add(command.id)
    return picked
  }

  const contextual = commands.filter(isTabCommand)
  if (contextual.length > 0) {
    sections.push({
      kind: 'context',
      context: activeTabType === 'tag' ? 'tag' : contextual[0].context,
      commands: take(contextual)
    })
  }

  const recent = recents.flatMap((id) =>
    commands.filter((command) => command.id === id && !shown.has(id))
  )
  if (recent.length > 0) sections.push({ kind: 'recent', commands: take(recent) })

  for (const group of GROUP_ORDER) {
    const inGroup = commands.filter((command) => command.group === group && !shown.has(command.id))
    if (inGroup.length > 0) sections.push({ kind: 'group', group, commands: inGroup })
  }
  return sections
}
