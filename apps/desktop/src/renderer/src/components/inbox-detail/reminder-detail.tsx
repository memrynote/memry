import { useState, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useT } from '@memry/i18n/renderer'

import { cn } from '@/lib/utils'
import { BellRing, FileText, Calendar, ChevronRight, CheckSquare } from '@/lib/icons'
import { DRAWER_ROW } from '@/components/tasks/drawer-section'
import { SnoozePicker } from '@/components/snooze/snooze-picker'
import { inOneHour, tomorrow, nextWeek } from '@/components/snooze/snooze-presets'
import { inboxService } from '@/services/inbox-service'
import { inboxKeys } from '@/hooks/use-inbox'
import { useUndoableAction } from '@/hooks/use-undoable-action'
import { useTabs } from '@/contexts/tabs'
import { toast } from 'sonner'
import { createLogger } from '@/lib/logger'
import { buildReminderTargetTab } from '@/lib/open-reminder-target'
import type { InboxItem, InboxItemListItem } from '@/types'
import type { ReminderMetadata } from '@memry/contracts/inbox-api'

const log = createLogger('Component:ReminderDetail')

type ReminderItem = InboxItem | InboxItemListItem

interface ReminderDetailProps {
  item: ReminderItem
}

const SNOOZE_PRESETS = [
  { id: 'in-1-hour', getTime: inOneHour },
  { id: 'tomorrow', getTime: tomorrow },
  { id: 'next-week', getTime: nextWeek }
] as const

function formatTriggerDate(isoString: string): string {
  const date = new Date(isoString)
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  })
}

function getTargetIcon(targetType: string) {
  switch (targetType) {
    case 'journal':
      return Calendar
    case 'task':
      return CheckSquare
    default:
      return FileText
  }
}

export function ReminderDetail({ item }: ReminderDetailProps): React.JSX.Element {
  const { t } = useT('inbox')
  const metadata = item.metadata as ReminderMetadata | undefined
  const queryClient = useQueryClient()
  const { openTab } = useTabs()
  const { archiveWithUndo } = useUndoableAction()
  const [isSnoozing, setIsSnoozing] = useState(false)
  const [isArchiving, setIsArchiving] = useState(false)

  const invalidateInbox = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
    void queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
  }, [queryClient])

  const handleSnooze = useCallback(
    async (snoozeUntil: string) => {
      setIsSnoozing(true)
      try {
        await inboxService.snooze({ itemId: item.id, snoozeUntil })
        invalidateInbox()
      } catch (err) {
        log.error('Failed to snooze reminder', err)
      } finally {
        setIsSnoozing(false)
      }
    },
    [item.id, invalidateInbox]
  )

  const handlePresetSnooze = useCallback(
    (getTime: () => Date) => {
      void handleSnooze(getTime().toISOString())
    },
    [handleSnooze]
  )

  const handleArchive = useCallback(async () => {
    setIsArchiving(true)
    try {
      await archiveWithUndo(item.id, item.title)
    } catch (err) {
      log.error('Failed to archive reminder', err)
    } finally {
      setIsArchiving(false)
    }
  }, [item.id, item.title, archiveWithUndo])

  const handleNavigateToSource = useCallback(() => {
    if (!metadata) return

    inboxService.markViewed(item.id).catch((err) => log.warn('Failed to mark reminder viewed', err))

    const tab = buildReminderTargetTab({
      targetType: metadata.targetType,
      targetId: metadata.targetId,
      targetTitle: metadata.targetTitle,
      projectId: metadata.projectId,
      anchorId: metadata.anchorId,
      highlightStart: metadata.highlightStart,
      highlightEnd: metadata.highlightEnd,
      highlightText: metadata.highlightText,
      fallbacks: {
        note: t('reminder.noteFallback'),
        journal: t('reminder.journalFallback'),
        task: t('reminder.taskFallback')
      }
    })

    // A journal reminder whose stored date is unusable has no day to open.
    // Say so rather than dropping the user on today's entry.
    if (!tab) {
      log.warn(`Reminder ${item.id} has an unusable target: ${metadata.targetId}`)
      toast.error(t('reminder.dataUnavailable'))
      return
    }

    openTab(tab)
  }, [metadata, item.id, openTab, t])

  if (!metadata) {
    return <div className="p-5 text-muted-foreground text-sm">{t('reminder.dataUnavailable')}</div>
  }

  const TargetIcon = getTargetIcon(metadata.targetType)
  const isViewed = item.viewedAt != null
  const presetLabels = {
    'in-1-hour': t('reminder.presetInOneHour'),
    tomorrow: t('reminder.presetTomorrow'),
    'next-week': t('reminder.presetNextWeek')
  }

  return (
    <div className="flex flex-col text-[13px] leading-[18px]">
      {/* The reminder's own words are the headline; when and whether it has
          been seen sit under it as one muted line. */}
      <div className="flex flex-col gap-1.5 px-5 pt-4 pb-3">
        <h3 className="text-[15px] leading-[22px] font-semibold text-text-primary">
          {metadata.reminderNote || item.title}
        </h3>
        <p className="flex flex-wrap items-center gap-x-1.5 text-[12px] leading-4 text-text-tertiary">
          <BellRing className="size-3 text-[var(--accent-orange)]" aria-hidden="true" />
          <span>{t('reminder.triggered')}</span>
          <span aria-hidden="true">·</span>
          <span>{formatTriggerDate(metadata.remindAt)}</span>
          <span aria-hidden="true">·</span>
          {isViewed ? (
            <span>{t('reminder.viewed')}</span>
          ) : (
            <>
              <span>{t('reminder.notYetViewed')}</span>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                onClick={() => void handleArchive()}
                disabled={isArchiving}
                className="text-text-secondary underline-offset-2 hover:text-text-primary hover:underline disabled:opacity-50"
              >
                {t('reminder.archive')}
              </button>
            </>
          )}
        </p>
      </div>

      {/* Source: one row on the drawer's icon lane, the highlight under it. */}
      <div className="flex flex-col px-3 pb-3">
        <button
          type="button"
          onClick={handleNavigateToSource}
          title={t('reminder.source')}
          className={cn(DRAWER_ROW, 'group')}
        >
          <TargetIcon className="size-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-text-primary">
            {metadata.targetType === 'journal'
              ? t('reminder.journalTitle', {
                  date: new Date(metadata.targetId).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric'
                  })
                })
              : metadata.targetTitle || t('reminder.noteFallback')}
          </span>
          <ChevronRight
            className="size-3 shrink-0 text-text-tertiary rtl:rotate-180"
            aria-hidden="true"
          />
        </button>
        {metadata.highlightText && (
          <p className="ps-[34px] pe-2 pt-1 text-[12px] leading-[17px] text-text-tertiary">
            {t('reminder.highlighted', { text: metadata.highlightText })}
          </p>
        )}
      </div>

      {/* Snooze: a label and the presets on one line. */}
      <div className="flex flex-wrap items-center gap-1.5 px-5 pt-3 pb-4 border-t border-border">
        <span className="pe-1 text-[12px] leading-4 text-text-tertiary">
          {t('reminder.snooze')}
        </span>
        {SNOOZE_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => handlePresetSnooze(preset.getTime)}
            disabled={isSnoozing}
            className={SNOOZE_CHIP}
          >
            {presetLabels[preset.id]}
          </button>
        ))}
        <SnoozePicker
          onSnooze={(snoozeUntil) => void handleSnooze(snoozeUntil)}
          disabled={isSnoozing}
          trigger={
            <button
              type="button"
              disabled={isSnoozing}
              className={cn(SNOOZE_CHIP, 'border-transparent text-text-secondary')}
            >
              <Calendar className="size-3" aria-hidden="true" />
              {t('reminder.custom')}
            </button>
          }
        />
      </div>
    </div>
  )
}

const SNOOZE_CHIP = cn(
  'flex h-6 items-center gap-1.5 rounded-md border border-border px-2 text-[12px] leading-4 text-text-primary',
  'transition-colors hover:bg-surface-active/60',
  'disabled:opacity-50 disabled:cursor-not-allowed'
)
