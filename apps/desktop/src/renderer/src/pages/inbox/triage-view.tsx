import { useState, useCallback, useEffect, useRef } from 'react'
import { useTriageQueue } from '@/hooks/use-triage-queue'
import { TriageProgress } from '@/components/inbox/triage-progress'
import { TriageItemCard } from '@/components/inbox/triage-item-card'
import { TriageActionBar } from '@/components/inbox/triage-action-bar'
import { cn } from '@/lib/utils'
import { Loader2 } from 'lucide-react'
import type { FileItemInput, SnoozeInput } from '@/services/inbox-service'

type SlideDirection = 'left' | 'right' | null

interface TriageViewProps {
  onExit: () => void
}

export function TriageView({ onExit }: TriageViewProps): React.JSX.Element | null {
  const { state, actions } = useTriageQueue()
  const [slideDir, setSlideDir] = useState<SlideDirection>(null)
  const [isAnimating, setIsAnimating] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [])

  useEffect(() => {
    if (!state.isLoading && (state.isComplete || !state.currentItem)) {
      onExit()
    }
  }, [state.isLoading, state.isComplete, state.currentItem, onExit])

  const animateAndAct = useCallback(
    (direction: SlideDirection, action: () => Promise<void> | void) => {
      if (isAnimating) return
      setIsAnimating(true)
      setSlideDir(direction)

      timeoutRef.current = setTimeout(async () => {
        try {
          await action()
        } catch (err) {
          console.error('Triage action failed:', err)
        } finally {
          setSlideDir(null)
          setIsAnimating(false)
        }
      }, 250)
    },
    [isAnimating]
  )

  const handleDiscard = useCallback(
    () => animateAndAct('left', actions.discard),
    [animateAndAct, actions.discard]
  )

  const handleConvertToTask = useCallback(
    () => animateAndAct('right', actions.convertToTask),
    [animateAndAct, actions.convertToTask]
  )

  const handleExpandToNote = useCallback(
    () => animateAndAct('right', actions.expandToNote),
    [animateAndAct, actions.expandToNote]
  )

  const handleFile = useCallback(
    (input: FileItemInput) => animateAndAct('right', () => actions.file(input)),
    [animateAndAct, actions.file]
  )

  const handleDefer = useCallback(
    (input: SnoozeInput) => animateAndAct('right', () => actions.defer(input)),
    [animateAndAct, actions.defer]
  )

  if (state.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="text-muted-foreground size-6 animate-spin" />
      </div>
    )
  }

  if (state.isComplete || !state.currentItem) {
    return null
  }

  return (
    <div className="flex flex-1 flex-col">
      <TriageProgress
        current={state.currentIndex}
        total={state.totalItems}
        completed={state.completedCount}
      />

      <div className="flex-1 overflow-y-auto">
        <div
          key={state.currentItem.id}
          className={cn(
            'transition-all duration-250 ease-out',
            slideDir === 'left' && '-translate-x-full opacity-0',
            slideDir === 'right' && 'translate-x-full opacity-0',
            !slideDir && 'animate-in fade-in slide-in-from-right-4 duration-200'
          )}
        >
          <TriageItemCard item={state.currentItem} />
        </div>
      </div>

      <TriageActionBar
        itemId={state.currentItem.id}
        onDiscard={handleDiscard}
        onConvertToTask={handleConvertToTask}
        onExpandToNote={handleExpandToNote}
        onFile={handleFile}
        onDefer={handleDefer}
        disabled={isAnimating}
      />
    </div>
  )
}
