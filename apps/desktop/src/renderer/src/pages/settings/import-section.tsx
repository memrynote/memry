import { useMemo, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { SETTINGS_GROUP_LABEL, SettingsHeader } from '@/components/settings/settings-primitives'
import { Input } from '@/components/ui/input'
import { ChevronRight, FileCode, FileSpreadsheet, FileText, Search } from '@/lib/icons'
import { ImportDialog } from '@/components/settings/import-dialog'
import { useImporters, type ImporterItem } from '@/hooks/use-importers'
import appleJournalIcon from '@/assets/import-sources/apple-journal.png'
import appleNotesIcon from '@/assets/import-sources/apple-notes.png'
import bearIcon from '@/assets/import-sources/bear.png'
import evernoteIcon from '@/assets/import-sources/evernote.svg'
import googleKeepIcon from '@/assets/import-sources/google-keep.svg'
import noteplanIcon from '@/assets/import-sources/noteplan.png'
import notionIcon from '@/assets/import-sources/notion.png'
import onenoteIcon from '@/assets/import-sources/onenote.png'
import raindropIcon from '@/assets/import-sources/raindrop.png'
import roamIcon from '@/assets/import-sources/roam.png'
import ticktickIcon from '@/assets/import-sources/ticktick.png'
import todoistIcon from '@/assets/import-sources/todoist.png'

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

const IMPORT_SOURCE_LOGOS: Record<string, string> = {
  notion: notionIcon,
  evernote: evernoteIcon,
  'apple-notes': appleNotesIcon,
  bear: bearIcon,
  onenote: onenoteIcon,
  'google-keep': googleKeepIcon,
  roam: roamIcon,
  noteplan: noteplanIcon,
  todoist: todoistIcon,
  ticktick: ticktickIcon,
  'apple-journal': appleJournalIcon,
  raindrop: raindropIcon
}

const IMPORT_FORMAT_ICONS: Record<string, typeof FileText> = {
  markdown: FileText,
  html: FileCode,
  csv: FileSpreadsheet
}

function ImportSourceIcon({ item }: { item: ImporterItem }) {
  const logo = IMPORT_SOURCE_LOGOS[item.id]
  if (logo) {
    return (
      <img
        src={logo}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="size-6 shrink-0 rounded-md object-contain"
      />
    )
  }
  const FormatIcon = IMPORT_FORMAT_ICONS[item.id]
  return (
    <span
      aria-hidden="true"
      className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border text-[11px]/4 font-medium text-muted-foreground"
    >
      {FormatIcon ? <FormatIcon className="w-3.5 h-3.5" /> : item.name.charAt(0).toUpperCase()}
    </span>
  )
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
          className="flex flex-col pb-8"
          data-testid={`import-group-${group.id}`}
        >
          <h4 className={SETTINGS_GROUP_LABEL}>{t(`import.v2.groups.${group.id}`)}</h4>
          <ul className="flex flex-col border-t border-border">
            {group.items.map((item) => (
              <li key={item.id} className="border-b border-border">
                <button
                  type="button"
                  onClick={() => setActive(item)}
                  data-testid={`import-source-${item.id}`}
                  className="group flex w-full items-center gap-3 min-h-13 py-2.5 text-start focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm"
                >
                  <ImportSourceIcon item={item} />
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
