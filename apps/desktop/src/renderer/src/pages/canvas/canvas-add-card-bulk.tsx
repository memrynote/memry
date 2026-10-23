/**
 * "Add all from…" (#2484): the drill-down half of the canvas Add card picker.
 *
 * Pick a tag or folder, then (when it has filtering saved views) everything or
 * one view, then — above BULK_ADD_CONFIRM_THRESHOLD new cards — confirm.
 * Backspace on an empty input steps back. The dialog owns the input and the
 * cmdk root; this module owns the step machine and what each step lists.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Command } from 'cmdk'
import { toast } from 'sonner'
import { ArrowLeft, Filter, Folder, Plus, Tag } from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'
import type { CanvasEntityRef } from '@memry/contracts/canvas-api'
import type { ViewScope } from '@memry/contracts/folder-view-api'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import { BULK_ADD_CONFIRM_THRESHOLD, splitNewRefs } from './canvas-bulk-add'
import {
  listBulkFolders,
  listBulkTags,
  loadBulkScopeOptions,
  type BulkScopeOption
} from './canvas-bulk-sources'

const log = createLogger('SpatialCanvas')

/** cmdk values for the bulk rows. The `__` prefix keeps them off every entityKey. */
const BULK_TAG_VALUE = '__bulk_tag__'
const BULK_FOLDER_VALUE = '__bulk_folder__'
const BULK_CONFIRM_VALUE = '__bulk_confirm__'
const BULK_BACK_VALUE = '__bulk_back__'

const ITEM_CLASS =
  'flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm data-[selected=true]:bg-muted'
const HINT_CLASS = 'ms-auto shrink-0 text-xs tabular-nums text-text-tertiary'
const NOTE_CLASS = 'px-2 py-6 text-center text-sm text-text-tertiary'
const ROW_ICON_CLASS = 'size-3.5 shrink-0 text-text-tertiary'

type BulkSource = 'tag' | 'folder'

/** Where the picker is. `search` is the ordinary single-item picker. */
export type BulkStep =
  | { kind: 'search' }
  | { kind: 'pick'; source: BulkSource }
  | { kind: 'loading'; source: BulkSource; label: string }
  | { kind: 'views'; source: BulkSource; label: string; options: BulkScopeOption[] }
  | {
      kind: 'confirm'
      label: string
      refs: CanvasEntityRef[]
      fresh: number
      skipped: number
      previous: BulkStep
    }

type PickStep = Extract<BulkStep, { kind: 'pick' }>
type ViewsStep = Extract<BulkStep, { kind: 'views' }>
type ConfirmStep = Extract<BulkStep, { kind: 'confirm' }>

const SEARCH_STEP: BulkStep = { kind: 'search' }
const NO_ITEMS: PickItem[] = []

interface PickItem {
  key: string
  label: string
  count: number | null
}

async function loadPickItems(source: BulkSource): Promise<PickItem[]> {
  if (source === 'tag') {
    const tags = await listBulkTags()
    return tags.map((tag) => ({ key: tag.name, label: `#${tag.name}`, count: tag.count }))
  }
  const paths = await listBulkFolders()
  return paths.map((path) => ({ key: path, label: path, count: null }))
}

/**
 * The tag or folder list for the pick step, loaded each time the step opens.
 *
 * The loaded list is stored with the source it belongs to, so switching source
 * reads as "loading" during render instead of an effect first clearing the
 * previous list.
 */
function useBulkPickItems(source: BulkSource | null): { items: PickItem[]; loading: boolean } {
  const [loaded, setLoaded] = useState<{ source: BulkSource; items: PickItem[] } | null>(null)

  useEffect(() => {
    if (!source) return
    let cancelled = false
    void loadPickItems(source)
      .catch((err: unknown) => {
        log.error('Canvas bulk add: source list failed', { source, error: err })
        return []
      })
      .then((items) => {
        if (!cancelled) setLoaded({ source, items })
      })
    return () => {
      cancelled = true
      setLoaded(null)
    }
  }, [source])

  const current = loaded !== null && loaded.source === source ? loaded.items : null
  return { items: current ?? NO_ITEMS, loading: source !== null && current === null }
}

/** The cmdk value to highlight on entering a bulk step: its first row. */
function firstStepValue(step: BulkStep, pickMatches: readonly PickItem[]): string {
  if (step.kind === 'pick') return pickMatches[0] ? `${step.source}:${pickMatches[0].key}` : ''
  if (step.kind === 'views') return 'view:0'
  if (step.kind === 'confirm') return BULK_CONFIRM_VALUE
  return ''
}

export interface BulkAddFlow {
  step: BulkStep
  searching: boolean
  pickMatches: PickItem[]
  pickLoading: boolean
  /** The row to highlight on a bulk step ('' on search). */
  firstValue: string
  start: (source: BulkSource) => void
  goBack: () => void
  /** Back to search, dropping any load in flight. Call when the dialog closes. */
  reset: () => void
  pickScope: (source: BulkSource, item: PickItem) => void
  /** Hands a committed batch to the dialog, which places it and closes. */
  place: (refs: CanvasEntityRef[]) => void
  proceed: (label: string, refs: CanvasEntityRef[], from: BulkStep) => void
}

/**
 * The step machine. `query` / `setQuery` are the dialog's input, which every
 * step filters or ignores and every step change clears. `onPlace` receives a
 * batch the user has committed to; the dialog places it and closes.
 */
export function useBulkAddFlow({
  open,
  query,
  setQuery,
  onCanvasKeys,
  onPlace
}: {
  open: boolean
  query: string
  setQuery: (query: string) => void
  onCanvasKeys: ReadonlySet<string>
  onPlace: (refs: CanvasEntityRef[]) => void
}): BulkAddFlow {
  const { t } = useT('common')
  const [step, setStep] = useState<BulkStep>(SEARCH_STEP)
  const pick = useBulkPickItems(open && step.kind === 'pick' ? step.source : null)
  /** Bumped per scope load; a load that resolves after the user moved on is dropped. */
  const loadTokenRef = useRef(0)

  const needle = query.trim().toLowerCase()
  const pickMatches = useMemo(
    () => pick.items.filter((item) => item.label.toLowerCase().includes(needle)),
    [pick.items, needle]
  )

  const goTo = (next: BulkStep): void => {
    setQuery('')
    setStep(next)
  }

  const goBack = (): void => {
    loadTokenRef.current += 1
    if (step.kind === 'pick') goTo(SEARCH_STEP)
    else if (step.kind === 'loading' || step.kind === 'views') {
      goTo({ kind: 'pick', source: step.source })
    } else if (step.kind === 'confirm') goTo(step.previous)
  }

  /**
   * Places a batch, or asks first when it is large. The threshold counts only
   * the cards that would be NEW: re-adding a tag whose notes are already on
   * the board is not a big change, whatever the tag's size.
   */
  const proceed = (label: string, refs: CanvasEntityRef[], from: BulkStep): void => {
    if (refs.length === 0) {
      toast(t('canvas.card.bulkEmpty'))
      goTo(from)
      return
    }
    const { fresh, skipped } = splitNewRefs(refs, onCanvasKeys)
    if (fresh.length > BULK_ADD_CONFIRM_THRESHOLD) {
      goTo({ kind: 'confirm', label, refs, fresh: fresh.length, skipped, previous: from })
      return
    }
    onPlace(refs)
  }

  const pickScope = (source: BulkSource, item: PickItem): void => {
    const scope: ViewScope =
      source === 'tag' ? { kind: 'tag', tag: item.key } : { kind: 'folder', path: item.key }
    const token = ++loadTokenRef.current
    const from: BulkStep = { kind: 'pick', source }
    goTo({ kind: 'loading', source, label: item.label })
    loadBulkScopeOptions(scope).then(
      (options) => {
        if (token !== loadTokenRef.current) return
        if (options.length === 1) {
          proceed(item.label, options[0].refs, from)
          return
        }
        goTo({ kind: 'views', source, label: item.label, options })
      },
      (err: unknown) => {
        if (token !== loadTokenRef.current) return
        log.error('Canvas bulk add: scope load failed', { source, error: err })
        toast.error(extractErrorMessage(err, t('canvas.card.bulkLoadFailed')))
        goTo(from)
      }
    )
  }

  return {
    step,
    searching: step.kind === 'search',
    pickMatches,
    pickLoading: pick.loading,
    firstValue: firstStepValue(step, pickMatches),
    start: (source) => goTo({ kind: 'pick', source }),
    goBack,
    reset: () => {
      loadTokenRef.current += 1
      setStep(SEARCH_STEP)
    },
    pickScope,
    place: onPlace,
    proceed
  }
}

/** The input placeholder for a bulk step. */
export function bulkPlaceholder(step: BulkStep, t: (key: string) => string): string {
  if (step.kind === 'search') return ''
  if (step.kind !== 'pick') return step.label
  return step.source === 'tag'
    ? t('canvas.card.bulkSearchTags')
    : t('canvas.card.bulkSearchFolders')
}

/** The "Add all from" entry rows shown under a blank search. */
export function CanvasBulkAddEntry({ flow }: { flow: BulkAddFlow }): React.JSX.Element {
  const { t } = useT('common')
  return (
    <Command.Group heading={t('canvas.card.bulkGroup')}>
      <Command.Item
        value={BULK_TAG_VALUE}
        data-testid="canvas-add-bulk-tag"
        onSelect={() => flow.start('tag')}
        className={ITEM_CLASS}
      >
        <Tag className="size-3.5 shrink-0" aria-hidden="true" />
        {t('canvas.card.bulkFromTag')}
      </Command.Item>
      <Command.Item
        value={BULK_FOLDER_VALUE}
        data-testid="canvas-add-bulk-folder"
        onSelect={() => flow.start('folder')}
        className={ITEM_CLASS}
      >
        <Folder className="size-3.5 shrink-0" aria-hidden="true" />
        {t('canvas.card.bulkFromFolder')}
      </Command.Item>
    </Command.Group>
  )
}

function BulkPickList({ step, flow }: { step: PickStep; flow: BulkAddFlow }): React.JSX.Element {
  const { t } = useT('common')
  if (flow.pickMatches.length === 0) {
    return (
      <div data-testid="canvas-add-bulk-empty" className={NOTE_CLASS}>
        {flow.pickLoading ? t('canvas.card.loading') : t('canvas.card.addEmpty')}
      </div>
    )
  }
  const Icon = step.source === 'tag' ? Tag : Folder
  const heading =
    step.source === 'tag' ? t('canvas.card.bulkTagsHeading') : t('canvas.card.bulkFoldersHeading')
  return (
    <Command.Group heading={heading}>
      {flow.pickMatches.map((item) => (
        <Command.Item
          key={item.key}
          value={`${step.source}:${item.key}`}
          data-testid={`canvas-add-bulk-${step.source}-${item.key}`}
          onSelect={() => flow.pickScope(step.source, item)}
          className={ITEM_CLASS}
        >
          <Icon className={ROW_ICON_CLASS} aria-hidden="true" />
          <span className="truncate">{item.label}</span>
          {item.count !== null ? (
            <span className={HINT_CLASS}>
              {t('canvas.card.bulkItemCount', { count: item.count })}
            </span>
          ) : null}
        </Command.Item>
      ))}
    </Command.Group>
  )
}

function BulkViewList({ step, flow }: { step: ViewsStep; flow: BulkAddFlow }): React.JSX.Element {
  const { t } = useT('common')
  return (
    <Command.Group heading={t('canvas.card.bulkViewsHeading', { name: step.label })}>
      {step.options.map((option, index) => (
        <Command.Item
          key={option.viewName ?? ''}
          value={`view:${index}`}
          data-testid={`canvas-add-bulk-view-${index}`}
          onSelect={() => flow.proceed(step.label, option.refs, step)}
          className={ITEM_CLASS}
        >
          {option.viewName === null ? (
            <Plus className={ROW_ICON_CLASS} aria-hidden="true" />
          ) : (
            <Filter className={ROW_ICON_CLASS} aria-hidden="true" />
          )}
          <span className="truncate">{option.viewName ?? t('canvas.card.bulkAllItems')}</span>
          <span className={HINT_CLASS}>
            {t('canvas.card.bulkItemCount', { count: option.refs.length })}
          </span>
        </Command.Item>
      ))}
    </Command.Group>
  )
}

function BulkConfirm({ step, flow }: { step: ConfirmStep; flow: BulkAddFlow }): React.JSX.Element {
  const { t } = useT('common')
  return (
    <div data-testid="canvas-add-bulk-confirm">
      <div className="px-2 pb-3 pt-2 text-sm">
        <p className="font-medium text-foreground">
          {t('canvas.card.bulkConfirmTitle', { count: step.fresh, name: step.label })}
        </p>
        <p className="mt-1 text-text-secondary">{t('canvas.card.bulkConfirmBody')}</p>
        {step.skipped > 0 ? (
          <p className="mt-1 text-text-tertiary">
            {t('canvas.card.bulkConfirmSkipped', { count: step.skipped })}
          </p>
        ) : null}
      </div>
      <Command.Item
        value={BULK_CONFIRM_VALUE}
        data-testid="canvas-add-bulk-confirm-add"
        onSelect={() => flow.place(step.refs)}
        className={ITEM_CLASS}
      >
        <Plus className="size-3.5 shrink-0" aria-hidden="true" />
        {t('canvas.card.bulkConfirmAdd', { count: step.fresh })}
      </Command.Item>
      <Command.Item
        value={BULK_BACK_VALUE}
        data-testid="canvas-add-bulk-confirm-back"
        onSelect={flow.goBack}
        className={ITEM_CLASS}
      >
        <ArrowLeft className="size-3.5 shrink-0 rtl:-scale-x-100" aria-hidden="true" />
        {t('canvas.card.bulkBack')}
      </Command.Item>
    </div>
  )
}

/** The list body of whichever bulk step the picker is on. */
export function CanvasBulkAddSteps({ flow }: { flow: BulkAddFlow }): React.JSX.Element | null {
  const { t } = useT('common')
  const { step } = flow
  switch (step.kind) {
    case 'pick':
      return <BulkPickList step={step} flow={flow} />
    case 'loading':
      return (
        <div data-testid="canvas-add-bulk-loading" className={NOTE_CLASS}>
          {t('canvas.card.loading')}
        </div>
      )
    case 'views':
      return <BulkViewList step={step} flow={flow} />
    case 'confirm':
      return <BulkConfirm step={step} flow={flow} />
    default:
      return null
  }
}

/** The back arrow beside the input on every bulk step. */
export function CanvasBulkBackButton({ flow }: { flow: BulkAddFlow }): React.JSX.Element | null {
  const { t } = useT('common')
  if (flow.searching) return null
  return (
    <button
      type="button"
      onClick={flow.goBack}
      data-testid="canvas-add-bulk-back"
      aria-label={t('canvas.card.bulkBack')}
      className="ms-2 flex size-6 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-muted hover:text-foreground"
    >
      <ArrowLeft className="size-3.5 rtl:-scale-x-100" aria-hidden="true" />
    </button>
  )
}
