import { Folder, Eye, Trash2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { QuickSnoozeButton } from '@/components/snooze'

interface QuickActionsProps {
  itemId: string
  onFile: (id: string) => void
  onPreview: (id: string) => void
  onDelete: (id: string) => void
  onSnooze?: (id: string, snoozeUntil: string) => void
  variant?: 'row' | 'card'
  className?: string
}

const QuickActions = ({
  itemId,
  onFile,
  onPreview,
  onDelete,
  onSnooze,
  variant = 'row',
  className
}: QuickActionsProps): React.JSX.Element => {
  const handleFile = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onFile(itemId)
  }

  const handlePreview = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onPreview(itemId)
  }

  const handleDelete = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onDelete(itemId)
  }

  const handleSnooze = (snoozeUntil: string): void => {
    onSnooze?.(itemId, snoozeUntil)
  }

  const isRow = variant === 'row'

  return (
    <div
      className={cn('flex items-center', isRow ? 'gap-1' : 'gap-2', className)}
      role="group"
      aria-label="Quick actions"
    >
      {/* File button - primary action with scale effect */}
      <button
        type="button"
        onClick={handleFile}
        className={cn(
          'flex items-center gap-1.5 rounded-md',
          'transition-[background-color,transform,box-shadow] duration-[var(--duration-instant)] ease-[var(--ease-out)]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'hover:scale-105 active:scale-95',
          isRow
            ? 'px-2 py-1 text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 hover:shadow-sm'
            : 'px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 hover:shadow-md'
        )}
        aria-label="File item"
      >
        <Folder className={isRow ? 'size-3' : 'size-3.5'} aria-hidden="true" />
        <span>File</span>
      </button>

      {/* Snooze button - with dropdown picker */}
      {onSnooze && <QuickSnoozeButton onSnooze={handleSnooze} />}

      {/* Preview button - icon only with smooth hover */}
      <button
        type="button"
        onClick={handlePreview}
        className={cn(
          'rounded-md',
          'transition-[background-color,color,transform] duration-[var(--duration-instant)] ease-[var(--ease-out)]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'hover:scale-110 active:scale-95',
          isRow
            ? 'p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted'
            : 'p-2 text-muted-foreground hover:text-foreground hover:bg-muted'
        )}
        aria-label="Preview item"
      >
        <Eye className={isRow ? 'size-4' : 'size-4'} aria-hidden="true" />
      </button>

      {/* Delete button - danger state with red tint on hover */}
      <button
        type="button"
        onClick={handleDelete}
        className={cn(
          'rounded-md',
          'transition-[background-color,color,transform] duration-[var(--duration-instant)] ease-[var(--ease-out)]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'hover:scale-110 active:scale-95',
          isRow
            ? 'p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10'
            : 'p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10'
        )}
        aria-label="Delete item"
      >
        <Trash2 className={isRow ? 'size-4' : 'size-4'} aria-hidden="true" />
      </button>
    </div>
  )
}

export { QuickActions, type QuickActionsProps }
