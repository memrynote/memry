/**
 * The first-import preview (#1413, Paper "#1414 First-import preview / B
 * (tiles)"): what the library holds per category, a switch on each tile, the
 * root folder and the layout. Nothing is written until the dialog's Import
 * button runs the engine. The counts come from the importer's `preview`.
 */

import { useEffect, useMemo, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import {
  READWISE_CATEGORIES,
  READWISE_PREVIEW_COUNT_KEYS,
  type ImportPreview,
  type ReadwiseCategory,
  type ReadwiseOptions,
  type ReadwiseSetOptionsInput
} from '@memry/contracts/import-channels'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { ACCENT_SWITCH, SETTINGS_GROUP_LABEL } from '@/components/settings/settings-primitives'
import { ReadwiseLocationSection } from '@/components/settings/readwise-location-section'
import { formatImportMessage } from '@/lib/import-message'
import { extractErrorMessage } from '@/lib/ipc-error'

export interface FirstImportState {
  /** The counts are in, so Import can run. */
  ready: boolean
  /** Notes the first run will write: the enabled categories' books and the saved Reader documents. */
  willImport: number
  /** Saved Reader documents among them. */
  documents: number
}

interface Counts {
  books: number
  highlights: number
  documents: number
}

type Loaded =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; counts: Map<string, Counts> }

function toCounts(preview: ImportPreview): Map<string, Counts> {
  const counts = new Map<string, Counts>()
  for (const group of preview.groups) {
    const value = (key: string): number => group.counts.find((c) => c.labelKey === key)?.value ?? 0
    counts.set(group.label, {
      books: value(READWISE_PREVIEW_COUNT_KEYS.books),
      highlights: value(READWISE_PREVIEW_COUNT_KEYS.highlights),
      documents: value(READWISE_PREVIEW_COUNT_KEYS.documents)
    })
  }
  return counts
}

interface ReadwiseFirstImportPreviewProps {
  options: ReadwiseOptions
  disabled: boolean
  onSetOptions: (input: ReadwiseSetOptionsInput) => void
  onStateChange: (state: FirstImportState) => void
}

export function ReadwiseFirstImportPreview({
  options,
  disabled,
  onSetOptions,
  onStateChange
}: ReadwiseFirstImportPreviewProps) {
  const { t, i18n } = useT('settings')
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const importId = crypto.randomUUID()
    let active = true
    setLoaded({ status: 'loading' })
    window.api.import
      .preview({ importId, importerId: 'readwise', sourcePaths: [] })
      .then((res) => {
        if (!active) return
        if (!res.success) {
          setLoaded({ status: 'error', message: res.error ?? t('import.dialog.previewError') })
          return
        }
        const failed = res.preview.groups.find((group) => group.error)
        setLoaded(
          failed?.error
            ? { status: 'error', message: formatImportMessage(failed.error) }
            : { status: 'ready', counts: toCounts(res.preview) }
        )
      })
      .catch((err) => {
        if (active) {
          setLoaded({
            status: 'error',
            message: extractErrorMessage(err, t('import.dialog.previewError'))
          })
        }
      })
    return () => {
      active = false
      void window.api.import.cancel({ importId })
    }
  }, [attempt, t, options.readerDocuments])

  const counts = loaded.status === 'ready' ? loaded.counts : null
  const summary = useMemo(() => {
    let books = 0
    let highlights = 0
    let willImport = 0
    const off: ReadwiseCategory[] = []
    for (const [category, value] of counts ?? []) {
      if (category === 'reader') continue
      books += value.books
      highlights += value.highlights
      const enabled = category === 'other' || options.categories[category as ReadwiseCategory]
      if (enabled) willImport += value.books
      else if (value.books > 0) off.push(category as ReadwiseCategory)
    }
    const documents = options.readerDocuments ? (counts?.get('reader')?.documents ?? 0) : 0
    return { books, highlights, willImport: willImport + documents, documents, off }
  }, [counts, options.categories, options.readerDocuments])

  const ready = loaded.status === 'ready'
  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled)
        onStateChange({ ready, willImport: summary.willImport, documents: summary.documents })
    })
    return () => {
      cancelled = true
    }
  }, [ready, summary.willImport, summary.documents, onStateChange])

  if (loaded.status === 'loading') {
    return (
      <div className="flex items-center gap-2 text-[13px]/4 text-foreground">
        <Spinner />
        <span>{t('import.status.readwise.fetching')}</span>
      </div>
    )
  }

  if (loaded.status === 'error') {
    return (
      <div className="flex flex-col items-start gap-2">
        <p role="alert" className="text-xs/4 text-destructive">
          {loaded.message}
        </p>
        <Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
          {t('import.dialog.readwise.preview.retry')}
        </Button>
      </div>
    )
  }

  const categoryLabel = (category: string): string =>
    t(`import.dialog.readwise.categories.${category}.label`)
  const offNames = new Intl.ListFormat(i18n.language, {
    style: 'long',
    type: 'conjunction'
  }).format(summary.off.map(categoryLabel))
  const other = loaded.counts.get('other')

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <p className="text-xs/5 text-muted-foreground">
        {summary.books === 0
          ? summary.documents > 0
            ? t('import.dialog.readwise.preview.introReaderOnly', { documents: summary.documents })
            : t('import.dialog.readwise.preview.empty')
          : summary.off.length > 0
            ? t('import.dialog.readwise.preview.introOff', {
                highlights: summary.highlights,
                books: summary.books,
                off: offNames,
                willImport: summary.willImport - summary.documents
              })
            : t('import.dialog.readwise.preview.intro', {
                highlights: summary.highlights,
                books: summary.books
              })}
      </p>

      <section className="flex flex-col">
        <h4 className={SETTINGS_GROUP_LABEL}>{t('import.dialog.readwise.groups.categories')}</h4>
        <ul className="grid grid-cols-2 gap-2">
          {READWISE_CATEGORIES.map((category) => {
            const enabled = options.categories[category]
            const label = categoryLabel(category)
            return (
              <li
                key={category}
                className="flex min-w-0 flex-col gap-1 rounded-xl border border-border bg-card p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-xs/4 text-foreground">{label}</span>
                  <Switch
                    checked={enabled}
                    onCheckedChange={(next) => onSetOptions({ categories: { [category]: next } })}
                    aria-label={label}
                    className={ACCENT_SWITCH}
                    disabled={disabled}
                  />
                </div>
                <span className="text-xl/6 font-semibold tabular-nums text-foreground">
                  {loaded.counts.get(category)?.books ?? 0}
                </span>
                <span className="text-xs/4 text-muted-foreground">
                  {enabled
                    ? t('import.dialog.readwise.preview.willImport')
                    : t('import.dialog.readwise.preview.off')}
                </span>
              </li>
            )
          })}
          <li className="col-span-2 flex min-w-0 flex-col gap-1 rounded-xl border border-border bg-card p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-xs/4 text-foreground">
                {t('import.dialog.readwise.preview.readerLabel')}
              </span>
              <Switch
                checked={options.readerDocuments}
                onCheckedChange={(next) => onSetOptions({ readerDocuments: next })}
                aria-label={t('import.dialog.readwise.reader.documents.label')}
                className={ACCENT_SWITCH}
                disabled={disabled}
              />
            </div>
            {options.readerDocuments ? (
              <>
                <span className="text-xl/6 font-semibold tabular-nums text-foreground">
                  {summary.documents}
                </span>
                <span className="text-xs/4 text-muted-foreground">
                  {t('import.dialog.readwise.preview.willImport')}
                </span>
              </>
            ) : (
              <span className="text-xs/4 text-muted-foreground">
                {t('import.dialog.readwise.reader.documents.description')}
              </span>
            )}
          </li>
          {other && (
            <li className="flex min-w-0 flex-col gap-1 rounded-xl border border-border bg-card p-3">
              <span className="truncate text-xs/4 text-foreground">
                {t('import.dialog.readwise.categories.other.label')}
              </span>
              <span className="text-xl/6 font-semibold tabular-nums text-foreground">
                {other.books}
              </span>
              <span className="text-xs/4 text-muted-foreground">
                {t('import.dialog.readwise.preview.willImport')}
              </span>
            </li>
          )}
          <li className="col-span-2 flex min-w-0 flex-col gap-1 rounded-xl border border-border bg-card p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-xs/4 text-foreground">
                {t('import.dialog.readwise.journal.highlights.label')}
              </span>
              <Switch
                checked={options.journalHighlights}
                onCheckedChange={(next) => onSetOptions({ journalHighlights: next })}
                aria-label={t('import.dialog.readwise.journal.highlights.label')}
                className={ACCENT_SWITCH}
                disabled={disabled}
              />
            </div>
            <span className="text-xs/4 text-muted-foreground">
              {t('import.dialog.readwise.journal.highlights.description')}
            </span>
            <span className="text-xs/4 text-muted-foreground">
              {t('import.dialog.readwise.journal.highlights.firstImport')}
            </span>
          </li>
        </ul>
      </section>

      <ReadwiseLocationSection options={options} disabled={disabled} onChange={onSetOptions} />
    </div>
  )
}
