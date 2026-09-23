import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import { useT } from '@memry/i18n/renderer'
import {
  VAULT_ACTIVITY_RETENTION_DAYS,
  type VaultActivityEntry,
  type VaultActivityFilter,
  type VaultActivityRetentionDays
} from '@memry/contracts/vault-activity-api'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import {
  AlertTriangle,
  FileMinus,
  FilePen,
  FilePlus,
  FileX,
  FolderSearch,
  Import,
  XCircle
} from '@/lib/icons'
import type { AppIcon } from '@/lib/icons/types'
import { getActiveLocale } from '@/lib/active-locale'
import { extractErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import { useImporters } from '@/hooks/use-importers'
import type { SettingsFocusTarget } from '@/contexts/settings-modal-context'
import { useVaultActivity, vaultActivityKeys } from '@/hooks/use-vault-activity'
import { COMPACT_SELECT, SettingsGroup, SettingRow } from './settings-primitives'
import { describeVaultActivity, type VaultActivityTone } from './vault-activity-describe'

const KIND_ICONS: Record<VaultActivityEntry['kind'], AppIcon> = {
  added: FilePlus,
  removed: FileMinus,
  renamed: FilePen,
  skipped: FileX,
  failed: XCircle,
  scan: FolderSearch,
  import: Import
}

const TONE_ICON_CLASS: Record<VaultActivityTone, string> = {
  neutral: 'text-muted-foreground',
  warning: 'text-amber-600 dark:text-amber-400',
  error: 'text-destructive'
}

const TOGGLE_ITEM_CLASS =
  'rounded-none border-none px-3 h-7 text-xs/4 font-medium data-[state=on]:bg-[var(--tint)] data-[state=on]:text-white'

interface VaultActivitySettingsProps {
  /** `vault-activity` when Settings was opened to bring this group into view. */
  focusTarget?: SettingsFocusTarget | null
  /** Changes on every such request, so a repeat request scrolls again. */
  focusRequestId?: number
}

export function VaultActivitySettings({ focusTarget, focusRequestId }: VaultActivitySettingsProps) {
  const { t } = useT('settings')
  const { t: tCommon } = useT('common')
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState<VaultActivityFilter>('all')
  const [confirmClear, setConfirmClear] = useState(false)
  const { data, isLoading, error } = useVaultActivity(filter)
  const { importers } = useImporters()
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (focusTarget !== 'vault-activity' || !focusRequestId) return
    containerRef.current?.scrollIntoView({ block: 'start' })
  }, [focusTarget, focusRequestId])

  const importerNames = useMemo(
    () => new Map(importers.map((importer) => [importer.id, importer.name])),
    [importers]
  )
  const resolveImporterName = useCallback(
    (id: string) => importerNames.get(id) ?? id,
    [importerNames]
  )

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(getActiveLocale(), { dateStyle: 'medium', timeStyle: 'short' }),
    []
  )

  const refetch = useCallback(
    () => queryClient.invalidateQueries({ queryKey: vaultActivityKeys.all }),
    [queryClient]
  )

  const handleRetentionChange = useCallback(
    async (value: string) => {
      const days = Number(value) as VaultActivityRetentionDays
      try {
        await window.api.vaultActivity.setRetention(days)
        await refetch()
      } catch (err) {
        toast.error(extractErrorMessage(err, t('vault.activity.actionFailed')))
      }
    },
    [refetch, t]
  )

  const handleReveal = useCallback(async () => {
    try {
      await window.api.vaultActivity.reveal()
    } catch (err) {
      toast.error(extractErrorMessage(err, t('vault.activity.actionFailed')))
    }
  }, [t])

  const handleClear = useCallback(async () => {
    try {
      await window.api.vaultActivity.clear()
      setConfirmClear(false)
      await refetch()
    } catch (err) {
      toast.error(extractErrorMessage(err, t('vault.activity.actionFailed')))
    }
  }, [refetch, t])

  const entries = data?.entries ?? []
  const available = data?.available ?? true

  let body: ReactNode
  if (error) {
    body = (
      <p className="text-xs/4 text-destructive">
        {extractErrorMessage(error, t('vault.activity.loadFailed'))}
      </p>
    )
  } else if (!available) {
    body = <p className="text-xs/4 text-muted-foreground">{t('vault.activity.unavailable')}</p>
  } else if (!isLoading && entries.length === 0) {
    body = (
      <p className="text-xs/4 text-muted-foreground">
        {filter === 'problems' ? t('vault.activity.emptyProblems') : t('vault.activity.empty')}
      </p>
    )
  } else {
    body = (
      <ul
        className="flex flex-col max-h-96 overflow-y-auto -mx-4"
        data-testid="vault-activity-list"
      >
        {entries.map((entry) => (
          <VaultActivityRow
            key={entry.id}
            entry={entry}
            time={dateFormatter.format(new Date(entry.at))}
            resolveImporterName={resolveImporterName}
          />
        ))}
      </ul>
    )
  }

  return (
    <div ref={containerRef} className="scroll-mt-6" data-testid="vault-activity">
      <SettingsGroup label={t('vault.groups.activity')}>
        <SettingRow
          label={t('vault.activity.retention.label')}
          description={t('vault.activity.description')}
        >
          <Select
            value={String(data?.retentionDays ?? 30)}
            onValueChange={(value) => void handleRetentionChange(value)}
            disabled={!available}
          >
            <SelectTrigger
              className={COMPACT_SELECT}
              aria-label={t('vault.activity.retention.label')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {VAULT_ACTIVITY_RETENTION_DAYS.map((days) => (
                <SelectItem key={days} value={String(days)}>
                  {t('vault.activity.retention.days', { count: days })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>

        <div className="flex flex-col gap-3 py-3 px-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <ToggleGroup
              type="single"
              value={filter}
              onValueChange={(value) => {
                if (value === 'all' || value === 'problems') setFilter(value)
              }}
              className="gap-0 rounded-md border border-border overflow-clip"
            >
              <ToggleGroupItem value="all" className={TOGGLE_ITEM_CLASS}>
                {t('vault.activity.filter.all')}
              </ToggleGroupItem>
              <ToggleGroupItem
                value="problems"
                className={cn(TOGGLE_ITEM_CLASS, 'border-s border-border')}
              >
                {t('vault.activity.filter.problems')}
              </ToggleGroupItem>
            </ToggleGroup>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-3 text-xs/4"
                disabled={!available}
                onClick={() => void handleReveal()}
              >
                {t('vault.activity.reveal')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-3 text-xs/4"
                disabled={!available || entries.length === 0}
                onClick={() => setConfirmClear(true)}
              >
                {t('vault.activity.clear')}
              </Button>
            </div>
          </div>
          {body}
        </div>
      </SettingsGroup>

      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('vault.activity.clearTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('vault.activity.clearBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon('button.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                void handleClear()
              }}
            >
              {t('vault.activity.clearConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function VaultActivityRow({
  entry,
  time,
  resolveImporterName
}: {
  entry: VaultActivityEntry
  time: string
  resolveImporterName: (id: string) => string
}) {
  const { t } = useT('settings')
  const description = describeVaultActivity(entry, t, resolveImporterName)
  const Icon =
    description.tone === 'warning' && entry.kind === 'scan' ? AlertTriangle : KIND_ICONS[entry.kind]
  const items = entry.items ?? []

  return (
    <li className="flex items-start gap-2.5 py-2 px-4 border-t border-border first:border-t-0">
      <Icon
        className={cn('w-4 h-4 mt-px shrink-0', TONE_ICON_CLASS[description.tone])}
        aria-hidden="true"
      />
      <div className="flex flex-col gap-0.5 min-w-0 flex-1">
        <span className="text-[13px]/4 text-foreground break-words">{description.title}</span>
        {description.detail && (
          <span className="text-xs/4 text-muted-foreground break-words">{description.detail}</span>
        )}
        {items.length > 0 && (
          <details className="text-xs/4 text-muted-foreground">
            <summary className="cursor-pointer select-none">
              {t('vault.activity.showItems', { count: items.length })}
            </summary>
            <ul className="mt-1 flex flex-col gap-0.5 ps-4 list-disc">
              {items.map((item, index) => (
                <li key={index} className="break-words">
                  {item}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <time
        dateTime={entry.at}
        className="text-xs/4 text-muted-foreground tabular-nums shrink-0 text-end"
      >
        {time}
      </time>
    </li>
  )
}
