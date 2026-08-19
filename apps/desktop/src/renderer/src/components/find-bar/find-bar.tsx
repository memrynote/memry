import { memo, type RefObject } from 'react'
import { X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

interface FindBarProps {
  isOpen: boolean
  query: string
  matchCount: number
  currentIndex: number
  inputRef: RefObject<HTMLInputElement | null>
  onQueryChange: (query: string) => void
  onNext: () => void
  onPrev: () => void
  onClose: () => void
  /**
   * Replaces the `current/total` count. For a surface where that count is not
   * the whole truth — a search still crossing a 2 GB file, or a hit list capped
   * for navigation — and rendering it as if it were would be a lie.
   */
  countLabel?: string
  className?: string
}

export const FindBar = memo(function FindBar({
  isOpen,
  query,
  matchCount,
  currentIndex,
  inputRef,
  onQueryChange,
  onNext,
  onPrev,
  onClose,
  countLabel,
  className
}: FindBarProps) {
  const { t: tPhaseF } = useT('common')
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) onPrev()
      else onNext()
    }
  }

  return (
    <div
      className={cn(
        'absolute end-4 top-14 z-30',
        'transition-all duration-100 ease-out',
        isOpen
          ? 'opacity-100 translate-y-0 pointer-events-auto'
          : 'opacity-0 -translate-y-2 pointer-events-none',
        className
      )}
      aria-hidden={!isOpen}
    >
      <div
        className={cn(
          'flex items-center gap-2',
          'bg-background border border-border/60 rounded-md shadow-sm',
          'px-3 py-1.5'
        )}
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={tPhaseF('phaseF.componentsFindBarFindBar.findReplaceAsk')}
          aria-label={tPhaseF('phaseF.componentsFindBarFindBar.findReplaceAsk')}
          tabIndex={isOpen ? 0 : -1}
          className={cn(
            'w-52 h-7 text-sm bg-transparent',
            'focus:outline-none',
            'placeholder:text-muted-foreground/40'
          )}
        />

        {query && matchCount >= 0 && (
          <span className="text-[11px] text-muted-foreground/60 tabular-nums select-none whitespace-nowrap">
            {countLabel ?? (matchCount > 0 ? `${currentIndex + 1}/${matchCount}` : '0')}
          </span>
        )}

        <button
          type="button"
          onClick={onClose}
          tabIndex={isOpen ? 0 : -1}
          className="p-0.5 rounded hover:bg-muted/60 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
})
