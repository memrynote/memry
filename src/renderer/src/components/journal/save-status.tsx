/**
 * SaveStatusIndicator Component
 * Displays the current save state of a journal entry.
 * Shows "Saving...", "Saved", "Unsaved", or nothing based on state.
 *
 * @module components/journal/save-status
 */

import { cn } from '@/lib/utils'
import { Loader2, Check, AlertCircle } from 'lucide-react'

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'unsaved' | 'error'

export interface SaveStatusIndicatorProps {
  /** Current save status */
  status: SaveStatus
  /** Optional error message to display on hover when status is 'error' */
  errorMessage?: string
  /** Additional CSS classes */
  className?: string
}

/**
 * Derive save status from hook state
 */
export function deriveSaveStatus(options: {
  isSaving: boolean
  isDirty: boolean
  hasEntry: boolean
  hasError?: boolean
}): SaveStatus {
  const { isSaving, isDirty, hasEntry, hasError } = options

  if (hasError) return 'error'
  if (isSaving) return 'saving'
  if (isDirty) return 'unsaved'
  if (hasEntry) return 'saved'
  return 'idle'
}

/**
 * Save status indicator for journal entries.
 * Provides visual feedback for auto-save state.
 */
export function SaveStatusIndicator({
  status,
  errorMessage,
  className
}: SaveStatusIndicatorProps): React.JSX.Element | null {
  // Don't render anything for idle state
  if (status === 'idle') {
    return null
  }

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-xs transition-opacity duration-300',
        status === 'saving' && 'text-muted-foreground',
        status === 'unsaved' && 'text-muted-foreground/60',
        status === 'saved' && 'text-muted-foreground/40',
        status === 'error' && 'text-destructive',
        className
      )}
      title={status === 'error' ? errorMessage : undefined}
    >
      {status === 'saving' && (
        <>
          <Loader2 className="size-3 animate-spin" />
          <span>Saving...</span>
        </>
      )}
      {status === 'unsaved' && <span>Unsaved</span>}
      {status === 'saved' && (
        <>
          <Check className="size-3" />
          <span>Saved</span>
        </>
      )}
      {status === 'error' && (
        <>
          <AlertCircle className="size-3" />
          <span>Save failed</span>
        </>
      )}
    </span>
  )
}

export default SaveStatusIndicator
