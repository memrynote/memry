import { useState, useCallback, useEffect, useRef } from 'react'
import { useTriageQueue } from '@/hooks/use-triage-queue'
import { useInboxStats } from '@/hooks/use-inbox'
import { useUndoableAction } from '@/hooks/use-undoable-action'
import { useTabs } from '@/contexts/tabs'
import { TriageProgress } from '@/components/inbox/triage-progress'
import { TriageItemCard } from '@/components/inbox/triage-item-card'
import { TriageActionBar } from '@/components/inbox/triage-action-bar'
import { TriageComplete } from '@/components/inbox/triage-complete'
import { StreakBadge } from '@/components/inbox/streak-badge'
import { cn } from '@/lib/utils'
import { Loader2 } from '@/lib/icons'
import type { Toast } from '@/components/ui/toast'
import type { FileItemInput, SnoozeInput } from '@/services/inbox-service'
import type { ReminderMetadata } from '@memry/contracts/inbox-api'

type SlideDirection = 'left' | 'right' | null

interface TriageViewProps {
  onExit: () => void
  addToast: (toast: Omit<Toast, 'id'>) => void
}

export function TriageView({ onExit, addToast }: TriageViewProps): React.JSX.Element | null {
  const { state, actions } = useTriageQueue()
  const { stats } = useInboxStats()
  const { archiveWithUndo } = useUndoableAction(addToast)
  const { openTab } = useTabs()
  const [slideDir, setSlideDir] = useState<SlideDirection>(null)
  const [isAnimating, setIsAnimating] = useState(false)
  const [showComplete, setShowComplete] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [])

  useEffect(() => {
    if (!state.isLoading && state.totalItems === 0 && !showComplete) {
      onExit()
    }
  }, [state.isLoading, state.totalItems, onExit, showComplete])

  useEffect(() => {
    if (!state.isLoading && state.isComplete && state.completedCount > 0) {
      setShowComplete(true)
    }
  }, [state.isLoading, state.isComplete, state.completedCount])

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

  const handleDiscard = useCallback(() => {
    const item = state.currentItem
    if (!item) return
    animateAndAct('left', async () => {
      await archiveWithUndo(item.id, item.title)
      actions.advanceAfterExternalAction()
    })
  }, [animateAndAct, state.currentItem, archiveWithUndo, actions])

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

  const handleOpenTarget = useCallback(() => {
    const item = state.currentItem
    if (!item || item.type !== 'reminder' || !item.metadata) return
    const meta = item.metadata as ReminderMetadata
    switch (meta.targetType) {
      case 'note':
      case 'highlight':
        openTab({
          type: 'note',
          title: meta.targetTitle || 'Note',
          icon: 'file-text',
          path: `/notes/${meta.targetId}`,
          entityId: meta.targetId,
          isPinned: false,
          isModified: false,
          isPreview: true,
          isDeleted: false,
          viewState:
            meta.targetType === 'highlight'
              ? {
                  highlightStart: meta.highlightStart,
                  highlightEnd: meta.highlightEnd,
                  highlightText: meta.highlightText
                }
              : undefined
        })
        break
      case 'journal':
        openTab({
          type: 'journal',
          title: 'Journal',
          icon: 'book-open',
          path: '/journal',
          isPinned: false,
          isModified: false,
          isPreview: false,
          isDeleted: false,
          viewState: { date: meta.targetId }
        })
        break
    }
  }, [state.currentItem, openTab])

  if (state.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="text-muted-foreground size-6 animate-spin" />
      </div>
    )
  }

  if (showComplete) {
    return (
      <TriageComplete
        processedCount={state.completedCount}
        streak={stats?.currentStreak ?? 0}
        onReturnToInbox={onExit}
      />
    )
  }

  if (!state.currentItem) {
    return null
  }

  const streak = stats?.currentStreak ?? 0

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center">
        <div className="flex-1">
          <TriageProgress
            current={state.currentIndex}
            total={state.totalItems}
            completed={state.completedCount}
          />
        </div>
        {streak > 0 && (
          <div className="pr-6">
            <StreakBadge streak={streak} />
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div
          key={state.currentItem.id}
          className={cn(
            'transition-[transform,opacity] duration-250 ease-out will-change-[transform,opacity]',
            slideDir === 'left' && '-translate-x-full scale-95 opacity-0',
            slideDir === 'right' && 'translate-x-full scale-95 opacity-0',
            !slideDir && 'animate-in fade-in slide-in-from-bottom-3 duration-300'
          )}
        >
          <TriageItemCard item={state.currentItem} />
        </div>
      </div>

      <TriageActionBar
        itemId={state.currentItem.id}
        itemType={state.currentItem.type}
        onDiscard={handleDiscard}
        onConvertToTask={handleConvertToTask}
        onExpandToNote={handleExpandToNote}
        onFile={handleFile}
        onDefer={handleDefer}
        onDismissReminder={handleDiscard}
        onOpenTarget={handleOpenTarget}
        disabled={isAnimating}
      />
    </div>
  )
}
