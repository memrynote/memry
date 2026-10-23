import { useEffect, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Command } from 'cmdk'
import type { TFunction } from 'i18next'
import {
  COMMANDS,
  type CommandGroup,
  isKeyboardCommandId,
  type CommandId,
  type CommandMeta
} from '@memry/contracts/commands'
import { useT } from '@memry/i18n/renderer'
import { runCommand, useAvailableCommands } from '@/commands'
import { isMac } from '@/hooks/use-keyboard-shortcuts-base'
import {
  ArrowRight,
  CheckSquare,
  File,
  FileText,
  Folder,
  FolderKanban,
  HelpCircle,
  Layers,
  Layout,
  PanelLeft,
  Pencil,
  PenTool,
  Plus,
  RefreshCw,
  Settings,
  type AppIcon
} from '@/lib/icons'
import { getShortcutBinding, useShortcutOverrides } from '@/lib/shortcut-bindings'
import { bindingParts, type ShortcutId } from '@/lib/shortcut-catalog'
import { trackTelemetry } from '@/lib/telemetry'
import { SearchActionBar, type SearchAction } from '@/components/search/search-action-bar'
import { SearchInputBar } from '@/components/search/search-input-bar'
import { SearchGroupHeading, SearchKbd, SearchRow } from '@/components/search/search-row'
import { useCommandLabel } from './command-labels'
import { readCommandRecents, recordCommandRecent } from './command-recents'
import { buildSections, type PaletteCommand, type PaletteSection } from './palette-sections'

interface CommandsPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const GROUP_ICONS: Record<CommandGroup, AppIcon> = {
  navigation: ArrowRight,
  create: Plus,
  tabs: Layers,
  editor: Pencil,
  view: PanelLeft,
  app: Layout,
  note: FileText,
  project: FolderKanban,
  tasks: CheckSquare,
  canvas: PenTool,
  folder: Folder,
  file: File,
  settings: Settings,
  sync: RefreshCw,
  help: HelpCircle
}

/** The keys as one string: ⌘K on macOS, Ctrl+K elsewhere. */
const bindingText = (id: ShortcutId): string =>
  bindingParts(getShortcutBinding(id)).join(isMac ? '' : '+')

/**
 * The commands palette (⌘P). It lists what can run right now and runs the pick
 * through `runCommand`, after the palette has closed: a command that opens a
 * dialog must not have its focus taken back by this one's focus restoration.
 */
export function CommandsPalette({ open, onOpenChange }: CommandsPaletteProps): React.JSX.Element {
  const { t } = useT('common')
  const pendingRef = useRef<CommandId | null>(null)
  // Where the user was when the palette opened, read while rendering: by the
  // time a Radix open callback runs, the palette's own input has taken focus.
  const [wasOpen, setWasOpen] = useState(false)
  const [returnTo, setReturnTo] = useState<HTMLElement | null>(null)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open)
      setReturnTo(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  }

  // Radix would send focus to a trigger, and this palette has none, so focus goes
  // back where the user was, then the pick runs: a dialog it opens takes focus
  // from there, and records the user's place as the one to return to.
  const handleCloseAutoFocus = (event: Event): void => {
    event.preventDefault()
    const id = pendingRef.current
    pendingRef.current = null
    if (returnTo?.isConnected) returnTo.focus()
    if (id !== null) void runCommand(id, 'palette')
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/20 dark:bg-black/50" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onCloseAutoFocus={handleCloseAutoFocus}
          className="fixed inset-x-0 top-[14vh] z-50 mx-auto w-[calc(100%-2rem)] max-w-[640px] focus:outline-none"
        >
          <DialogPrimitive.Title className="sr-only">
            {t('commandsPalette.title')}
          </DialogPrimitive.Title>
          <CommandsPaletteBody
            onRun={(id) => {
              pendingRef.current = id
              onOpenChange(false)
            }}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function CommandsPaletteBody({ onRun }: { onRun: (id: CommandId) => void }): React.JSX.Element {
  const { t } = useT('common')
  const labelOf = useCommandLabel()
  const { commands: available, activeTabType } = useAvailableCommands()
  // Subscribes, so a rebind in Settings shows on the next render.
  useShortcutOverrides()
  const rootRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState('')
  // Read once per open: the list should not reshuffle under the cursor.
  const [recents] = useState(readCommandRecents)

  // The body mounts once per open, so this is one event per open.
  useEffect(() => {
    void trackTelemetry('command_palette_opened', {
      surface: 'app',
      action: 'opened',
      objectType: 'commands'
    })
  }, [])

  const commands = available.flatMap(({ id, label }): PaletteCommand[] => {
    const meta: CommandMeta = COMMANDS[id]
    if (meta.palette === false) return []
    return [
      {
        id,
        label: labelOf(id, label),
        keywords: [t(`commandsPalette.groups.${meta.group}`)],
        group: meta.group,
        context: meta.context,
        contextual: meta.context !== 'app',
        ...(isKeyboardCommandId(id) && { keyboardId: id })
      }
    ]
  })
  const sections = buildSections(commands, query, recents, activeTabType)
  const values = sections.flatMap((section) => section.commands.map((command) => command.id))
  // cmdk selects only when nothing is selected, so a value that left the list
  // (the query changed) falls back to the first row here.
  const selectedValue = values.includes(selected as CommandId) ? selected : (values[0] ?? '')

  const searchKeys = bindingText('nav.search')
  const runSelected = (): void =>
    rootRef.current?.querySelector<HTMLElement>('[cmdk-item][data-selected="true"]')?.click()
  const searchNotes: SearchAction = {
    label: t('commandsPalette.actions.searchNotes'),
    keyLabel: searchKeys,
    onRun: () => onRun('nav.search')
  }
  const run: SearchAction | null =
    values.length > 0
      ? { label: t('commandsPalette.actions.run'), keyLabel: '↵', onRun: runSelected }
      : null

  const select = (id: CommandId): void => {
    recordCommandRecent(id)
    onRun(id)
  }

  return (
    <Command
      ref={rootRef}
      label={t('commandsPalette.title')}
      shouldFilter={false}
      loop
      value={selectedValue}
      onValueChange={setSelected}
      className="flex flex-col overflow-hidden rounded-xl border border-border bg-popover
        shadow-[0_24px_48px_-12px_rgb(0_0_0/0.18),0_2px_6px_rgb(0_0_0/0.06)]"
    >
      <SearchInputBar
        value={query}
        onValueChange={setQuery}
        onKeyDown={IGNORE_KEY}
        placeholder={t('commandsPalette.placeholder')}
        hint={null}
        chips={[]}
        loading={false}
      />
      <Command.List className="h-[min(420px,60vh)] overflow-y-auto overscroll-contain p-1.5 [&>[cmdk-list-sizer]]:h-full">
        {sections.map((section) => (
          <Command.Group key={sectionKey(section)} heading={sectionHeading(section, t)}>
            {section.commands.map((command) => (
              <CommandRow key={command.id} command={command} onSelect={select} />
            ))}
          </Command.Group>
        ))}
        {sections.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 pb-10 text-center">
            <p className="text-sm font-medium leading-5 text-foreground">
              {t('commandsPalette.empty', { query: query.trim() })}
            </p>
            <p className="text-[13px] leading-[18px] text-text-tertiary">
              {t('commandsPalette.searchHint', { shortcut: searchKeys })}
            </p>
          </div>
        )}
      </Command.List>
      <SearchActionBar
        leading={searchNotes}
        status={
          query.trim() !== '' && values.length > 0
            ? t('commandsPalette.status.count', { count: values.length })
            : null
        }
        secondary={null}
        primary={run}
      />
    </Command>
  )
}

const IGNORE_KEY = (): void => {}

const sectionKey = (section: PaletteSection): string =>
  section.kind === 'context'
    ? `context:${section.context}`
    : section.kind === 'group'
      ? `group:${section.group}`
      : section.kind

function sectionHeading(
  section: PaletteSection,
  t: TFunction<'common'>
): React.JSX.Element | undefined {
  switch (section.kind) {
    case 'context':
      return <SearchGroupHeading label={t(`commandsPalette.contexts.${section.context}`)} />
    case 'recent':
      return <SearchGroupHeading label={t('commandsPalette.recent')} />
    case 'group':
      return <SearchGroupHeading label={t(`commandsPalette.groups.${section.group}`)} />
    case 'results':
      return undefined
  }
}

function CommandRow({
  command,
  onSelect
}: {
  command: PaletteCommand
  onSelect: (id: CommandId) => void
}): React.JSX.Element {
  const Icon = GROUP_ICONS[command.group]
  const { keyboardId } = command
  return (
    <SearchRow
      value={command.id}
      onSelect={() => onSelect(command.id)}
      icon={<Icon />}
      trailing={
        keyboardId ? (
          <span dir="ltr" className="flex items-center gap-1">
            {bindingParts(getShortcutBinding(keyboardId)).map((part) => (
              <SearchKbd key={part}>{part}</SearchKbd>
            ))}
          </span>
        ) : undefined
      }
    >
      {command.label}
    </SearchRow>
  )
}
