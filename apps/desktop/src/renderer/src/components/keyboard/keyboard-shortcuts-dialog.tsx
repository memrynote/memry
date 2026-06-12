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

const DIALOG_DESCRIPTION =
  'Fast paths for moving around memrynote, capturing thoughts, and processing work.'
const COMBO_OR_LABEL = 'or'
const SEQUENCE_THEN_LABEL = 'then'

export const getShortcutGroups = (): ShortcutGroup[] => {
  const mod = isMac ? '⌘' : 'Ctrl'
  const shift = isMac ? '⇧' : 'Shift'
  const alt = isMac ? '⌥' : 'Alt'
  const backspace = isMac ? '⌫' : 'Backspace'

  return [
    {
      title: 'General',
      description: 'App-wide navigation and help.',
      shortcuts: [
        {
          combos: [
            [mod, 'K'],
            [mod, 'P']
          ],
          description: 'Open quick search'
        },
        { combos: [[mod, 'N']], description: 'Create a note' },
        { combos: [[mod, ',']], description: 'Open settings' },
        { combos: [['?'], [mod, '/']], description: 'Open keyboard shortcuts' },
        { combos: [[mod, 'Z']], description: 'Undo last task action' },
        { combos: [[mod, 'B']], description: 'Toggle the sidebar' }
      ]
    },
    {
      title: 'Tabs & Splits',
      description: 'Move between tabs and panes.',
      shortcuts: [
        { combos: [[mod, 'T']], description: 'Open the new tab menu' },
        { combos: [[mod, 'W']], description: 'Close tab' },
        { combos: [[mod, shift, 'W']], description: 'Close all tabs in pane' },
        { combos: [[mod, shift, 'T']], description: 'Reopen closed tab' },
        { combos: [['Ctrl', 'Tab']], description: 'Next tab' },
        { combos: [['Ctrl', shift, 'Tab']], description: 'Previous tab' },
        {
          combos: [
            [mod, '1-8'],
            [mod, '9']
          ],
          description: 'Jump to tab'
        },
        { combos: [[mod, shift, 'P']], description: 'Pin or unpin tab' },
        { combos: [[mod, shift, 'D']], description: 'Duplicate tab' },
        { combos: [[mod, '\\']], description: 'Split right' },
        { combos: [[mod, shift, '\\']], description: 'Split down' },
        { combos: [[mod, alt, 'W']], description: 'Close split pane' },
        { combos: [[mod, 'K', 'then', mod, '←/→/↑/↓']], description: 'Focus another pane' },
        { combos: [[mod, 'K', 'then', mod, shift, '←/→']], description: 'Move tab to pane' },
        { combos: [[mod, 'K', 'then', 'M']], description: 'Maximize current pane' }
      ]
    },
    {
      title: 'Inbox',
      description: 'Process captured items quickly.',
      shortcuts: [
        { combos: [['↓'], ['J']], description: 'Next item' },
        { combos: [['↑'], ['K']], description: 'Previous item' },
        { combos: [['Home'], ['End']], description: 'First or last item' },
        { combos: [['PageUp'], ['PageDown']], description: 'Jump by page' },
        { combos: [['Space']], description: 'Toggle preview panel' },
        { combos: [['X']], description: 'Select item' },
        { combos: [[mod, 'A']], description: 'Select all visible items' },
        { combos: [['Esc']], description: 'Clear selection or close quick file' },
        { combos: [['.'], ['F']], description: 'Open quick file' },
        { combos: [['1-5']], description: 'Choose a quick-file result' },
        { combos: [['Delete'], [backspace]], description: 'Archive selected item' },
        { combos: [['O']], description: 'Open original link' },
        { combos: [['R']], description: 'Refresh inbox' },
        { combos: [[mod, 'Enter']], description: 'Confirm filing panel' }
      ]
    },
    {
      title: 'Journal',
      description: 'Navigate journal views and focus the writing area.',
      shortcuts: [
        { combos: [['Esc']], description: 'Return from month or year view' },
        { combos: [[mod, '\\']], description: 'Toggle full-width journal' },
        { combos: [[mod, 'F']], description: 'Find in journal' },
        { combos: [[mod, 'B']], description: 'Bold selected text' },
        { combos: [[mod, 'I']], description: 'Italic selected text' },
        { combos: [[mod, 'U']], description: 'Underline selected text' },
        { combos: [[mod, 'K']], description: 'Add or edit link' }
      ]
    },
    {
      title: 'Notes / Editor',
      description: 'Write, format, and search notes.',
      shortcuts: [
        { combos: [[mod, 'N']], description: 'Create a note' },
        { combos: [[mod, 'S']], description: 'Save current note' },
        { combos: [[mod, 'F']], description: 'Find in note' },
        { combos: [[mod, 'B']], description: 'Bold' },
        { combos: [[mod, 'I']], description: 'Italic' },
        { combos: [[mod, 'U']], description: 'Underline' },
        { combos: [[mod, 'K']], description: 'Add or edit link' },
        { combos: [['/']], description: 'Open editor command menu' },
        { combos: [['Esc']], description: 'Close editor overlays' }
      ]
    },
    {
      title: 'Tasks',
      description: 'Filter, select, and complete tasks.',
      shortcuts: [
        { combos: [[shift, 'F']], description: 'Clear visible filters' },
        { combos: [[mod, 'A']], description: 'Select all visible tasks' },
        { combos: [['Esc']], description: 'Clear task selection' },
        { combos: [[mod, 'Enter']], description: 'Complete selected tasks' },
        { combos: [[mod, backspace]], description: 'Delete selected tasks' },
        { combos: [['R']], description: 'Configure repeat on focused task' },
        { combos: [[shift, 'S']], description: 'Skip repeat occurrence' },
        { combos: [[shift, 'X']], description: 'Stop repeating task' }
      ]
    },
    {
      title: 'Settings',
      description: 'Open settings and customize shortcuts.',
      shortcuts: [
        { combos: [[mod, ',']], description: 'Open settings' },
        { combos: [['Shortcuts tab']], description: 'Customize keyboard shortcuts' },
        { combos: [['Click row']], description: 'Record a new shortcut' },
        { combos: [['Esc']], description: 'Cancel shortcut recording' },
        { combos: [['Reset']], description: 'Restore a shortcut default' }
      ]
    }
  ]
}

const ShortcutCombo = ({ keys }: { keys: string[] }): React.JSX.Element => (
  <span className="inline-flex items-center gap-1">
    {keys.map((key, index) =>
      key === 'then' ? (
        <span key={`${key}-${index}`} className="px-0.5 text-[11px] text-muted-foreground/70">
          {SEQUENCE_THEN_LABEL}
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

const ShortcutCombos = ({ combos }: { combos: string[][] }): React.JSX.Element => (
  <div className="flex flex-wrap items-center justify-end gap-1.5">
    {combos.map((keys, index) => (
      <span key={`${keys.join('-')}-${index}`} className="inline-flex items-center gap-1.5">
        {index > 0 && (
          <span className="text-[11px] text-muted-foreground/60">{COMBO_OR_LABEL}</span>
        )}
        <ShortcutCombo keys={keys} />
      </span>
    ))}
  </div>
)

/**
 * Dialog showing all keyboard shortcuts
 */
export const KeyboardShortcutsDialog = ({
  isOpen,
  onClose
}: KeyboardShortcutsDialogProps): React.JSX.Element => {
  const { t: tPhaseF } = useT('settings')
  const shortcutGroups = getShortcutGroups()

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[86vh] max-w-[960px] gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border bg-muted/20 px-6 py-5 text-start">
          <DialogTitle className="text-xl">
            {tPhaseF('phaseF.componentsKeyboardKeyboardShortcutsDialog.keyboardShortcuts')}
          </DialogTitle>
          <DialogDescription>{DIALOG_DESCRIPTION}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[calc(86vh-8.75rem)] overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {shortcutGroups.map((group) => (
              <section
                key={group.title}
                className="rounded-lg border border-border bg-card/60 p-4 shadow-sm"
              >
                <div className="mb-3">
                  <h3 className="text-sm font-semibold text-foreground">{group.title}</h3>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {group.description}
                  </p>
                </div>
                <div className="space-y-2">
                  {group.shortcuts.map((shortcut) => (
                    <div
                      key={shortcut.description}
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
