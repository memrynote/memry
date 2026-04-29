import { useState, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useT } from '@memry/i18n/renderer'

import { cn } from '@/lib/utils'
import { BellRing, FileText, Calendar, Clock, ChevronRight } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { SnoozePicker } from '@/components/snooze/snooze-picker'
import { inOneHour, tomorrow, nextWeek } from '@/components/snooze/snooze-presets'
import { inboxService } from '@/services/inbox-service'
import { inboxKeys } from '@/hooks/use-inbox'
import { useTabs } from '@/contexts/tabs'
import { createLogger } from '@/lib/logger'
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
    default:
      return FileText
  }
}

export function ReminderDetail({ item }: ReminderDetailProps): React.JSX.Element {
  const { t } = useT('inbox')
  const metadata = item.metadata as ReminderMetadata | undefined
  const queryClient = useQueryClient()
  const { openTab } = useTabs()
  const [isSnoozing, setIsSnoozing] = useState(false)
  const [isMarkingViewed, setIsMarkingViewed] = useState(false)
  const [localViewedAt, setLocalViewedAt] = useState<Date | null>(item.viewedAt ?? null)

  const invalidateInbox = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
    queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
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
      handleSnooze(getTime().toISOString())
    },
    [handleSnooze]
  )

  const handleMarkViewed = useCallback(async () => {
    setIsMarkingViewed(true)
    try {
      await inboxService.markViewed(item.id)
      setLocalViewedAt(new Date())
      invalidateInbox()
    } catch (err) {
      log.error('Failed to mark reminder as viewed', err)
    } finally {
      setIsMarkingViewed(false)
    }
  }, [item.id, invalidateInbox])

  const handleNavigateToSource = useCallback(() => {
    if (!metadata) return

    inboxService.markViewed(item.id).catch(() => {})

    switch (metadata.targetType) {
      case 'note':
      case 'highlight':
        openTab({
          type: 'note',
          title: metadata.targetTitle || t('reminder.noteFallback'),
          icon: 'file-text',
          path: `/notes/${metadata.targetId}`,
          entityId: metadata.targetId,
          isPinned: false,
          isModified: false,
          isPreview: true,
          isDeleted: false,
          viewState:
            metadata.targetType === 'highlight'
              ? {
                  highlightStart: metadata.highlightStart,
                  highlightEnd: metadata.highlightEnd,
                  highlightText: metadata.highlightText
                }
              : undefined
        })
        break
      case 'journal':
        openTab({
          type: 'journal',
          title: t('reminder.journalFallback'),
          icon: 'book-open',
          path: '/journal',
          isPinned: false,
          isModified: false,
          isPreview: false,
          isDeleted: false,
          viewState: { date: metadata.targetId }
        })
        break
    }
  }, [metadata, item.id, openTab, t])

  if (!metadata) {
    return <div className="p-5 text-muted-foreground text-sm">{t('reminder.dataUnavailable')}</div>
  }

  const TargetIcon = getTargetIcon(metadata.targetType)
  const isViewed = localViewedAt !== null
  const presetLabels = {
    'in-1-hour': t('reminder.presetInOneHour'),
    tomorrow: t('reminder.presetTomorrow'),
    'next-week': t('reminder.presetNextWeek')
  }

  return (
    <div className="flex flex-col gap-3.5 p-5 text-xs/4">
      {/* Triggered banner */}
      <div
        className={cn(
          'flex items-center rounded-lg py-2 px-3 gap-1.5',
          'bg-[var(--accent-orange)]/5 border border-[var(--accent-orange)]/15'
        )}
      >
        <BellRing className="size-4 text-[var(--accent-orange)]" aria-hidden="true" />
        <span className="text-[var(--accent-orange)] font-medium text-xs">
          {t('reminder.triggered')}
        </span>
        <span className="ml-auto text-text-tertiary text-[11px]">
          {formatTriggerDate(metadata.remindAt)}
        </span>
      </div>

      {/* Reminder note */}
      {metadata.reminderNote && (
        <div className="flex flex-col gap-1">
          <span className="uppercase tracking-[0.04em] text-text-tertiary font-medium text-[11px]">
            {t('reminder.noteLabel')}
          </span>
          <p className="text-muted-foreground text-[13px] leading-5">{metadata.reminderNote}</p>
        </div>
      )}

      {/* Source card */}
      <div className="flex flex-col gap-1">
        <span className="uppercase tracking-[0.04em] text-text-tertiary font-medium text-[11px]">
          {t('reminder.source')}
        </span>
        <button
          type="button"
          onClick={handleNavigateToSource}
          className={cn(
            'flex items-center rounded-lg py-2.5 px-3 gap-2.5 w-full text-left',
            'bg-muted/30 border border-border',
            'hover:bg-muted/50 transition-colors cursor-pointer'
          )}
        >
          <TargetIcon className="size-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
          <div className="flex flex-col gap-0.5 min-w-0 flex-1">
            <span className="text-foreground text-xs truncate">
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
            {metadata.highlightText && (
              <span className="text-text-tertiary text-[11px] truncate">
                {t('reminder.highlighted', { text: metadata.highlightText })}
              </span>
            )}
          </div>
          <ChevronRight className="size-2.5 text-text-tertiary shrink-0" aria-hidden="true" />
        </button>
      </div>

      {/* Mark as viewed */}
      <div className="flex items-center gap-2">
        {isViewed ? (
          <span className="text-text-tertiary text-[11px]">{t('reminder.viewed')}</span>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={handleMarkViewed}
            disabled={isMarkingViewed}
            className="h-auto py-0.5 px-2 text-[11px] text-muted-foreground border-border"
          >
            {t('reminder.markViewed')}
          </Button>
        )}
        {!isViewed && (
          <span className="text-text-tertiary text-[11px]">
            &{/* TODO(i18n): wrap in t() */}middot; {t('reminder.notYetViewed')}
          </span>
        )}
      </div>

      {/* Snooze section */}
      <div className="flex flex-col gap-2.5 pt-3.5 border-t border-border">
        <div className="flex items-center gap-1.5">
          <Clock className="size-3.5 text-muted-foreground/60" aria-hidden="true" />
          <span className="uppercase tracking-[0.04em] text-muted-foreground/60 text-xs font-medium">
            {t('reminder.snooze')}
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {SNOOZE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => handlePresetSnooze(preset.getTime)}
              disabled={isSnoozing}
              className={cn(
                'rounded-md py-1 px-2.5 text-[13px]',
                'bg-muted/50 text-muted-foreground',
                'hover:bg-muted/80 transition-colors',
                'disabled:opacity-50 disabled:cursor-not-allowed'
              )}
            >
              {presetLabels[preset.id]}
            </button>
          ))}
          <SnoozePicker
            onSnooze={handleSnooze}
            disabled={isSnoozing}
            trigger={
              <button
                type="button"
                disabled={isSnoozing}
                className={cn(
                  'flex items-center gap-1.5 rounded-md py-1 px-2.5 text-[13px]',
                  'border border-border text-muted-foreground/60',
                  'hover:bg-muted/30 transition-colors',
                  'disabled:opacity-50 disabled:cursor-not-allowed'
                )}
              >
                <Calendar className="size-3" aria-hidden="true" />
                {t('reminder.custom')}
              </button>
            }
          />
        </div>
      </div>
    </div>
  )
}
