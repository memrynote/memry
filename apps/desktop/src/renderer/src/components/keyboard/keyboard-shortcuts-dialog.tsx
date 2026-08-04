/**
 * Keyboard Shortcuts Dialog
 * Shows all available keyboard shortcuts
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { isMac } from '@/hooks/use-keyboard-shortcuts-base'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'
import type { TFunction } from 'i18next'

interface ShortcutDefinition {
  combos: string[][]
  description: string
  detail?: string
}

interface ShortcutGroup {
  title: string
  description: string
  shortcuts: ShortcutDefinition[]
}

interface KeyboardShortcutsDialogProps {
  /** Whether dialog is open */
  isOpen: boolean
  /** Close handler */
  onClose: () => void
}

const getShortcutGroups = (t: TFunction<'common'>): ShortcutGroup[] => {
  const mod = isMac ? '⌘' : 'Ctrl'
  const shift = isMac ? '⇧' : 'Shift'
  const alt = isMac ? '⌥' : 'Alt'
  const backspace = isMac ? '⌫' : 'Backspace'

  return [
    {
      title: t('shortcuts.groups.general.title'),
      description: t('shortcuts.groups.general.description'),
      shortcuts: [
        {
          combos: [
            [mod, 'K'],
            [mod, 'P']
          ],
          description: t('shortcuts.items.general.quickSearch')
        },
        { combos: [[mod, 'N']], description: t('shortcuts.items.general.createNote') },
        { combos: [[mod, ',']], description: t('shortcuts.items.general.openSettings') },
        {
          combos: [['?'], [mod, '/']],
          description: t('shortcuts.items.general.keyboardShortcuts')
        },
        { combos: [[mod, 'Z']], description: t('shortcuts.items.general.undoTaskAction') },
        { combos: [[mod, 'B']], description: t('shortcuts.items.general.toggleSidebar') },
        { combos: [[mod, '1-6']], description: t('shortcuts.items.general.sidebarSection') }
      ]
    },
    {
      title: t('shortcuts.groups.tabs.title'),
      description: t('shortcuts.groups.tabs.description'),
      shortcuts: [
        { combos: [[mod, 'T']], description: t('shortcuts.items.tabs.newTabMenu') },
        { combos: [[mod, 'W']], description: t('shortcuts.items.tabs.closeTab') },
        { combos: [[mod, shift, 'W']], description: t('shortcuts.items.tabs.closeAllInPane') },
        { combos: [[mod, shift, 'T']], description: t('shortcuts.items.tabs.reopenClosedTab') },
        { combos: [['Ctrl', 'Tab']], description: t('shortcuts.items.tabs.nextTab') },
        { combos: [['Ctrl', shift, 'Tab']], description: t('shortcuts.items.tabs.previousTab') },
        { combos: [[mod, shift, 'P']], description: t('shortcuts.items.tabs.pinTab') },
        { combos: [[mod, shift, 'D']], description: t('shortcuts.items.tabs.duplicateTab') },
        { combos: [[mod, '\\']], description: t('shortcuts.items.tabs.splitRight') },
        { combos: [[mod, shift, '\\']], description: t('shortcuts.items.tabs.splitDown') },
        { combos: [[mod, alt, 'W']], description: t('shortcuts.items.tabs.closeSplitPane') },
        {
          combos: [[mod, 'K', 'then', mod, '←/→/↑/↓']],
          description: t('shortcuts.items.tabs.focusPane')
        },
        {
          combos: [[mod, 'K', 'then', mod, shift, '←/→']],
          description: t('shortcuts.items.tabs.moveTabToPane')
        },
        { combos: [[mod, 'K', 'then', 'M']], description: t('shortcuts.items.tabs.maximizePane') }
      ]
    },
    {
      title: t('shortcuts.groups.inbox.title'),
      description: t('shortcuts.groups.inbox.description'),
      shortcuts: [
        { combos: [['↓'], ['J']], description: t('shortcuts.items.inbox.nextItem') },
        { combos: [['↑'], ['K']], description: t('shortcuts.items.inbox.previousItem') },
        { combos: [['Home'], ['End']], description: t('shortcuts.items.inbox.firstOrLastItem') },
        { combos: [['PageUp'], ['PageDown']], description: t('shortcuts.items.inbox.jumpByPage') },
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
        { combos: [[mod, '\\']], description: t('shortcuts.items.journal.toggleFullWidth') },
        { combos: [[mod, 'F']], description: t('shortcuts.items.journal.find') },
        { combos: [[mod, 'B']], description: t('shortcuts.items.journal.bold') },
        { combos: [[mod, 'I']], description: t('shortcuts.items.journal.italic') },
        { combos: [[mod, 'U']], description: t('shortcuts.items.journal.underline') },
        { combos: [[mod, 'K']], description: t('shortcuts.items.journal.link') }
      ]
    },
    {
      title: t('shortcuts.groups.notes.title'),
      description: t('shortcuts.groups.notes.description'),
      shortcuts: [
        { combos: [[mod, 'N']], description: t('shortcuts.items.notes.createNote') },
        { combos: [[mod, 'S']], description: t('shortcuts.items.notes.saveNote') },
        { combos: [[mod, 'F']], description: t('shortcuts.items.notes.find') },
        { combos: [[mod, 'B']], description: t('shortcuts.items.notes.bold') },
        { combos: [[mod, 'I']], description: t('shortcuts.items.notes.italic') },
        { combos: [[mod, 'U']], description: t('shortcuts.items.notes.underline') },
        { combos: [[mod, 'K']], description: t('shortcuts.items.notes.link') },
        { combos: [['/']], description: t('shortcuts.items.notes.commandMenu') },
        { combos: [['Esc']], description: t('shortcuts.items.notes.closeOverlays') }
      ]
    },
    {
      title: t('shortcuts.groups.tasks.title'),
      description: t('shortcuts.groups.tasks.description'),
      shortcuts: [
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
        { combos: [[mod, ',']], description: t('shortcuts.items.settings.openSettings') },
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
  const shortcutGroups = getShortcutGroups(t)

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
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {group.description}
                  </p>
                </div>
                <div className="space-y-2">
                  {group.shortcuts.map((shortcut, shortcutIndex) => (
                    <div
                      key={`${shortcut.description}-${shortcutIndex}`}
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/45"
                    >
                      <div className="min-w-0">
                        <p className="text-sm leading-5 text-foreground">{shortcut.description}</p>
                        {shortcut.detail && (
                          <p className="text-xs leading-5 text-muted-foreground">
                            {shortcut.detail}
                          </p>
                        )}
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
          <ShortcutCombos combos={[[isMac ? '⌘' : 'Ctrl', '/'], ['?']]} />
          <span>
            {tPhaseF('phaseF.componentsKeyboardKeyboardShortcutsDialog.toToggleThisDialog')}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default KeyboardShortcutsDialog
