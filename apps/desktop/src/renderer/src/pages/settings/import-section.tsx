import { useEffect, useMemo, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import {
  SETTINGS_CARD,
  SETTINGS_GROUP_LABEL,
  SettingsHeader
} from '@/components/settings/settings-primitives'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { ChevronRight, Search } from '@/lib/icons'
import { ImportSourceIcon } from '@/components/import/import-source-icon'
import { ImportDialog } from '@/components/settings/import-dialog'
import { useImporters, type ImporterItem } from '@/hooks/use-importers'
import { useReadwiseStatus } from '@/hooks/use-readwise-status'
import { deriveReadwiseState } from '@/components/settings/readwise-state'
import type { SettingsFocusTarget } from '@/contexts/settings-modal-context'
import { formatRelativePast } from '@/lib/format-relative-past'

type ImportGroupId = 'reading' | 'noteApps' | 'tasks' | 'files'

const IMPORT_GROUP_ORDER: ImportGroupId[] = ['reading', 'noteApps', 'tasks', 'files']

const IMPORT_GROUP_IDS: Record<ImportGroupId, string[]> = {
  reading: ['readwise'],
  noteApps: [
    'notion',
    'evernote',
    'apple-notes',
    'bear',
    'onenote',
    'google-keep',
    'roam',
    'noteplan'
  ],
  tasks: ['todoist', 'ticktick', 'apple-journal', 'raindrop'],
  files: ['markdown', 'html', 'csv']
}

/** Sources whose fileSpec has no single representative extension. */
const IMPORT_FORMAT_OVERRIDES: Record<string, string> = {
  'apple-notes': 'macOS',
  noteplan: 'macOS',
  bear: '.bear2bk',
  'google-keep': '.zip'
}

function groupOf(id: string): ImportGroupId {
  return IMPORT_GROUP_ORDER.find((group) => IMPORT_GROUP_IDS[group].includes(id)) ?? 'files'
}

function sortWithinGroup(group: ImportGroupId, items: ImporterItem[]): ImporterItem[] {
  const order = IMPORT_GROUP_IDS[group]
  const rank = (id: string): number => {
    const index = order.indexOf(id)
    return index === -1 ? order.length : index
  }
  return [...items].sort((a, b) => rank(a.id) - rank(b.id))
}

interface ImportSettingsProps {
  focusTarget?: SettingsFocusTarget | null
  focusRequestId?: number
}

export function ImportSettings({ focusTarget, focusRequestId }: ImportSettingsProps = {}) {
  const { t, i18n } = useT('settings')
  const { importers } = useImporters()
  const [active, setActive] = useState<ImporterItem | null>(null)
  const [query, setQuery] = useState('')

  const hasReadwise = importers.some((item) => item.id === 'readwise')
  const readwise = useReadwiseStatus(hasReadwise)

  // Where other rows show a file format, Readwise shows its connection state (D1).
  const readwiseState = (): string => {
    const state = deriveReadwiseState(readwise.status)
    switch (state.kind) {
      case 'not-connected':
        return t('import.v2.readwise.notConnected')
      case 'other-device':
        return state.deviceName
          ? t('import.v2.readwise.otherDevice', { device: state.deviceName })
          : t('import.v2.readwise.otherDeviceUnknown')
      case 'waiting-for-sync':
        return t('import.v2.readwise.waiting')
      case 'syncing':
        return t('import.v2.readwise.syncing')
      case 'error':
        return t(
          {
            'invalid-token': 'import.v2.readwise.invalidToken',
            'subscription-expired': 'import.v2.readwise.subscriptionExpired',
            'rate-limited': 'import.v2.readwise.rateLimited',
            network: 'import.v2.readwise.network',
            server: 'import.v2.readwise.server',
            unexpected: 'import.v2.readwise.unexpected'
          }[state.error]
        )
      case 'synced':
        return t('import.v2.readwise.synced', {
          time: formatRelativePast(state.at, i18n.language)
        })
      case 'connected':
        return t('import.v2.readwise.connected')
    }
  }

  const formatOf = (item: ImporterItem): string => {
    if (item.id === 'readwise') return readwiseState()
    if (IMPORT_FORMAT_OVERRIDES[item.id]) return IMPORT_FORMAT_OVERRIDES[item.id]
    const extension = item.fileSpec.extensions[0]
    if (extension) return `.${extension}`
    return item.accountBased ? t('import.v2.formatAccount') : ''
  }

  // The error toast's "Open Readwise" lands here with the Readwise panel open.
  const readwiseItem = importers.find((item) => item.id === 'readwise') ?? null
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect, react-you-might-not-need-an-effect/no-adjust-state-on-prop-change -- opens the Readwise panel in response to an external focus request (toast deep link)
    if (focusTarget === 'readwise-import' && readwiseItem) setActive(readwiseItem)
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- focusRequestId re-triggers the effect when the same target is requested again
  }, [focusTarget, focusRequestId, readwiseItem])

  const normalizedQuery = query.trim().toLowerCase()
  const groups = useMemo(() => {
    const matches = normalizedQuery
      ? importers.filter((item) =>
          [item.name, item.id, ...item.fileSpec.extensions, IMPORT_FORMAT_OVERRIDES[item.id] ?? '']
            .map((value) => value.toLowerCase().replace(/^\./, ''))
            .some((value) => value.includes(normalizedQuery.replace(/^\./, '')))
        )
      : importers
    return IMPORT_GROUP_ORDER.map((group) => ({
      id: group,
      items: sortWithinGroup(
        group,
        matches.filter((item) => groupOf(item.id) === group)
      )
    })).filter((group) => group.items.length > 0)
  }, [importers, normalizedQuery])

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader title={t('import.header.title')} subtitle={t('import.header.subtitle')} />

      <p className="pb-4 text-xs/4 text-muted-foreground">{t('import.intro')}</p>

      <div className="relative pb-6">
        <Search className="absolute start-3 top-2 w-3.5 h-3.5 text-muted-foreground" />
        <Input
          type="search"
          placeholder={t('import.v2.searchPlaceholder')}
          aria-label={t('import.v2.searchPlaceholder')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
          }}
          className="ps-8 h-8 text-xs/4 rounded-lg border-border bg-transparent"
        />
      </div>

      {importers.length > 0 && groups.length === 0 && (
        <p className="text-xs/4 text-muted-foreground">
          {t('import.v2.noMatch', { query: query.trim() })}
        </p>
      )}

      {groups.map((group) => (
        <section
          key={group.id}
          className="flex flex-col pb-9"
          data-testid={`import-group-${group.id}`}
        >
          <h4 className={SETTINGS_GROUP_LABEL}>{t(`import.v2.groups.${group.id}`)}</h4>
          <ul className={SETTINGS_CARD}>
            {group.items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => {
                    setActive(item)
                  }}
                  data-testid={`import-source-${item.id}`}
                  className="group flex w-full items-center gap-3 min-h-13 py-2.5 text-start focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm"
                >
                  <ImportSourceIcon id={item.id} name={item.name} />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-[13px]/4 text-foreground">{item.name}</span>
                    <span className="truncate text-xs/4 text-muted-foreground">
                      {t(item.descriptionKey)}
                    </span>
                  </span>
                  <span
                    className={cn(
                      'shrink-0 truncate text-end text-xs/4 text-muted-foreground',
                      item.id === 'readwise' ? 'max-w-40' : 'w-16 font-mono'
                    )}
                  >
                    {formatOf(item)}
                  </span>
                  <ChevronRight
                    aria-hidden="true"
                    className="w-3.5 h-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground rtl:rotate-180"
                  />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <ImportDialog
        item={active}
        open={active !== null}
        onOpenChange={(open) => {
          if (!open) {
            setActive(null)
            readwise.refresh()
          }
        }}
      />
    </div>
  )
}
