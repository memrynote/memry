import { useState, useEffect } from 'react'
import { Check, ArrowLeft } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { StreakBadge } from './streak-badge'

interface TriageCompleteProps {
  processedCount: number
  streak: number
  onReturnToInbox: () => void
}

const MOTIVATIONAL_COPY = [
  'Your future self thanks you.',
  'Everything in its place.',
  'Clear inbox, clear mind.',
  'Decision debt: paid in full.',
  "That felt good, didn't it?"
]

function pickMotivation(count: number): string {
  return MOTIVATIONAL_COPY[count % MOTIVATIONAL_COPY.length]
}

export function TriageComplete({
  processedCount,
  streak,
  onReturnToInbox
}: TriageCompleteProps): React.JSX.Element {
  const [showCheck, setShowCheck] = useState(false)
  const [showStats, setShowStats] = useState(false)
  const [showButton, setShowButton] = useState(false)

  useEffect(() => {
    const t1 = setTimeout(() => setShowCheck(true), 100)
    const t2 = setTimeout(() => setShowStats(true), 500)
    const t3 = setTimeout(() => setShowButton(true), 900)
    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
      clearTimeout(t3)
    }
  }, [])

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 p-12">
      <div
        className={cn(
          'flex h-24 w-24 items-center justify-center rounded-full',
          'bg-emerald-500/10 dark:bg-emerald-500/15',
          'transition-all duration-700 ease-out',
          showCheck ? 'scale-100 opacity-100' : 'scale-50 opacity-0'
        )}
      >
        <div
          className={cn(
            'flex h-16 w-16 items-center justify-center rounded-full',
            'bg-emerald-500/20 dark:bg-emerald-500/25',
            'transition-all duration-500 delay-200 ease-out',
            showCheck ? 'scale-100' : 'scale-75'
          )}
        >
          <Check
            className={cn(
              'h-8 w-8 text-emerald-600 dark:text-emerald-400',
              'transition-all duration-300 delay-400',
              showCheck ? 'opacity-100' : 'opacity-0'
            )}
            strokeWidth={3}
          />
        </div>
      </div>

      <div
        className={cn(
          'text-center transition-all duration-500 ease-out',
          showStats ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'
        )}
      >
        <h2 className="text-3xl font-semibold tracking-tight">Inbox Zero</h2>

        <div className="mt-4 flex items-center justify-center gap-4">
          <div className="text-center">
            <div className="text-2xl font-semibold tabular-nums">{processedCount}</div>
            <div className="text-xs text-muted-foreground">
              {processedCount === 1 ? 'item' : 'items'} processed
            </div>
          </div>

          {streak > 0 && (
            <>
              <div className="h-8 w-px bg-border" />
              <div className="flex flex-col items-center gap-1">
                <StreakBadge streak={streak} size="md" />
                <div className="text-xs text-muted-foreground">streak</div>
              </div>
            </>
          )}
        </div>

        <p className="text-muted-foreground mt-4 text-sm italic">
          {pickMotivation(processedCount)}
        </p>
      </div>

      <button
        type="button"
        onClick={onReturnToInbox}
        className={cn(
          'inline-flex items-center gap-2 rounded-lg px-6 py-2.5 text-sm font-medium',
          'bg-foreground/5 hover:bg-foreground/10 text-foreground',
          'transition-all duration-500 ease-out',
          showButton ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'
        )}
      >
        <ArrowLeft className="size-4" />
        Back to Inbox
      </button>
    </div>
  )
}
