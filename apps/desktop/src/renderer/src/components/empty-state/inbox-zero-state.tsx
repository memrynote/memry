import { cn } from '@/lib/utils'

interface InboxZeroStateProps {
  itemsProcessedToday: number
  processedThisWeek: number
  currentStreak: number
  onViewRecentActivity?: () => void
}

const InboxZeroState = ({
  processedThisWeek,
  currentStreak
}: InboxZeroStateProps): React.JSX.Element => {
  const showStats = processedThisWeek > 0 || currentStreak > 0

  return (
    <div className="flex flex-col items-center max-w-90 gap-5 text-xs/4">
      {/* Radial glow → bordered inner circle → checkmark */}
      <div
        className={cn(
          'flex items-center justify-center rounded-[40px] shrink-0 size-20',
          'empty-state-entrance stagger-delay-1 motion-reduce:animate-none'
        )}
        style={{
          backgroundImage:
            'radial-gradient(circle farthest-corner at 50% 50%, color-mix(in srgb, var(--accent-orange) 12%, transparent) 0%, color-mix(in srgb, var(--accent-orange) 0%, transparent) 70%)'
        }}
        aria-label="Success, inbox is empty"
      >
        <div className="flex items-center justify-center rounded-[28px] bg-accent-orange/5 border border-accent-orange/20 shrink-0 size-14">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M9 12l2 2 4-4"
              className="stroke-accent-orange"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="12" cy="12" r="9" className="stroke-accent-orange" strokeWidth="1.5" />
          </svg>
        </div>
      </div>

      {/* Title */}
      <h2
        className={cn(
          'text-center text-foreground font-medium text-lg/6',
          'empty-state-entrance stagger-delay-2 motion-reduce:animate-none'
        )}
      >
        Inbox Zero
      </h2>

      {/* Subtitle */}
      <p
        className={cn(
          'text-center text-muted-foreground text-[13px]/5',
          'empty-state-entrance stagger-delay-3 motion-reduce:animate-none'
        )}
      >
        Everything&apos;s processed. Capture something new with the input above, or paste a link to
        get started.
      </p>

      {/* Stats: filed this week | streak */}
      {showStats && (
        <div
          className={cn(
            'flex items-center pt-2 gap-4',
            'empty-state-entrance stagger-delay-4 motion-reduce:animate-none'
          )}
        >
          {processedThisWeek > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="text-accent-green font-medium text-xs/4 tabular-nums">
                {processedThisWeek}
              </span>
              <span className="text-muted-foreground/60 text-xs/4">filed this week</span>
            </div>
          )}

          {processedThisWeek > 0 && currentStreak > 0 && (
            <div className="w-px h-3 bg-foreground/[6%] shrink-0" />
          )}

          {currentStreak > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="text-accent-orange font-medium text-xs/4 tabular-nums">
                {currentStreak}
              </span>
              <span className="text-muted-foreground/60 text-xs/4">day streak</span>
            </div>
          )}
        </div>
      )}

      {/* Keyboard tip */}
      <div
        className={cn(
          'flex items-center mt-1 rounded-md py-1.5 px-3 gap-1.5 bg-foreground/[3%]',
          'empty-state-entrance stagger-delay-5 motion-reduce:animate-none'
        )}
      >
        <span className="text-muted-foreground/60 text-[11px]/3.5">Tip: use</span>
        <kbd className="inline-flex items-center rounded-sm py-px px-1.5 bg-foreground/[4%] border border-foreground/10 text-muted-foreground font-medium text-[10px]/3.5">
          ⌘V
        </kbd>
        <span className="text-muted-foreground/60 text-[11px]/3.5">
          to quick-capture from clipboard
        </span>
      </div>
    </div>
  )
}

export { InboxZeroState }
