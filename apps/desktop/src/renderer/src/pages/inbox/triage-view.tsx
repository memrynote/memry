import { useState, useCallback, useEffect, useRef } from 'react'
import { useTriageQueue } from '@/hooks/use-triage-queue'
import { useInboxStats } from '@/hooks/use-inbox'
import { useUndoableAction } from '@/hooks/use-undoable-action'
import { useTabs } from '@/contexts/tabs'
import { TriageProgress } from '@/components/inbox/triage-progress'
import { TriageItemCard } from '@/components/inbox/triage-item-card'
import { TriageActionBar, type ActivePicker } from '@/components/inbox/triage-action-bar'
import { TriageComplete } from '@/components/inbox/triage-complete'
import { TriageSnoozePicker } from '@/components/inbox/triage-snooze-picker'
import { StreakBadge } from '@/components/inbox/streak-badge'
import { FilingSection, useFilingState } from '@/components/inbox-detail/filing-section'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Loader2, X, Check } from '@/lib/icons'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import { toast } from 'sonner'
import type { FileItemInput, SnoozeInput } from '@/services/inbox-service'
import type { ReminderMetadata } from '@memry/contracts/inbox-api'

const log = createLogger('Component:TriageView')

type SlideDirection = 'left' | 'right' | null

interface TriageViewProps {
  onExit: () => void
}

export function TriageView({ onExit }: TriageViewProps): React.JSX.Element | null {
  const { state, actions } = useTriageQueue()
  const { stats } = useInboxStats()
  const { archiveWithUndo } = useUndoableAction()
  const { openTab } = useTabs()
  const [slideDir, setSlideDir] = useState<SlideDirection>(null)
  const [isAnimating, setIsAnimating] = useState(false)
  const [showComplete, setShowComplete] = useState(false)
  const [activePicker, setActivePicker] = useState<ActivePicker>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const { selectedFolder, tags, linkedNotes, setSelectedFolder, setTags, setLinkedNotes, canFile } =
    useFilingState({ item: state.currentItem, isOpen: activePicker === 'file' })

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

  const closePicker = useCallback(() => setActivePicker(null), [])

  const animateAndAct = useCallback(
    (direction: SlideDirection, action: () => Promise<void> | void) => {
      if (isAnimating) return
      setIsAnimating(true)
      setSlideDir(direction)
      setActivePicker(null)

      timeoutRef.current = setTimeout(async () => {
        try {
          await action()
        } catch (err) {
          log.error('Triage action failed:', err)
          toast.error(extractErrorMessage(err, 'Action failed'))
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

  const handleFileSubmit = useCallback((): void => {
    if (!selectedFolder || !state.currentItem) return
    const linkedNoteIds = linkedNotes.map((n) => n.id)
    handleFile({
      itemId: state.currentItem.id,
      destination:
        linkedNoteIds.length > 0
          ? { type: 'note', noteIds: linkedNoteIds, path: selectedFolder.path || '' }
          : { type: 'folder', path: selectedFolder.path || '' },
      tags: tags.length > 0 ? tags : undefined
    })
  }, [selectedFolder, linkedNotes, tags, state.currentItem, handleFile])

  const handleSnoozeSelect = useCallback(
    (snoozeUntil: string): void => {
      if (!state.currentItem) return
      handleDefer({ itemId: state.currentItem.id, snoozeUntil })
    },
    [state.currentItem, handleDefer]
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
    <div className="flex flex-1 flex-col bg-background">
      <header className="flex shrink-0 items-center justify-between px-8 py-5">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onExit}
            className="text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Exit triage mode"
          >
            <X className="size-4" />
          </button>
          <span className="text-sm font-medium text-foreground">Triage Mode</span>
          <span className="text-xs text-text-tertiary">Esc to exit</span>
        </div>
        <div className="flex items-center gap-3">
          {streak > 0 && <StreakBadge streak={streak} />}
          <span className="text-xs tabular-nums text-muted-foreground">
            {state.currentIndex + 1} of {state.totalItems}
          </span>
        </div>
      </header>

      <div className="shrink-0 px-8">
        <TriageProgress completed={state.completedCount} total={state.totalItems} />
      </div>

      <div className="flex flex-1 items-center justify-center overflow-y-auto p-8">
        <div className="flex items-start justify-center gap-6">
          <div
            key={state.currentItem.id}
            className={cn(
              'shrink-0 transition-all duration-300 ease-out',
              slideDir === 'left' && '-translate-x-full scale-95 opacity-0',
              slideDir === 'right' && 'translate-x-full scale-95 opacity-0',
              !slideDir && 'animate-in fade-in slide-in-from-bottom-3 duration-300'
            )}
          >
            <TriageItemCard item={state.currentItem} />
          </div>

          {activePicker === 'file' && (
            <div className="w-[320px] shrink-0 animate-in fade-in slide-in-from-right-4 duration-300">
              <div className="overflow-hidden rounded-xl border border-foreground/[0.08] bg-card">
                <FilingSection
                  item={state.currentItem}
                  selectedFolder={selectedFolder}
                  tags={tags}
                  linkedNotes={linkedNotes}
                  onFolderSelect={setSelectedFolder}
                  onTagsChange={setTags}
                  onLinkedNotesChange={setLinkedNotes}
                />
                <div className="flex items-center gap-2 border-t border-border px-5 py-3">
                  <Button
                    size="sm"
                    onClick={handleFileSubmit}
                    disabled={!canFile}
                    className="flex-1 border-0 bg-tint text-tint-foreground hover:bg-tint-hover"
                  >
                    <Check className="mr-1.5 size-4" aria-hidden="true" />
                    File
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={closePicker}
                    className="text-muted-foreground"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            </div>
          )}

          {activePicker === 'snooze' && (
            <div className="w-[280px] shrink-0 animate-in fade-in slide-in-from-right-4 duration-300">
              <TriageSnoozePicker onSelect={handleSnoozeSelect} onCancel={closePicker} />
            </div>
          )}
        </div>
      </div>

      <TriageActionBar
        itemType={state.currentItem.type}
        activePicker={activePicker}
        onPickerChange={setActivePicker}
        onDiscard={handleDiscard}
        onConvertToTask={handleConvertToTask}
        onExpandToNote={handleExpandToNote}
        onOpenTarget={handleOpenTarget}
        disabled={isAnimating}
      />
    </div>
  )
}
