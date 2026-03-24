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
    <div className="flex flex-1 flex-col items-center justify-center gap-8 bg-background p-12">
      <div
        className={cn(
          'flex size-24 items-center justify-center rounded-full',
          'bg-accent-green/10',
          'transition-all duration-700 ease-out',
          showCheck ? 'scale-100 opacity-100' : 'scale-50 opacity-0'
        )}
      >
        <div
          className={cn(
            'flex size-16 items-center justify-center rounded-full',
            'bg-accent-green/20',
            'transition-all delay-200 duration-500 ease-out',
            showCheck ? 'scale-100' : 'scale-75'
          )}
        >
          <Check
            className={cn(
              'size-8 text-accent-green',
              'transition-all delay-400 duration-300',
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
        <h2 className="text-3xl font-semibold tracking-tight text-foreground">Inbox Zero</h2>

        <div className="mt-4 flex items-center justify-center gap-4">
          <div className="text-center">
            <div className="text-2xl font-semibold tabular-nums text-foreground">
              {processedCount}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {processedCount === 1 ? 'item' : 'items'} processed
            </div>
          </div>

          {streak > 0 && (
            <>
              <div className="h-8 w-px bg-border" />
              <div className="flex flex-col items-center gap-1">
                <StreakBadge streak={streak} size="md" />
                <div className="text-[11px] text-muted-foreground">streak</div>
              </div>
            </>
          )}
        </div>

        <p className="mt-4 text-sm italic text-muted-foreground">
          {pickMotivation(processedCount)}
        </p>
      </div>

      <button
        type="button"
        onClick={onReturnToInbox}
        className={cn(
          'inline-flex items-center gap-2 rounded-xl px-6 py-2.5 text-sm font-medium',
          'bg-foreground/5 text-foreground hover:bg-foreground/10',
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
