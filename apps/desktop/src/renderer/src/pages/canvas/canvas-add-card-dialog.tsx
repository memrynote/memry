/**
 * The canvas "Add card" picker: search notes, files, tasks, events and
 * projects, or create a new note. Filtering is ours (shouldFilter={false})
 * because results arrive pre-filtered from several sources.
 *
 * "Add all from…" (#2484) is a short drill-down inside the same palette:
 * pick a tag or folder, then (when it has filtering saved views) everything or
 * one view, then — above BULK_ADD_CONFIRM_THRESHOLD new cards — confirm.
 * Backspace on an empty input steps back.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Command } from 'cmdk'
import { toast } from 'sonner'
import { ArrowLeft, Filter, Folder, Plus, Tag } from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'
import type { CanvasEntityRef, CanvasEntityType } from '@memry/contracts/canvas-api'
import type { ViewScope } from '@memry/contracts/folder-view-api'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import {
  ADD_CARD_GROUP_ORDER,
  candidatesFromEvents,
  candidatesFromProjects,
  candidatesFromSearch,
  groupCandidates,
  markOnCanvas,
  type AddCardCandidate
} from './canvas-add-card'
import { CanvasAddCardRow } from './canvas-add-card-row'
import { entityKey } from './canvas-cards'
import { useCanvasAddSearch } from './use-canvas-add-search'
import { BULK_ADD_CONFIRM_THRESHOLD, splitNewRefs } from './canvas-bulk-add'
import {
  listBulkFolders,
  listBulkTags,
  loadBulkScopeOptions,
  type BulkScopeOption
} from './canvas-bulk-sources'

const log = createLogger('SpatialCanvas')

/** cmdk value for the pinned create row; never collides with an entityKey. */
const CREATE_VALUE = '__create_note__'
/** cmdk values for the bulk rows. The `__` prefix keeps them off every entityKey. */
const BULK_TAG_VALUE = '__bulk_tag__'
const BULK_FOLDER_VALUE = '__bulk_folder__'
const BULK_CONFIRM_VALUE = '__bulk_confirm__'
const BULK_BACK_VALUE = '__bulk_back__'

type BulkSource = 'tag' | 'folder'

/** Where the picker is. `search` is the ordinary single-item picker. */
type Step =
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
      previous: Step
    }

const SEARCH_STEP: Step = { kind: 'search' }

interface PickItem {
  key: string
  label: string
  count: number | null
}

/** The tag or folder list for the pick step, loaded each time the step opens. */
function useBulkPickItems(source: BulkSource | null): { items: PickItem[]; loading: boolean } {
  const [items, setItems] = useState<PickItem[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!source) return
    let cancelled = false
    setItems([])
    setLoading(true)
    const load: Promise<PickItem[]> =
      source === 'tag'
        ? listBulkTags().then((tags) =>
            tags.map((tag) => ({ key: tag.name, label: `#${tag.name}`, count: tag.count }))
          )
        : listBulkFolders().then((paths) =>
            paths.map((path) => ({ key: path, label: path, count: null }))
          )
    load.then(
      (next) => {
        if (cancelled) return
        setItems(next)
        setLoading(false)
      },
      (err) => {
        if (cancelled) return
        log.error('Canvas bulk add: source list failed', { source, error: err })
        setItems([])
        setLoading(false)
      }
    )
    return () => {
      cancelled = true
    }
  }, [source])

  return { items, loading }
}

export interface CanvasAddCardDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** `entityType:entityId` keys already carded on this canvas. */
  onCanvasKeys: ReadonlySet<string>
  onCreateNote: (title: string) => void
  onPick: (entityType: CanvasEntityType, entityId: string) => void
  onReveal: (entityType: CanvasEntityType, entityId: string) => void
  /** Places a batch. The caller skips entities already on the board. */
  onAddAll: (refs: CanvasEntityRef[]) => void
}

export function CanvasAddCardDialog({
  open,
  onOpenChange,
  onCanvasKeys,
  onCreateNote,
  onPick,
  onReveal,
  onAddAll
}: CanvasAddCardDialogProps): React.JSX.Element {
  const { t } = useT('common')
  const [query, setQuery] = useState('')
  const [value, setValue] = useState(CREATE_VALUE)
  const [step, setStep] = useState<Step>(SEARCH_STEP)
  const searching = step.kind === 'search'
  // The single-item search stays idle while a bulk step owns the input.
  const { results, files, events, projects, loading } = useCanvasAddSearch(
    open && searching,
    searching ? query : ''
  )
  const pick = useBulkPickItems(open && step.kind === 'pick' ? step.source : null)
  /** Bumped per scope load; a load that resolves after the user moved on is dropped. */
  const loadTokenRef = useRef(0)

  // Reset between openings so a stale query or step never greets the next open.
  useEffect(() => {
    if (!open) {
      setQuery('')
      setStep(SEARCH_STEP)
      loadTokenRef.current += 1
    }
  }, [open])

  const groups = useMemo(() => {
    const merged = [
      ...candidatesFromSearch([...results, ...files]),
      ...candidatesFromEvents(events),
      ...candidatesFromProjects(projects, query)
    ]
    return groupCandidates(markOnCanvas(merged, onCanvasKeys))
  }, [results, files, events, projects, query, onCanvasKeys])

  const groupHeadings: Record<CanvasEntityType, string> = {
    note: t('canvas.card.addGroupNotes'),
    file: t('canvas.link.groupFiles'),
    task: t('canvas.card.addGroupTasks'),
    calendar_event: t('canvas.card.addGroupEvents'),
    project: t('canvas.link.groupProjects')
  }

  const needle = query.trim().toLowerCase()
  const pickMatches = useMemo(
    () => pick.items.filter((item) => item.label.toLowerCase().includes(needle)),
    [pick.items, needle]
  )

  // In a bulk step the first row takes the highlight, so Enter always acts on
  // something visible.
  //
  // In search, a blank query always highlights the create row — the hook
  // clears `events` in its own effect, so for one frame after the user clears
  // the input the groups can still hold a stale match, and without this guard
  // Enter would add that stale card instead of creating a note. For a
  // non-blank query the first match takes the highlight, so Enter picks an
  // existing item; the create row is one arrow-up away.
  const firstBulkValue =
    step.kind === 'pick'
      ? pickMatches[0]
        ? `${step.source}:${pickMatches[0].key}`
        : ''
      : step.kind === 'views'
        ? 'view:0'
        : step.kind === 'confirm'
          ? BULK_CONFIRM_VALUE
          : ''

  useEffect(() => {
    if (step.kind !== 'search') {
      setValue(firstBulkValue)
      return
    }
    if (query.trim() === '') {
      setValue(CREATE_VALUE)
      return
    }
    const first = ADD_CARD_GROUP_ORDER.map((type) => groups[type][0]).find(Boolean)
    setValue(first ? entityKey(first.entityType, first.entityId) : CREATE_VALUE)
  }, [groups, query, step.kind, firstBulkValue])

  const goTo = (next: Step): void => {
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
  const proceed = (label: string, refs: CanvasEntityRef[], from: Step): void => {
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
    onAddAll(refs)
    onOpenChange(false)
  }

  const pickScope = (source: BulkSource, item: PickItem): void => {
    const scope: ViewScope =
      source === 'tag' ? { kind: 'tag', tag: item.key } : { kind: 'folder', path: item.key }
    const token = ++loadTokenRef.current
    const from: Step = { kind: 'pick', source }
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
      (err) => {
        if (token !== loadTokenRef.current) return
        log.error('Canvas bulk add: scope load failed', { source, error: err })
        toast.error(extractErrorMessage(err, t('canvas.card.bulkLoadFailed')))
        goTo(from)
      }
    )
  }

  const select = (candidate: AddCardCandidate): void => {
    if (candidate.onCanvas) {
      onReveal(candidate.entityType, candidate.entityId)
    } else {
      onPick(candidate.entityType, candidate.entityId)
    }
    onOpenChange(false)
  }

  const renderGroup = (heading: string, items: AddCardCandidate[]): React.JSX.Element | null => {
    if (items.length === 0) {
      return null
    }
    return (
      <Command.Group heading={heading}>
        {items.map((candidate) => {
          const key = entityKey(candidate.entityType, candidate.entityId)
          return (
            <Command.Item
              key={key}
              value={key}
              data-testid={`canvas-add-item-${key}`}
              onSelect={() => select(candidate)}
              className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-2 text-sm data-[selected=true]:bg-muted"
            >
              <CanvasAddCardRow
                candidate={candidate}
                createdLabel={(date) => t('canvas.card.addCreatedAt', { date })}
                allDayLabel={t('canvas.card.allDay')}
                onCanvasLabel={t('canvas.card.addOnCanvas')}
              />
            </Command.Item>
          )
        })}
      </Command.Group>
    )
  }

  const hasResults = ADD_CARD_GROUP_ORDER.some((type) => groups[type].length > 0)

  const itemClass =
    'flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm data-[selected=true]:bg-muted'
  const hintClass = 'ms-auto shrink-0 text-xs tabular-nums text-text-tertiary'
  const noteClass = 'px-2 py-6 text-center text-sm text-text-tertiary'

  const placeholder =
    step.kind === 'search'
      ? t('canvas.card.addPlaceholder')
      : step.kind === 'pick'
        ? step.source === 'tag'
          ? t('canvas.card.bulkSearchTags')
          : t('canvas.card.bulkSearchFolders')
        : step.label

  const renderSearch = (): React.JSX.Element => (
    <>
      <Command.Item
        value={CREATE_VALUE}
        data-testid="canvas-add-create-note"
        onSelect={() => {
          onCreateNote(query.trim())
          onOpenChange(false)
        }}
        className={itemClass}
      >
        <Plus className="size-3.5 shrink-0" aria-hidden="true" />
        {query.trim()
          ? t('canvas.card.addCreateNote', { query: query.trim() })
          : t('canvas.card.addCreateNoteEmpty')}
      </Command.Item>
      {!hasResults && query.trim() && !loading ? (
        <div data-testid="canvas-add-empty" className={noteClass}>
          {t('canvas.card.addEmpty')}
        </div>
      ) : null}
      {ADD_CARD_GROUP_ORDER.map((type) => (
        <React.Fragment key={type}>{renderGroup(groupHeadings[type], groups[type])}</React.Fragment>
      ))}
      {query.trim() === '' ? (
        <Command.Group heading={t('canvas.card.bulkGroup')}>
          <Command.Item
            value={BULK_TAG_VALUE}
            data-testid="canvas-add-bulk-tag"
            onSelect={() => goTo({ kind: 'pick', source: 'tag' })}
            className={itemClass}
          >
            <Tag className="size-3.5 shrink-0" aria-hidden="true" />
            {t('canvas.card.bulkFromTag')}
          </Command.Item>
          <Command.Item
            value={BULK_FOLDER_VALUE}
            data-testid="canvas-add-bulk-folder"
            onSelect={() => goTo({ kind: 'pick', source: 'folder' })}
            className={itemClass}
          >
            <Folder className="size-3.5 shrink-0" aria-hidden="true" />
            {t('canvas.card.bulkFromFolder')}
          </Command.Item>
        </Command.Group>
      ) : null}
    </>
  )

  const renderBulk = (): React.JSX.Element | null => {
    if (step.kind === 'pick') {
      const Icon = step.source === 'tag' ? Tag : Folder
      if (pickMatches.length === 0) {
        return (
          <div data-testid="canvas-add-bulk-empty" className={noteClass}>
            {pick.loading ? t('canvas.card.loading') : t('canvas.card.addEmpty')}
          </div>
        )
      }
      return (
        <Command.Group
          heading={
            step.source === 'tag'
              ? t('canvas.card.bulkTagsHeading')
              : t('canvas.card.bulkFoldersHeading')
          }
        >
          {pickMatches.map((item) => (
            <Command.Item
              key={item.key}
              value={`${step.source}:${item.key}`}
              data-testid={`canvas-add-bulk-${step.source}-${item.key}`}
              onSelect={() => pickScope(step.source, item)}
              className={itemClass}
            >
              <Icon className="size-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
              <span className="truncate">{item.label}</span>
              {item.count !== null ? (
                <span className={hintClass}>
                  {t('canvas.card.bulkItemCount', { count: item.count })}
                </span>
              ) : null}
            </Command.Item>
          ))}
        </Command.Group>
      )
    }
    if (step.kind === 'loading') {
      return (
        <div data-testid="canvas-add-bulk-loading" className={noteClass}>
          {t('canvas.card.loading')}
        </div>
      )
    }
    if (step.kind === 'views') {
      return (
        <Command.Group heading={t('canvas.card.bulkViewsHeading', { name: step.label })}>
          {step.options.map((option, index) => (
            <Command.Item
              key={option.viewName ?? ''}
              value={`view:${index}`}
              data-testid={`canvas-add-bulk-view-${index}`}
              onSelect={() => proceed(step.label, option.refs, step)}
              className={itemClass}
            >
              {option.viewName === null ? (
                <Plus className="size-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
              ) : (
                <Filter className="size-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
              )}
              <span className="truncate">{option.viewName ?? t('canvas.card.bulkAllItems')}</span>
              <span className={hintClass}>
                {t('canvas.card.bulkItemCount', { count: option.refs.length })}
              </span>
            </Command.Item>
          ))}
        </Command.Group>
      )
    }
    if (step.kind === 'confirm') {
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
            onSelect={() => {
              onAddAll(step.refs)
              onOpenChange(false)
            }}
            className={itemClass}
          >
            <Plus className="size-3.5 shrink-0" aria-hidden="true" />
            {t('canvas.card.bulkConfirmAdd', { count: step.fresh })}
          </Command.Item>
          <Command.Item
            value={BULK_BACK_VALUE}
            data-testid="canvas-add-bulk-confirm-back"
            onSelect={goBack}
            className={itemClass}
          >
            <ArrowLeft className="size-3.5 shrink-0 rtl:-scale-x-100" aria-hidden="true" />
            {t('canvas.card.bulkBack')}
          </Command.Item>
        </div>
      )
    }
    return null
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      shouldFilter={false}
      value={value}
      onValueChange={setValue}
      label={t('canvas.card.addCard')}
      // `className` lands on the cmdk root, not on the Radix parts — the scrim
      // has to go through `overlayClassName` to dim the canvas behind. Matches
      // the command palette's bg-black/50. See #872.
      overlayClassName="fixed inset-0 z-50 bg-black/50"
      className="fixed start-1/2 top-24 z-50 w-[32rem] max-w-[90vw] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-card shadow-lg rtl:translate-x-1/2"
    >
      <div className="flex items-center border-b border-border">
        {searching ? null : (
          <button
            type="button"
            onClick={goBack}
            data-testid="canvas-add-bulk-back"
            aria-label={t('canvas.card.bulkBack')}
            className="ms-2 flex size-6 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-muted hover:text-foreground"
          >
            <ArrowLeft className="size-3.5 rtl:-scale-x-100" aria-hidden="true" />
          </button>
        )}
        <Command.Input
          value={query}
          onValueChange={setQuery}
          onKeyDown={(event) => {
            if (event.key === 'Backspace' && query === '' && !searching) {
              event.preventDefault()
              goBack()
            }
          }}
          data-testid="canvas-add-input"
          placeholder={placeholder}
          className="w-full bg-transparent px-3 py-3 text-sm outline-none"
        />
      </div>
      <Command.List className="max-h-80 overflow-y-auto p-2">
        {searching ? renderSearch() : renderBulk()}
      </Command.List>
    </Command.Dialog>
  )
}
