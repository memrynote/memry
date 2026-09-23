import type { AppIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'

export interface InlineChoiceOption<T extends string> {
  id: T
  icon: AppIcon
  label: string
}

interface InlineChoiceMenuProps<T extends string> {
  title: string
  position: { x: number; y: number }
  options: InlineChoiceOption<T>[]
  selectedIndex: number
  onSelect: (option: T) => void
}

/**
 * The small "insert as…" popover shown at the caret after a pick that can land
 * more than one way (a pasted URL, an `@`-picked canvas). Presentational only:
 * the owning hook keeps the keyboard, and its click-away check keys on
 * `data-inline-choice-menu` so a click inside never counts as leaving.
 */
export function InlineChoiceMenu<T extends string>({
  title,
  position,
  options,
  selectedIndex,
  onSelect
}: InlineChoiceMenuProps<T>) {
  return (
    <div
      data-inline-choice-menu
      role="listbox"
      aria-label={title}
      className="absolute z-50 min-w-[160px] rounded-lg border border-border bg-popover p-1 shadow-md animate-in fade-in-0 zoom-in-95"
      style={{ left: position.x, top: position.y }}
    >
      <p className="px-2 py-1 text-[11px] text-muted-foreground/60">{title}</p>
      {options.map(({ id, icon: Icon, label }, index) => (
        <button
          key={id}
          type="button"
          role="option"
          aria-selected={index === selectedIndex}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm',
            'transition-colors cursor-pointer',
            index === selectedIndex
              ? 'bg-accent text-accent-foreground'
              : 'text-foreground hover:bg-accent/50'
          )}
          onMouseDown={(e) => {
            e.preventDefault()
            onSelect(id)
          }}
        >
          <Icon className="size-4 text-muted-foreground" />
          {label}
        </button>
      ))}
    </div>
  )
}
