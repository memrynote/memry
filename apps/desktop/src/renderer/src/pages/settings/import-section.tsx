import { useMemo, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import {
  SETTINGS_CARD,
  SETTINGS_GROUP_LABEL,
  SettingsHeader
} from '@/components/settings/settings-primitives'
import { Input } from '@/components/ui/input'
import { ChevronRight, Search } from '@/lib/icons'
import { ImportSourceIcon } from '@/components/import/import-source-icon'
import { ImportDialog } from '@/components/settings/import-dialog'
import { useImporters, type ImporterItem } from '@/hooks/use-importers'

type ImportGroupId = 'noteApps' | 'tasks' | 'files'

const IMPORT_GROUP_ORDER: ImportGroupId[] = ['noteApps', 'tasks', 'files']

const IMPORT_GROUP_IDS: Record<ImportGroupId, string[]> = {
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

export function ImportSettings() {
  const { t } = useT('settings')
  const { importers } = useImporters()
  const [active, setActive] = useState<ImporterItem | null>(null)
  const [query, setQuery] = useState('')

  const formatOf = (item: ImporterItem): string => {
    if (IMPORT_FORMAT_OVERRIDES[item.id]) return IMPORT_FORMAT_OVERRIDES[item.id]
    const extension = item.fileSpec.extensions[0]
    if (extension) return `.${extension}`
    return item.accountBased ? t('import.v2.formatAccount') : ''
  }

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
          onChange={(e) => setQuery(e.target.value)}
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
                  onClick={() => setActive(item)}
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
                  <span className="w-16 shrink-0 truncate text-end font-mono text-xs/4 text-muted-foreground">
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
          if (!open) setActive(null)
        }}
      />
    </div>
  )
}
