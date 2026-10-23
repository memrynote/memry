import { cn } from '@/lib/utils'
import { SearchKbd } from './search-row'

export interface SearchAction {
  label: string
  keyLabel: string
  onRun: () => void
}

interface SearchActionBarProps {
  leading: SearchAction
  status: React.ReactNode
  secondary: SearchAction | null
  primary: SearchAction | null
}

function ActionButton({
  action,
  strong
}: {
  action: SearchAction
  strong?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      onClick={action.onRun}
      className={cn(
        'flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs leading-4 transition-colors',
        'hover:bg-surface-active',
        strong ? 'font-medium text-foreground' : 'text-text-tertiary hover:text-foreground'
      )}
    >
      {action.label}
      <SearchKbd className="bg-background text-text-secondary">{action.keyLabel}</SearchKbd>
    </button>
  )
}

/** Raycast-style footer: what Enter does now, and how to get elsewhere. */
export function SearchActionBar({
  leading,
  status,
  secondary,
  primary
}: SearchActionBarProps): React.JSX.Element {
  return (
    <div className="flex h-[42px] shrink-0 items-center justify-between gap-3 border-t border-border bg-surface pe-2.5 ps-2.5">
      <div className="flex min-w-0 items-center gap-3">
        <ActionButton action={leading} />
        <div className="min-w-0 truncate text-xs leading-4 text-text-tertiary">{status}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {secondary && <ActionButton action={secondary} />}
        {secondary && primary && <span className="h-4 w-px bg-border" aria-hidden="true" />}
        {primary && <ActionButton action={primary} strong />}
      </div>
    </div>
  )
}
