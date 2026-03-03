import { cn } from '@/lib/utils'

// ============================================================================
// TYPES
// ============================================================================

interface QuickOption {
  label: string
  description: string
}

interface QuickOptionsBarProps {
  onInsert: (text: string) => void
  className?: string
}

// ============================================================================
// CONSTANTS
// ============================================================================

const quickOptions: QuickOption[] = [
  { label: '!today', description: 'Due today' },
  { label: '!tomorrow', description: 'Due tomorrow' },
  { label: '!!high', description: 'High priority' },
  { label: '!!low', description: 'Low priority' },
  { label: '#', description: 'Set project' }
]

// ============================================================================
// QUICK OPTIONS BAR COMPONENT
// ============================================================================

export const QuickOptionsBar = ({
  onInsert,
  className
}: QuickOptionsBarProps): React.JSX.Element => {
  const handleClick = (label: string): void => {
    onInsert(label)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, label: string): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onInsert(label)
    }
  }

  return (
    <div className={cn('flex items-center gap-2 mt-2 text-xs', className)}>
      <span className="text-muted-foreground shrink-0">Quick options:</span>
      <div className="flex items-center gap-1.5 flex-wrap">
        {quickOptions.map((option) => (
          <button
            key={option.label}
            type="button"
            onClick={() => handleClick(option.label)}
            onKeyDown={(e) => handleKeyDown(e, option.label)}
            onMouseDown={(e) => e.preventDefault()} // Prevent input blur
            className={cn(
              'px-2 py-0.5 rounded-full',
              'bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground',
              'transition-colors duration-150',
              'font-mono text-[11px]'
            )}
            title={option.description}
            aria-label={`Insert ${option.label}: ${option.description}`}
            tabIndex={-1}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export default QuickOptionsBar
