import { cn } from '@/lib/utils'

export type InboxView = 'inbox' | 'archived' | 'insights'

export interface InboxSegmentControlProps {
  value: InboxView
  onChange: (view: InboxView) => void
  className?: string
}

export function InboxSegmentControl({
  value,
  onChange,
  className
}: InboxSegmentControlProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'inline-flex h-10 items-center justify-center rounded-lg bg-muted/40 p-1 text-muted-foreground',
        className
      )}
      role="tablist"
      aria-label="Inbox View Selection"
    >
      <SegmentButton label="Inbox" isActive={value === 'inbox'} onClick={() => onChange('inbox')} />
      <SegmentButton
        label="Archived"
        isActive={value === 'archived'}
        onClick={() => onChange('archived')}
      />
      <SegmentButton
        label="Insights"
        isActive={value === 'insights'}
        onClick={() => onChange('insights')}
      />
    </div>
  )
}

interface SegmentButtonProps {
  label: string
  isActive: boolean
  onClick: () => void
}

function SegmentButton({ label, isActive, onClick }: SegmentButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      onClick={onClick}
      className={cn(
        'group relative flex items-center justify-center gap-2 rounded-sm px-4 py-1.5 text-sm font-medium transition-all duration-300 ease-out focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-2',
        'font-serif tracking-wide',
        isActive
          ? 'bg-background text-foreground shadow-sm ring-0'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
      )}
    >
      <span>{label}</span>
    </button>
  )
}
