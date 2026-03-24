/**
 * Chord Indicator Component
 * Visual indicator shown when a chord sequence is active
 */

import { cn } from '@/lib/utils'
import { isMac } from '@/hooks/use-keyboard-shortcuts-base'

interface ChordIndicatorProps {
  /** Whether chord mode is active */
  isActive: boolean
  /** Additional CSS classes */
  className?: string
}

/**
 * Shows a visual indicator when waiting for second key in chord
 */
export const ChordIndicator = ({
  isActive,
  className
}: ChordIndicatorProps): React.JSX.Element | null => {
  if (!isActive) return null

  const modKey = isMac ? '⌘' : 'Ctrl'

  return (
    <div
      className={cn(
        'fixed bottom-4 right-4 z-50',
        'bg-primary',
        'text-primary-foreground',
        'px-4 py-2 rounded-md shadow-lg',
        'animate-in fade-in slide-in-from-bottom-2 duration-200',
        className
      )}
    >
      <div className="flex items-center gap-2 text-sm">
        <kbd className="px-1.5 py-0.5 bg-primary-foreground/20 rounded text-xs font-mono">
          {modKey}K
        </kbd>
        <span className="text-primary-foreground/60">pressed — waiting for second key...</span>
      </div>
    </div>
  )
}

export default ChordIndicator
