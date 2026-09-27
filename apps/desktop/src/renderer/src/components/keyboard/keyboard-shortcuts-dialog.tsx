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
import { getShortcutBinding } from '@/lib/shortcut-bindings'
import { bindingParts, type ShortcutId } from '@/lib/shortcut-registry'
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

/** Keycaps for a registry shortcut as it is bound right now, rebinds included. */
const bound = (id: ShortcutId): string[] => bindingParts(getShortcutBinding(id))

const getShortcutGroups = (
  t: TFunction<'common'>,
  tSettings: TFunction<'settings'>
): ShortcutGroup[] => {
  const mod = isMac ? '⌘' : 'Ctrl'
  const shift = isMac ? '⇧' : 'Shift'
  const backspace = isMac ? '⌫' : 'Backspace'

  return [
    {
      title: t('shortcuts.groups.general.title'),
      description: t('shortcuts.groups.general.description'),
      shortcuts: [
        {
          // ⌘P is a fixed alias kept for muscle memory from other editors.
          combos: [bound('nav.search'), [mod, 'P']],
          description: t('shortcuts.items.general.quickSearch')
        },
        { combos: [bound('nav.newNote')], description: t('shortcuts.items.general.createNote') },
        {
          combos: [bound('nav.settings')],
          description: t('shortcuts.items.general.openSettings')
        },
        {
          combos: [bound('nav.switchVault')],
          description: t('shortcuts.items.general.switchVault')
        },
        {
          combos: [bound('nav.prevVault'), bound('nav.nextVault')],
          description: t('shortcuts.items.general.adjacentVault')
        },
        {
          combos: [['?'], bound('view.shortcuts')],
          description: t('shortcuts.items.general.keyboardShortcuts')
        },
        { combos: [[mod, 'Z']], description: t('shortcuts.items.general.undoTaskAction') },
        {
          combos: [bound('view.toggleSidebar')],
          description: t('shortcuts.items.general.toggleSidebar')
        },
        { combos: [[mod, '1-6']], description: t('shortcuts.items.general.sidebarSection') },
        {
          combos: [bound('view.zoomIn')],
          description: tSettings('shortcuts.entries.view.zoomIn.label')
        },
        {
          combos: [bound('view.zoomOut')],
          description: tSettings('shortcuts.entries.view.zoomOut.label')
        },
        {
          combos: [bound('view.actualSize')],
          description: tSettings('shortcuts.entries.view.actualSize.label')
        }
      ]
    },
    {
      title: t('shortcuts.groups.tabs.title'),
      description: t('shortcuts.groups.tabs.description'),
      shortcuts: [
        { combos: [bound('tabs.newTab')], description: t('shortcuts.items.tabs.newTabMenu') },
        { combos: [bound('tabs.closeTab')], description: t('shortcuts.items.tabs.closeTab') },
        {
          combos: [bound('tabs.closeAllTabs')],
          description: t('shortcuts.items.tabs.closeAllInPane')
        },
        {
          combos: [bound('tabs.reopenTab')],
          description: t('shortcuts.items.tabs.reopenClosedTab')
        },
        { combos: [bound('tabs.nextTab')], description: t('shortcuts.items.tabs.nextTab') },
        { combos: [bound('tabs.prevTab')], description: t('shortcuts.items.tabs.previousTab') },
        {
          combos: [bound('tabs.navBack')],
          description: tSettings('shortcuts.entries.tabs.navBack.label')
        },
        {
          combos: [bound('tabs.navForward')],
          description: tSettings('shortcuts.entries.tabs.navForward.label')
        },
        { combos: [bound('tabs.pinTab')], description: t('shortcuts.items.tabs.pinTab') },
        {
          combos: [bound('tabs.duplicateTab')],
          description: t('shortcuts.items.tabs.duplicateTab')
        },
        { combos: [bound('tabs.splitRight')], description: t('shortcuts.items.tabs.splitRight') },
        { combos: [bound('tabs.splitDown')], description: t('shortcuts.items.tabs.splitDown') },
        {
          combos: [bound('tabs.closeSplit')],
          description: t('shortcuts.items.tabs.closeSplitPane')
        },
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
        { combos: [[mod, 'F']], description: t('shortcuts.items.journal.find') },
        { combos: [bound('editor.bold')], description: t('shortcuts.items.journal.bold') },
        { combos: [bound('editor.italic')], description: t('shortcuts.items.journal.italic') },
        { combos: [bound('editor.underline')], description: t('shortcuts.items.journal.underline') }
      ]
    },
    {
      title: t('shortcuts.groups.notes.title'),
      description: t('shortcuts.groups.notes.description'),
      shortcuts: [
        { combos: [bound('nav.newNote')], description: t('shortcuts.items.notes.createNote') },
        { combos: [[mod, 'F']], description: t('shortcuts.items.notes.find') },
        { combos: [bound('editor.bold')], description: t('shortcuts.items.notes.bold') },
        { combos: [bound('editor.italic')], description: t('shortcuts.items.notes.italic') },
        { combos: [bound('editor.underline')], description: t('shortcuts.items.notes.underline') },
        {
          combos: [bound('editor.strikethrough')],
          description: tSettings('shortcuts.entries.editor.strikethrough.label')
        },
        {
          combos: [bound('editor.code')],
          description: tSettings('shortcuts.entries.editor.code.label')
        },
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
        {
          combos: [bound('nav.settings')],
          description: t('shortcuts.items.settings.openSettings')
        },
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
  const shortcutGroups = getShortcutGroups(t, tPhaseF)

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
