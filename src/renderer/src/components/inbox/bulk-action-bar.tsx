/**
 * Bulk Action Bar Component
 *
 * A floating action bar that appears when items are selected.
 * Features industrial-modern aesthetics with refined interactions
 * and AI-powered clustering suggestions.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  FolderInput,
  Tag,
  Clock,
  Trash2,
  Sparkles,
  ChevronUp,
  ChevronDown,
  X,
  Check,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { TypeIcon } from './type-badge'
import { SnoozeMenu } from './snooze-menu'
import type { InboxItem } from '@/data/inbox-types'

// ============================================================================
// TYPES
// ============================================================================

export interface ClusterSuggestion {
  /** Human-readable label for the cluster */
  label: string
  /** Items suggested to add to selection */
  items: InboxItem[]
  /** Confidence score 0-1 */
  confidence: number
}

export interface BulkActionBarProps {
  /** Number of selected items */
  selectedCount: number
  /** The selected items */
  selectedItems: InboxItem[]
  /** Callback when File All action is triggered */
  onFileAll: () => void
  /** Callback when Tag All action is triggered */
  onTagAll: () => void
  /** Callback when Snooze All action is triggered with selected time */
  onSnoozeAll: (until: Date) => void
  /** Callback when Delete All action is triggered */
  onDeleteAll: () => void
  /** AI cluster suggestion */
  aiSuggestion?: ClusterSuggestion
  /** Callback when AI suggestion items are added to selection */
  onAddSuggestion: (itemIds: string[]) => void
  /** Callback when AI suggestion is dismissed */
  onDismissSuggestion: () => void
  /** Additional class names */
  className?: string
}

// ============================================================================
// ACTION BUTTON
// ============================================================================

interface ActionButtonProps {
  icon: React.ReactNode
  label: string
  shortcut: string
  onClick: () => void
  variant?: 'default' | 'destructive'
}

function ActionButton({
  icon,
  label,
  shortcut,
  onClick,
  variant = 'default',
}: ActionButtonProps): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={variant === 'destructive' ? 'ghost' : 'secondary'}
          size="sm"
          onClick={onClick}
          className={cn(
            'h-9 gap-2 px-3',
            'font-medium tracking-tight',
            'transition-all duration-150',
            variant === 'destructive' && [
              'text-destructive/90 hover:text-destructive',
              'hover:bg-destructive/10',
            ]
          )}
        >
          {icon}
          <span className="hidden sm:inline">{label}</span>
          <Kbd className="ml-1 hidden lg:inline-flex">{shortcut}</Kbd>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8}>
        <p className="text-xs">
          {label} <Kbd className="ml-1">{shortcut}</Kbd>
        </p>
      </TooltipContent>
    </Tooltip>
  )
}

// ============================================================================
// DELETE CONFIRMATION DIALOG
// ============================================================================

interface DeleteConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  itemCount: number
  onConfirm: () => void
}

function DeleteConfirmDialog({
  open,
  onOpenChange,
  itemCount,
  onConfirm,
}: DeleteConfirmDialogProps): React.JSX.Element {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Trash2 className="size-5 text-destructive" />
            Delete {itemCount} {itemCount === 1 ? 'item' : 'items'}?
          </AlertDialogTitle>
          <AlertDialogDescription className="text-muted-foreground">
            This action cannot be undone. The selected items will be permanently
            removed from your inbox.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-destructive text-white hover:bg-destructive/90"
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ============================================================================
// AI SUGGESTION COLLAPSED
// ============================================================================

interface AISuggestionCollapsedProps {
  suggestion: ClusterSuggestion
  isExpanded: boolean
  onToggle: () => void
}

function AISuggestionCollapsed({
  suggestion,
  isExpanded,
  onToggle,
}: AISuggestionCollapsedProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 rounded-full',
        'bg-amber-500/10 hover:bg-amber-500/15',
        'border border-amber-500/20',
        'transition-all duration-200',
        'group cursor-pointer'
      )}
    >
      <Sparkles className="size-3.5 text-amber-500" />
      <span className="text-sm font-medium text-amber-600 dark:text-amber-400">
        {suggestion.items.length} similar
      </span>
      <span className="text-sm text-muted-foreground hidden sm:inline">
        — "{suggestion.label}"
      </span>
      {isExpanded ? (
        <ChevronDown className="size-3.5 text-amber-500/70 group-hover:text-amber-500 transition-colors" />
      ) : (
        <ChevronUp className="size-3.5 text-amber-500/70 group-hover:text-amber-500 transition-colors" />
      )}
    </button>
  )
}

// ============================================================================
// AI SUGGESTION EXPANDED PANEL
// ============================================================================

interface AISuggestionExpandedProps {
  suggestion: ClusterSuggestion
  onAddAll: () => void
  onDismiss: () => void
}

function AISuggestionExpanded({
  suggestion,
  onAddAll,
  onDismiss,
}: AISuggestionExpandedProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'absolute bottom-full left-0 right-0 mb-2',
        'mx-4 p-4 rounded-xl',
        // Gradient border effect
        'bg-gradient-to-b from-amber-500/5 to-background',
        'border border-amber-500/20',
        'shadow-lg shadow-amber-500/5',
        // Animation
        'animate-in slide-in-from-bottom-2 fade-in-0 duration-200'
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-lg bg-amber-500/10">
            <Sparkles className="size-4 text-amber-500" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">
              AI detected similar items
            </p>
            <p className="text-xs text-muted-foreground">
              "{suggestion.label}"
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className={cn(
            'p-1 rounded-md',
            'text-muted-foreground hover:text-foreground',
            'hover:bg-accent transition-colors'
          )}
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Item List */}
      <div className="space-y-1.5 mb-4">
        {suggestion.items.slice(0, 5).map((item, index) => (
          <div
            key={item.id}
            className={cn(
              'flex items-center gap-2 px-3 py-2 rounded-lg',
              'bg-accent/50',
              // Staggered animation
              'animate-in slide-in-from-left-2 fade-in-0',
              'duration-200'
            )}
            style={{ animationDelay: `${index * 50}ms` }}
          >
            <TypeIcon type={item.type} size="sm" />
            <span className="text-sm text-foreground/90 truncate flex-1">
              {item.title}
            </span>
          </div>
        ))}
        {suggestion.items.length > 5 && (
          <p className="text-xs text-muted-foreground pl-3 pt-1">
            +{suggestion.items.length - 5} more items
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onDismiss}
          className="text-muted-foreground"
        >
          Dismiss
        </Button>
        <Button
          variant="default"
          size="sm"
          onClick={onAddAll}
          className="gap-1.5"
        >
          <Check className="size-3.5" />
          Add all to selection
        </Button>
      </div>
    </div>
  )
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function BulkActionBar({
  selectedCount,
  selectedItems: _selectedItems, // Reserved for future use with AI analysis
  onFileAll,
  onTagAll,
  onSnoozeAll,
  onDeleteAll,
  aiSuggestion,
  onAddSuggestion,
  onDismissSuggestion,
  className,
}: BulkActionBarProps): React.JSX.Element | null {
  const [isVisible, setIsVisible] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [isSuggestionExpanded, setIsSuggestionExpanded] = useState(false)
  const [isSnoozeMenuOpen, setIsSnoozeMenuOpen] = useState(false)

  // Animate in when items are selected
  useEffect(() => {
    if (selectedCount > 0) {
      // Small delay for animation
      const timer = setTimeout(() => setIsVisible(true), 50)
      return () => clearTimeout(timer)
    }
    setIsVisible(false)
    setIsSuggestionExpanded(false)
    return undefined
  }, [selectedCount])

  // Keyboard shortcuts
  useEffect(() => {
    if (selectedCount === 0) return

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle if in an input
      const target = e.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return
      }

      switch (e.key.toLowerCase()) {
        case 'f':
          if (!e.metaKey && !e.ctrlKey && !e.shiftKey) {
            e.preventDefault()
            onFileAll()
          }
          break
        case 't':
          if (!e.metaKey && !e.ctrlKey && !e.shiftKey) {
            e.preventDefault()
            onTagAll()
          }
          break
        case 's':
          if (!e.metaKey && !e.ctrlKey && !e.shiftKey) {
            e.preventDefault()
            setIsSnoozeMenuOpen(true)
          }
          break
        case 'backspace':
        case 'delete':
          if (!e.metaKey && !e.ctrlKey && !e.shiftKey) {
            e.preventDefault()
            setShowDeleteConfirm(true)
          }
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedCount, onFileAll, onTagAll])

  const handleDeleteConfirm = useCallback(() => {
    setShowDeleteConfirm(false)
    onDeleteAll()
  }, [onDeleteAll])

  const handleAddSuggestion = useCallback(() => {
    if (aiSuggestion) {
      onAddSuggestion(aiSuggestion.items.map((item) => item.id))
      setIsSuggestionExpanded(false)
    }
  }, [aiSuggestion, onAddSuggestion])

  // Don't render if no items selected
  if (selectedCount === 0) {
    return null
  }

  return (
    <>
      <div
        className={cn(
          'relative',
          // Fixed positioning
          'border-t border-border',
          // Background with frosted glass effect
          'bg-background/95 backdrop-blur-sm',
          // Shadow for depth
          'shadow-[0_-4px_24px_-4px_rgba(0,0,0,0.08)]',
          'dark:shadow-[0_-4px_24px_-4px_rgba(0,0,0,0.3)]',
          // Padding
          'px-4 sm:px-6 py-4',
          // Animation
          'transform transition-transform duration-200 ease-out',
          isVisible ? 'translate-y-0' : 'translate-y-full',
          className
        )}
      >
        {/* AI Suggestion Expanded Panel */}
        {aiSuggestion && isSuggestionExpanded && (
          <AISuggestionExpanded
            suggestion={aiSuggestion}
            onAddAll={handleAddSuggestion}
            onDismiss={onDismissSuggestion}
          />
        )}

        <div className="flex items-center justify-between gap-4">
          {/* Left: Selection count */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <div
                className={cn(
                  'flex size-6 items-center justify-center rounded-md',
                  'bg-primary/10 text-primary',
                  'font-semibold text-sm tabular-nums'
                )}
              >
                {selectedCount}
              </div>
              <span className="text-sm text-muted-foreground">
                {selectedCount === 1 ? 'item' : 'items'} selected
              </span>
            </div>

            {/* AI Suggestion Collapsed */}
            {aiSuggestion && (
              <>
                <div className="hidden sm:block h-5 w-px bg-border/60" />
                <AISuggestionCollapsed
                  suggestion={aiSuggestion}
                  isExpanded={isSuggestionExpanded}
                  onToggle={() => setIsSuggestionExpanded(!isSuggestionExpanded)}
                />
              </>
            )}
          </div>

          {/* Right: Action buttons */}
          <div className="flex items-center gap-1 sm:gap-2">
            <ActionButton
              icon={<FolderInput className="size-4" />}
              label="File"
              shortcut="f"
              onClick={onFileAll}
            />
            <ActionButton
              icon={<Tag className="size-4" />}
              label="Tag"
              shortcut="t"
              onClick={onTagAll}
            />
            {/* Snooze Menu */}
            <SnoozeMenu
              open={isSnoozeMenuOpen}
              onOpenChange={setIsSnoozeMenuOpen}
              onSnooze={onSnoozeAll}
              itemCount={selectedCount}
              align="end"
              side="top"
              trigger={
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="secondary"
                      size="sm"
                      className={cn(
                        'h-9 gap-2 px-3',
                        'font-medium tracking-tight',
                        'transition-all duration-150'
                      )}
                    >
                      <Clock className="size-4" />
                      <span className="hidden sm:inline">Snooze</span>
                      <Kbd className="ml-1 hidden lg:inline-flex">s</Kbd>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={8}>
                    <p className="text-xs">
                      Snooze <Kbd className="ml-1">s</Kbd>
                    </p>
                  </TooltipContent>
                </Tooltip>
              }
            />
            <div className="hidden sm:block h-5 w-px bg-border/60 mx-1" />
            <ActionButton
              icon={<Trash2 className="size-4" />}
              label="Delete"
              shortcut="⌫"
              onClick={() => setShowDeleteConfirm(true)}
              variant="destructive"
            />
          </div>
        </div>
      </div>

      {/* Delete Confirmation Dialog */}
      <DeleteConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        itemCount={selectedCount}
        onConfirm={handleDeleteConfirm}
      />
    </>
  )
}
