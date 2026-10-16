/**
 * Keyboard Shortcuts Dialog
 * Lists every command that has a keyboard entry, plus a few fixed page shortcuts
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { isMac } from '@/hooks/use-keyboard-shortcuts-base'
import { getShortcutBinding, useShortcutOverrides } from '@/lib/shortcut-bindings'
import {
  bindingParts,
  SHORTCUT_ENTRIES,
  SHORTCUT_GROUP_ORDER,
  type ShortcutId
} from '@/lib/shortcut-catalog'
import { cn } from '@/lib/utils'
import { COMMANDS, type CommandGroup, type CommandMeta } from '@memry/contracts/commands'
import type { ShortcutBinding } from '@memry/contracts/settings-schemas'
import { useT } from '@memry/i18n/renderer'
import type { TFunction } from 'i18next'

interface ShortcutDefinition {
  combos: string[][]
  description: string
}

interface ShortcutGroup {
  title: string
  description?: string
  shortcuts: ShortcutDefinition[]
}

interface KeyboardShortcutsDialogProps {
  /** Whether dialog is open */
  isOpen: boolean
  /** Close handler */
  onClose: () => void
}

/** Keycaps for a command as it is bound right now, rebinds included. */
const bound = (id: ShortcutId): string[] => bindingParts(getShortcutBinding(id))

/** The chords a command answers to besides its own binding, as the dispatcher sees them. */
const aliasCombos = (id: ShortcutId, isRebound: boolean): string[][] => {
  const meta: CommandMeta = COMMANDS[id]
  const keyboard = meta.keyboard
  if (keyboard?.owner !== 'app') return []
  return (keyboard.aliases ?? [])
    .filter((alias) => !(alias.whileDefault && isRebound))
    .map((alias) => bindingParts(alias.chord))
}

/**
 * Every command with a keyboard entry, grouped like Settings → Shortcuts. The
 * only hand-written rows in this dialog are the fixed page shortcuts below.
 */
const getCommandGroups = (
  tSettings: TFunction<'settings'>,
  overrides: Readonly<Record<string, ShortcutBinding>>
): Map<CommandGroup, ShortcutDefinition[]> => {
  const groups = new Map<CommandGroup, ShortcutDefinition[]>()
  for (const { id, group, i18nKey } of SHORTCUT_ENTRIES) {
    const rows = groups.get(group) ?? []
    rows.push({
      combos: [bound(id), ...aliasCombos(id, overrides[id] !== undefined)],
      description: tSettings(`shortcuts.entries.${i18nKey}.label`)
    })
    groups.set(group, rows)
  }
  return groups
}

/**
 * Fixed shortcuts that belong to one surface or to a multi-key chord. They are
 * not commands: no palette row, no Settings → Shortcuts entry, no rebinding.
 * Anything that is a command comes from `getCommandGroups`, never from here.
 */
const getFixedShortcuts = (
  t: TFunction<'common'>
): {
  /** Extra rows appended to a command group. */
  inGroup: Partial<Record<CommandGroup, ShortcutDefinition[]>>
  /** Sections made only of fixed shortcuts. */
  sections: ShortcutGroup[]
} => {
  const mod = isMac ? '⌘' : 'Ctrl'
  const shift = isMac ? '⇧' : 'Shift'
  const backspace = isMac ? '⌫' : 'Backspace'

  return {
    inGroup: {
      navigation: [
        { combos: [[mod, '1-6']], description: t('shortcuts.items.general.sidebarSection') }
      ],
      tabs: [
        {
          combos: [[mod, 'K', 'then', mod, '←/→/↑/↓']],
          description: t('shortcuts.items.tabs.focusPane')
        },
        {
          combos: [[mod, 'K', 'then', mod, shift, '←/→']],
          description: t('shortcuts.items.tabs.moveTabToPane')
        },
        { combos: [[mod, 'K', 'then', 'M']], description: t('shortcuts.items.tabs.maximizePane') }
      ],
      editor: [
        { combos: [[mod, 'F']], description: t('shortcuts.items.notes.find') },
        { combos: [['/']], description: t('shortcuts.items.notes.commandMenu') },
        { combos: [['Esc']], description: t('shortcuts.items.notes.closeOverlays') }
      ]
    },
    sections: [
      {
        title: t('shortcuts.groups.inbox.title'),
        description: t('shortcuts.groups.inbox.description'),
        shortcuts: [
          { combos: [['↓'], ['J']], description: t('shortcuts.items.inbox.nextItem') },
          { combos: [['↑'], ['K']], description: t('shortcuts.items.inbox.previousItem') },
          { combos: [['Home'], ['End']], description: t('shortcuts.items.inbox.firstOrLastItem') },
          {
            combos: [['PageUp'], ['PageDown']],
            description: t('shortcuts.items.inbox.jumpByPage')
          },
          { combos: [['Space']], description: t('shortcuts.items.inbox.togglePreview') },
          { combos: [['X']], description: t('shortcuts.items.inbox.selectItem') },
          { combos: [[mod, 'A']], description: t('shortcuts.items.inbox.selectAllVisible') },
          { combos: [['Esc']], description: t('shortcuts.items.inbox.clearSelection') },
          { combos: [['.'], ['F']], description: t('shortcuts.items.inbox.openQuickFile') },
          { combos: [['1-5']], description: t('shortcuts.items.inbox.chooseQuickFileResult') },
          {
            combos: [['Delete'], [backspace]],
            description: t('shortcuts.items.inbox.archiveItem')
          },
          { combos: [['O']], description: t('shortcuts.items.inbox.openOriginal') },
          { combos: [['R']], description: t('shortcuts.items.inbox.refresh') },
          { combos: [[mod, 'Enter']], description: t('shortcuts.items.inbox.confirmFiling') }
        ]
      },
      {
        title: t('shortcuts.groups.journal.title'),
        description: t('shortcuts.groups.journal.description'),
        shortcuts: [
          { combos: [['Esc']], description: t('shortcuts.items.journal.returnFromOverview') },
          { combos: [[mod, 'F']], description: t('shortcuts.items.journal.find') }
        ]
      },
      {
        title: t('shortcuts.groups.tasks.title'),
        description: t('shortcuts.groups.tasks.description'),
        shortcuts: [
          { combos: [[mod, 'Z']], description: t('shortcuts.items.general.undoTaskAction') },
          { combos: [[shift, 'F']], description: t('shortcuts.items.tasks.clearFilters') },
          { combos: [[mod, 'A']], description: t('shortcuts.items.tasks.selectAllVisible') },
          { combos: [['Esc']], description: t('shortcuts.items.tasks.clearSelection') },
          { combos: [[mod, 'Enter']], description: t('shortcuts.items.tasks.completeSelected') },
          { combos: [[mod, backspace]], description: t('shortcuts.items.tasks.deleteSelected') },
          { combos: [['R']], description: t('shortcuts.items.tasks.configureRepeat') },
          { combos: [[shift, 'S']], description: t('shortcuts.items.tasks.skipOccurrence') },
          { combos: [[shift, 'X']], description: t('shortcuts.items.tasks.stopRepeating') }
        ]
      },
      {
        title: t('shortcuts.groups.settings.title'),
        description: t('shortcuts.groups.settings.description'),
        shortcuts: [
          {
            combos: [[t('shortcuts.combos.shortcutsTab')]],
            description: t('shortcuts.items.settings.customizeShortcuts')
          },
          {
            combos: [[t('shortcuts.combos.clickRow')]],
            description: t('shortcuts.items.settings.recordShortcut')
          },
          { combos: [['Esc']], description: t('shortcuts.items.settings.cancelRecording') },
          {
            combos: [[t('shortcuts.combos.reset')]],
            description: t('shortcuts.items.settings.resetShortcut')
          }
        ]
      }
    ]
  }
}

const getShortcutGroups = (
  t: TFunction<'common'>,
  tSettings: TFunction<'settings'>,
  overrides: Readonly<Record<string, ShortcutBinding>>
): ShortcutGroup[] => {
  const commandGroups = getCommandGroups(tSettings, overrides)
  const fixed = getFixedShortcuts(t)

  return [
    ...SHORTCUT_GROUP_ORDER.map((group) => ({
      title: tSettings(`shortcuts.categories.${group}`),
      shortcuts: [...(commandGroups.get(group) ?? []), ...(fixed.inGroup[group] ?? [])]
    })),
    ...fixed.sections
  ]
}

const ShortcutCombo = ({ keys }: { keys: string[] }): React.JSX.Element => {
  const { t } = useT('common')

  return (
    <span className="inline-flex items-center gap-1">
      {keys.map((key, index) =>
        key === 'then' ? (
          <span key={`${key}-${index}`} className="px-0.5 text-[11px] text-muted-foreground/70">
            {t('shortcuts.then')}
          </span>
        ) : (
          <kbd
            key={`${key}-${index}`}
            className={cn(
              'inline-flex min-w-6 items-center justify-center rounded border border-border',
              'bg-background px-1.5 py-0.5 font-mono text-[11px] font-medium leading-4',
              'text-foreground shadow-[inset_0_-1px_0_rgba(0,0,0,0.08)]'
            )}
          >
            {key}
          </kbd>
        )
      )}
    </span>
  )
}

const ShortcutCombos = ({ combos }: { combos: string[][] }): React.JSX.Element => {
  const { t } = useT('common')

  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      {combos.map((keys, index) => (
        <span key={keys.join('-')} className="inline-flex items-center gap-1.5">
          {index > 0 && (
            <span className="text-[11px] text-muted-foreground/60">{t('shortcuts.or')}</span>
          )}
          <ShortcutCombo keys={keys} />
        </span>
      ))}
    </div>
  )
}

/**
 * Dialog showing all keyboard shortcuts
 */
export const KeyboardShortcutsDialog = ({
  isOpen,
  onClose
}: KeyboardShortcutsDialogProps): React.JSX.Element => {
  const { t: tPhaseF } = useT('settings')
  const { t } = useT('common')
  const overrides = useShortcutOverrides()
  const shortcutGroups = getShortcutGroups(t, tPhaseF, overrides)

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[86vh] max-w-[960px] gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border bg-muted/20 px-6 py-5 text-start">
          <DialogTitle className="text-xl">
            {tPhaseF('phaseF.componentsKeyboardKeyboardShortcutsDialog.keyboardShortcuts')}
          </DialogTitle>
          <DialogDescription>{t('shortcuts.description')}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[calc(86vh-8.75rem)] overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {shortcutGroups.map((group, groupIndex) => (
              <section
                key={`${group.title}-${groupIndex}`}
                className="rounded-lg border border-border bg-card/60 p-4 shadow-sm"
              >
                <div className="mb-3">
                  <h3 className="text-sm font-semibold text-foreground">{group.title}</h3>
                  {group.description && (
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {group.description}
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  {group.shortcuts.map((shortcut, shortcutIndex) => (
                    <div
                      key={`${shortcut.description}-${shortcutIndex}`}
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/45"
                    >
                      <div className="min-w-0">
                        <p className="text-sm leading-5 text-foreground">{shortcut.description}</p>
                      </div>
                      <ShortcutCombos combos={shortcut.combos} />
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-center gap-2 border-t border-border bg-muted/20 px-6 py-3 text-xs text-muted-foreground">
          <span>{tPhaseF('phaseF.componentsKeyboardKeyboardShortcutsDialog.press')}</span>
          <ShortcutCombos combos={[bound('view.shortcuts'), ['?']]} />
          <span>
            {tPhaseF('phaseF.componentsKeyboardKeyboardShortcutsDialog.toToggleThisDialog')}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default KeyboardShortcutsDialog
