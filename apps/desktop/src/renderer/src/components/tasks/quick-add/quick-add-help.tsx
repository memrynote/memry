import { HelpCircle } from '@/lib/icons'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

// ============================================================================
// TYPES
// ============================================================================

interface ShortcutItem {
  syntax: string
  description: string
}

interface QuickAddHelpProps {
  className?: string
}

// ============================================================================
// CONSTANTS
// ============================================================================

const shortcuts: ShortcutItem[] = [
  { syntax: '!today', description: 'Due today' },
  { syntax: '!tomorrow', description: 'Due tomorrow' },
  { syntax: '!monday', description: 'Due this Monday' },
  { syntax: '!!high', description: 'High priority' },
  { syntax: '!!urgent', description: 'Urgent priority' },
  { syntax: '#project', description: 'Assign to project' }
]

// ============================================================================
// QUICK ADD HELP COMPONENT
// ============================================================================

export const QuickAddHelp = ({ className }: QuickAddHelpProps): React.JSX.Element => {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            'p-1 rounded hover:bg-muted transition-colors',
            'text-muted-foreground hover:text-foreground',
            className
          )}
          aria-label="Quick add shortcuts help"
          tabIndex={-1}
        >
          <HelpCircle className="w-4 h-4" />
        </button>
      </TooltipTrigger>

      <TooltipContent
        side="bottom"
        align="end"
        className="w-72 p-3 bg-popover text-popover-foreground"
      >
        <h4 className="font-medium mb-2 text-sm">Quick Add Shortcuts</h4>

        <div className="space-y-1.5">
          {shortcuts.map((shortcut) => (
            <div key={shortcut.syntax} className="flex items-center gap-2 text-sm">
              <code className="font-mono text-xs text-primary bg-primary/10 px-1.5 py-0.5 rounded">
                {shortcut.syntax}
              </code>
              <span className="text-muted-foreground">{shortcut.description}</span>
            </div>
          ))}
        </div>

        <p className="text-xs text-muted-foreground mt-3 pt-2 border-t border-border">
          Example: "Buy milk !tomorrow !!high #personal"
        </p>
      </TooltipContent>
    </Tooltip>
  )
}

export default QuickAddHelp
