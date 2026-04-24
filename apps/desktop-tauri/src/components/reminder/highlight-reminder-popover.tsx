/**
 * Highlight Reminder Popover
 *
 * A floating popover that appears when text is selected in the editor,
 * allowing users to set a reminder for the highlighted text.
 *
 * T220: Create highlight-reminder-popover.tsx
 * T221: Add "Set Reminder" option to text selection context menu
 * T222: Implement highlight position tracking
 *
 * @module components/reminder/highlight-reminder-popover
 */

import * as React from 'react'
import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { Bell, X } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { ReminderPicker } from './reminder-picker'
import { useCreateReminder } from '@/hooks/use-reminders'
import { toast } from 'sonner'
import { createLogger } from '@/lib/logger'

const log = createLogger('Component:HighlightReminderPopover')

// ============================================================================
// Types
// ============================================================================

export interface HighlightSelection {
  /** The selected text */
  text: string
  /** Start offset (character position) */
  startOffset: number
  /** End offset (character position) */
  endOffset: number
  /** Position for the floating button */
  rect: DOMRect | null
}

export interface HighlightReminderPopoverProps {
  /** The note ID to attach the reminder to */
  noteId: string
  /** Whether the popover is active (selection exists) */
  selection: HighlightSelection | null
  /** Called when the popover is closed */
  onClose: () => void
  /** Called after reminder is created successfully */
  onReminderCreated?: () => void
  /** Container element for positioning */
  containerRef?: React.RefObject<HTMLElement | null>
}

// ============================================================================
// Component
// ============================================================================

export function HighlightReminderPopover({
  noteId,
  selection,
  onClose,
  onReminderCreated,
  containerRef: _containerRef
}: HighlightReminderPopoverProps): React.ReactElement | null {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const createReminder = useCreateReminder()

  const buttonPosition = useMemo(() => {
    if (!selection?.rect) return null

    const top = selection.rect.top - 40
    const left = selection.rect.left + selection.rect.width / 2 - 16

    return { top: Math.max(0, top), left: Math.max(0, left) }
  }, [selection])

  const handleSetReminder = useCallback(
    async (remindAt: Date, title?: string, note?: string) => {
      if (!selection?.text || !noteId) return

      try {
        await createReminder.mutateAsync({
          targetType: 'highlight',
          targetId: noteId,
          remindAt: remindAt.toISOString(),
          title: title || `Highlight: ${selection.text.slice(0, 30)}...`,
          note: note || undefined,
          highlightText: selection.text,
          highlightStart: selection.startOffset,
          highlightEnd: selection.endOffset
        })

        toast.success('Reminder set for highlight')
        setOpen(false)
        onClose()
        onReminderCreated?.()
      } catch (error) {
        log.error('Failed to create reminder', error)
        toast.error('Failed to set reminder')
      }
    },
    [selection, noteId, createReminder, onClose, onReminderCreated]
  )

  const handleClose = useCallback(() => {
    setOpen(false)
    onClose()
  }, [onClose])

  // Don't render if no selection
  if (!selection || !buttonPosition) {
    return null
  }

  return (
    <div
      className="fixed z-50 pointer-events-auto"
      style={{
        top: buttonPosition.top,
        left: buttonPosition.left
      }}
    >
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            handleClose()
            return
          }
          setOpen(true)
        }}
      >
        <PopoverTrigger asChild>
          <Button
            ref={buttonRef}
            variant="secondary"
            size="icon"
            className={cn(
              'h-8 w-8 rounded-full shadow-lg',
              'bg-amber-500 hover:bg-amber-600 text-white',
              'animate-in fade-in zoom-in duration-200'
            )}
            title="Set reminder for this text"
          >
            <Bell className="h-4 w-4" />
          </Button>
        </PopoverTrigger>

        <PopoverContent className="w-80 p-0" side="top" align="center" sideOffset={8}>
          <div className="p-4 space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between">
              <h4 className="font-medium text-sm">Remind me about this</h4>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleClose}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Selected text preview */}
            <div className="rounded-md bg-muted p-3">
              <p className="text-xs text-muted-foreground mb-1">Selected text:</p>
              <p className="text-sm italic line-clamp-3 border-l-2 border-amber-500 pl-2">
                "{selection.text}"
              </p>
            </div>

            {/* Reminder picker */}
            <ReminderPicker
              onSelect={(date, title, note) => {
                void handleSetReminder(date, title, note)
              }}
              variant="highlight"
              showNoteField={true}
              isLoading={createReminder.isPending}
            />
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}

// ============================================================================
// Hook for managing text selection
// ============================================================================

export interface UseTextSelectionOptions {
  /** Container element to listen for selections in */
  containerRef: React.RefObject<HTMLElement | null>
  /** Callback when selection changes */
  onSelectionChange?: (selection: HighlightSelection | null) => void
  /** Minimum characters required for selection */
  minLength?: number
  /** Whether selection tracking is enabled */
  enabled?: boolean
}

/**
 * Hook to track text selection within a container
 */
export function useTextSelection({
  containerRef,
  onSelectionChange,
  minLength = 3,
  enabled = true
}: UseTextSelectionOptions): HighlightSelection | null {
  const [selection, setSelection] = useState<HighlightSelection | null>(null)

  useEffect(() => {
    if (!enabled) return

    const handleSelectionChange = () => {
      const windowSelection = window.getSelection()

      if (!windowSelection || windowSelection.isCollapsed) {
        setSelection(null)
        onSelectionChange?.(null)
        return
      }

      const text = windowSelection.toString().trim()

      // Check minimum length
      if (text.length < minLength) {
        setSelection(null)
        onSelectionChange?.(null)
        return
      }

      // Check if selection is within our container
      const container = containerRef.current
      if (!container) {
        setSelection(null)
        onSelectionChange?.(null)
        return
      }

      const range = windowSelection.getRangeAt(0)
      const startContainer = range.startContainer
      const endContainer = range.endContainer

      // Verify selection is within the editor
      if (!container.contains(startContainer) || !container.contains(endContainer)) {
        setSelection(null)
        onSelectionChange?.(null)
        return
      }

      // Get the bounding rect for positioning
      const rect = range.getBoundingClientRect()

      // Calculate character offsets relative to the container
      // Note: This is a simplified approach - for complex block editors,
      // you may need to track positions differently
      const preRange = document.createRange()
      preRange.selectNodeContents(container)
      preRange.setEnd(range.startContainer, range.startOffset)
      const startOffset = preRange.toString().length

      const newSelection: HighlightSelection = {
        text,
        startOffset,
        endOffset: startOffset + text.length,
        rect
      }

      setSelection(newSelection)
      onSelectionChange?.(newSelection)
    }

    // Debounce selection changes
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    const debouncedHandler = () => {
      if (timeoutId) clearTimeout(timeoutId)
      timeoutId = setTimeout(handleSelectionChange, 150)
    }

    document.addEventListener('selectionchange', debouncedHandler)

    // Clear selection on mousedown outside container
    const handleMouseDown = (e: MouseEvent) => {
      const container = containerRef.current
      if (container && !container.contains(e.target as Node)) {
        setSelection(null)
        onSelectionChange?.(null)
      }
    }
    document.addEventListener('mousedown', handleMouseDown)

    return () => {
      document.removeEventListener('selectionchange', debouncedHandler)
      document.removeEventListener('mousedown', handleMouseDown)
      if (timeoutId) clearTimeout(timeoutId)
    }
  }, [containerRef, onSelectionChange, minLength, enabled])

  return enabled ? selection : null
}

export default HighlightReminderPopover
