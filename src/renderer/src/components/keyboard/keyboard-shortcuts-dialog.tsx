/**
 * Keyboard Shortcuts Dialog
 * Shows all available keyboard shortcuts
 */

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { isMac } from '@/hooks/use-keyboard-shortcuts-base'
import { cn } from '@/lib/utils'

// =============================================================================
// TYPES
// =============================================================================

interface ShortcutDefinition {
  keys: string[]
  description: string
}

interface ShortcutGroup {
  title: string
  shortcuts: ShortcutDefinition[]
}

interface KeyboardShortcutsDialogProps {
  /** Whether dialog is open */
  isOpen: boolean
  /** Close handler */
  onClose: () => void
}

// =============================================================================
// SHORTCUT DEFINITIONS
// =============================================================================

const getShortcutGroups = (): ShortcutGroup[] => {
  const mod = isMac ? '⌘' : 'Ctrl'
  const shift = isMac ? '⇧' : 'Shift'
  const alt = isMac ? '⌥' : 'Alt'

  return [
    {
      title: 'Tab Management',
      shortcuts: [
        { keys: [mod, 'T'], description: 'New tab' },
        { keys: [mod, 'W'], description: 'Close tab' },
        { keys: [mod, shift, 'W'], description: 'Close all tabs' },
        { keys: [mod, shift, 'T'], description: 'Reopen closed tab' },
        { keys: ['Ctrl', 'Tab'], description: 'Next tab' },
        { keys: ['Ctrl', shift, 'Tab'], description: 'Previous tab' },
        { keys: [mod, '1-8'], description: 'Go to tab by number' },
        { keys: [mod, '9'], description: 'Go to last tab' },
        { keys: [mod, shift, 'P'], description: 'Pin/Unpin tab' },
        { keys: [mod, shift, 'D'], description: 'Duplicate tab' }
      ]
    },
    {
      title: 'Split View',
      shortcuts: [
        { keys: [mod, '\\'], description: 'Split right' },
        { keys: [mod, shift, '\\'], description: 'Split down' },
        { keys: [mod, alt, 'W'], description: 'Close split pane' },
        { keys: [mod, 'K', mod, '→'], description: 'Focus right pane' },
        { keys: [mod, 'K', mod, '←'], description: 'Focus left pane' },
        { keys: [mod, 'K', mod, '↑'], description: 'Focus pane above' },
        { keys: [mod, 'K', mod, '↓'], description: 'Focus pane below' }
      ]
    },
    {
      title: 'Navigation',
      shortcuts: [
        { keys: [mod, 'P'], description: 'Quick open' },
        { keys: [mod, ','], description: 'Settings' },
        { keys: [mod, 'F'], description: 'Search in view' },
        { keys: [mod, shift, 'F'], description: 'Search everywhere' },
        { keys: ['?'], description: 'Show shortcuts' }
      ]
    }
  ]
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Dialog showing all keyboard shortcuts
 */
export const KeyboardShortcutsDialog = ({
  isOpen,
  onClose
}: KeyboardShortcutsDialogProps): React.JSX.Element => {
  const shortcutGroups = getShortcutGroups()

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-auto">
        <DialogHeader>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-4">
          {shortcutGroups.map((group) => (
            <div key={group.title}>
              <h3 className="font-semibold text-sm text-gray-900 dark:text-gray-100 mb-3">
                {group.title}
              </h3>
              <div className="space-y-2">
                {group.shortcuts.map((shortcut) => (
                  <div
                    key={shortcut.description}
                    className="flex items-center justify-between gap-4"
                  >
                    <span className="text-sm text-gray-600 dark:text-gray-400">
                      {shortcut.description}
                    </span>
                    <div className="flex gap-1 flex-shrink-0">
                      {shortcut.keys.map((key) => (
                        <kbd
                          key={key}
                          className={cn(
                            'px-1.5 py-0.5 text-xs font-mono',
                            'bg-gray-100 dark:bg-gray-800',
                            'border border-gray-200 dark:border-gray-700',
                            'rounded'
                          )}
                        >
                          {key}
                        </kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400 text-center">
            Press <kbd className="px-1 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-xs">?</kbd>{' '}
            to toggle this dialog
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default KeyboardShortcutsDialog
