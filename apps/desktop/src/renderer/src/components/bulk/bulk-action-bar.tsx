import { Folder, Tag, Archive, Clock, Star, Plus, X } from '@/lib/icons'

import { SnoozePicker } from '@/components/snooze'
import { cn } from '@/lib/utils'
import type { InboxItemListItem } from '@/types'

interface ClusterSuggestion {
  items: InboxItemListItem[]
  reason: string
}

interface BulkActionBarProps {
  selectedCount: number
  onFileAll: () => void
  onTagAll: () => void
  onSnoozeAll?: (snoozeUntil: string) => void
  onArchiveAll: () => void
  aiSuggestion: ClusterSuggestion | null
  onAddSuggestionToSelection: () => void
  onDismissSuggestion: () => void
}

const KEYBOARD_HINTS = [
  { key: 'F', label: 'file' },
  { key: 'T', label: 'tag' },
  { key: 'S', label: 'snooze' },
  { key: 'E', label: 'archive' },
  { key: 'Esc', label: 'deselect' }
] as const

const BulkActionBar = ({
  selectedCount,
  onFileAll,
  onTagAll,
  onSnoozeAll,
  onArchiveAll,
  aiSuggestion,
  onAddSuggestionToSelection,
  onDismissSuggestion
}: BulkActionBarProps): React.JSX.Element | null => {
  if (selectedCount === 0) return null

  const hasSuggestion = aiSuggestion && aiSuggestion.items.length > 0

  return (
    <div
      className={cn(
        'fixed bottom-8 left-1/2 -translate-x-1/2 z-40',
        'flex flex-col items-center',
        'w-[520px] rounded-2xl',
        'bg-popover/95 backdrop-blur-md',
        'border border-border/60',
        'shadow-[0_24px_48px_rgba(0,0,0,0.3),0_0px_0px_1px_var(--border)]',
        'dark:shadow-[0_24px_48px_rgba(0,0,0,0.5),0_0px_0px_1px_rgba(255,255,255,0.04)]',
        'slide-up-enter motion-reduce:animate-none'
      )}
      role="toolbar"
      aria-label={`Bulk actions for ${selectedCount} selected items`}
    >
      {/* Count badge — floating on bar edge */}
      <div
        className={cn(
          'absolute -top-3 left-1/2 -translate-x-1/2',
          'flex items-center gap-1 px-3 py-0.5',
          'rounded-full bg-amber-500',
          'shadow-[0_2px_8px_rgba(217,160,55,0.3)]'
        )}
      >
        <span className="text-[11px]/3.5 font-bold text-white dark:text-background">
          {selectedCount} selected
        </span>
      </div>

      {/* Action buttons row */}
      <div className="flex items-center w-full gap-0.5 p-2">
        <ActionButton onClick={onFileAll} active>
          <Folder className="size-[15px]" aria-hidden="true" />
          File
        </ActionButton>

        <ActionButton onClick={onTagAll}>
          <Tag className="size-[15px]" aria-hidden="true" />
          Tag
        </ActionButton>

        {onSnoozeAll ? (
          <SnoozePicker
            onSnooze={onSnoozeAll}
            size="default"
            variant="ghost"
            trigger={
              <button
                type="button"
                className={cn(
                  'flex flex-1 items-center justify-center gap-1.5 py-2 px-4 rounded-[10px]',
                  'text-[13px]/4 font-medium cursor-pointer',
                  'text-muted-foreground hover:text-foreground/75 hover:bg-foreground/[0.05]',
                  'transition-colors'
                )}
              >
                <Clock className="size-[15px]" aria-hidden="true" />
                Snooze
              </button>
            }
          />
        ) : (
          <ActionButton disabled>
            <Clock className="size-[15px]" aria-hidden="true" />
            Snooze
          </ActionButton>
        )}

        {/* Divider */}
        <div className="w-px h-6 shrink-0 bg-border/60" aria-hidden="true" />

        <ActionButton onClick={onArchiveAll} variant="destructive">
          <Archive className="size-[15px]" aria-hidden="true" />
          Archive
        </ActionButton>
      </div>

      {/* AI cluster suggestion */}
      {hasSuggestion && (
        <>
          <div className="w-[calc(100%-24px)] h-px bg-border/40 mx-3" aria-hidden="true" />
          <div className="flex items-center w-full gap-2 px-4 py-2.5">
            <Star className="size-3.5 shrink-0 text-[var(--accent-purple)]" aria-hidden="true" />
            <span className="flex-1 truncate text-xs text-muted-foreground/60">
              {aiSuggestion.reason}
            </span>
            <button
              type="button"
              onClick={onAddSuggestionToSelection}
              className={cn(
                'flex items-center gap-1 px-2.5 py-0.5 rounded-md',
                'border border-[var(--accent-purple)]/20',
                'text-[var(--accent-purple)]',
                'hover:bg-[var(--accent-purple)]/10',
                'transition-colors'
              )}
            >
              <Plus className="size-2.5" aria-hidden="true" />
              <span className="text-[11px]/3.5 font-medium">Add</span>
            </button>
            <button
              type="button"
              onClick={onDismissSuggestion}
              className="p-1 text-muted-foreground/20 hover:text-muted-foreground/50 transition-colors"
              aria-label="Dismiss suggestion"
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          </div>
        </>
      )}

      {/* Keyboard hints */}
      <div className="flex items-center justify-center w-full gap-4 px-4 pt-1 pb-2">
        {KEYBOARD_HINTS.map(({ key, label }) => (
          <div key={key} className="flex items-center gap-1">
            <kbd
              className={cn(
                'px-1.5 py-px rounded-[3px]',
                'bg-foreground/[0.06] border border-foreground/[0.08]',
                'font-mono text-[9px]/3 font-medium text-muted-foreground/30'
              )}
            >
              {key}
            </kbd>
            <span className="text-[9px]/3 text-muted-foreground/25">{label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

interface ActionButtonProps {
  children: React.ReactNode
  onClick?: () => void
  active?: boolean
  disabled?: boolean
  variant?: 'default' | 'destructive'
}

function ActionButton({
  children,
  onClick,
  active = false,
  disabled = false,
  variant = 'default'
}: ActionButtonProps): React.JSX.Element {
  const isDestructive = variant === 'destructive'

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex flex-1 items-center justify-center gap-1.5 py-2 px-4 rounded-[10px]',
        'text-[13px]/4 font-medium',
        'transition-colors cursor-pointer',
        isDestructive
          ? 'text-destructive/70 hover:text-destructive hover:bg-destructive/10 shrink-0 grow-0'
          : active
            ? 'bg-foreground/[0.07] text-foreground/75 hover:bg-foreground/[0.12]'
            : 'text-muted-foreground hover:text-foreground/75 hover:bg-foreground/[0.05]',
        disabled && 'opacity-50 cursor-not-allowed'
      )}
    >
      {children}
    </button>
  )
}

export { BulkActionBar, type ClusterSuggestion }
