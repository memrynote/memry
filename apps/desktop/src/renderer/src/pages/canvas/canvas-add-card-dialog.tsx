/**
 * The canvas "Add card" picker: search notes, files, tasks, events and
 * projects, or create a new note. Filtering is ours (shouldFilter={false})
 * because results arrive pre-filtered from several sources.
 *
 * "Add all from…" (#2484) is a drill-down inside the same palette; its steps
 * live in canvas-add-card-bulk.tsx.
 */

import React, { useEffect, useMemo, useState } from 'react'
import { Command } from 'cmdk'
import { Plus } from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'
import type { CanvasEntityRef, CanvasEntityType } from '@memry/contracts/canvas-api'
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
import {
  bulkPlaceholder,
  CanvasBulkAddEntry,
  CanvasBulkAddSteps,
  CanvasBulkBackButton,
  useBulkAddFlow
} from './canvas-add-card-bulk'

/** cmdk value for the pinned create row; never collides with an entityKey. */
const CREATE_VALUE = '__create_note__'

const ITEM_CLASS =
  'flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm data-[selected=true]:bg-muted'

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

  // Every way the picker closes goes through here, so the next opening starts
  // on a blank search instead of a stale query or bulk step.
  const handleOpenChange = (next: boolean): void => {
    if (!next) {
      setQuery('')
      flow.reset()
    }
    onOpenChange(next)
  }

  const flow = useBulkAddFlow({
    open,
    query,
    setQuery,
    onCanvasKeys,
    onPlace: (refs) => {
      onAddAll(refs)
      handleOpenChange(false)
    }
  })
  const { searching } = flow
  // The single-item search stays idle while a bulk step owns the input.
  const { results, files, events, projects, loading } = useCanvasAddSearch(
    open && searching,
    searching ? query : ''
  )

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

  // In a bulk step the first row takes the highlight, so Enter always acts on
  // something visible.
  //
  // In search, a blank query always highlights the create row — the hook
  // clears `events` in its own effect, so for one frame after the user clears
  // the input the groups can still hold a stale match, and without this guard
  // Enter would add that stale card instead of creating a note. For a
  // non-blank query the first match takes the highlight, so Enter picks an
  // existing item; the create row is one arrow-up away.
  useEffect(() => {
    if (!searching) {
      setValue(flow.firstValue)
      return
    }
    if (query.trim() === '') {
      setValue(CREATE_VALUE)
      return
    }
    const first = ADD_CARD_GROUP_ORDER.map((type) => groups[type][0]).find(Boolean)
    setValue(first ? entityKey(first.entityType, first.entityId) : CREATE_VALUE)
  }, [groups, query, searching, flow.firstValue])

  const select = (candidate: AddCardCandidate): void => {
    if (candidate.onCanvas) {
      onReveal(candidate.entityType, candidate.entityId)
    } else {
      onPick(candidate.entityType, candidate.entityId)
    }
    handleOpenChange(false)
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

  const renderSearch = (): React.JSX.Element => (
    <>
      <Command.Item
        value={CREATE_VALUE}
        data-testid="canvas-add-create-note"
        onSelect={() => {
          onCreateNote(query.trim())
          handleOpenChange(false)
        }}
        className={ITEM_CLASS}
      >
        <Plus className="size-3.5 shrink-0" aria-hidden="true" />
        {query.trim()
          ? t('canvas.card.addCreateNote', { query: query.trim() })
          : t('canvas.card.addCreateNoteEmpty')}
      </Command.Item>
      {!hasResults && query.trim() && !loading ? (
        <div
          data-testid="canvas-add-empty"
          className="px-2 py-6 text-center text-sm text-text-tertiary"
        >
          {t('canvas.card.addEmpty')}
        </div>
      ) : null}
      {ADD_CARD_GROUP_ORDER.map((type) => (
        <React.Fragment key={type}>{renderGroup(groupHeadings[type], groups[type])}</React.Fragment>
      ))}
      {query.trim() === '' ? <CanvasBulkAddEntry flow={flow} /> : null}
    </>
  )

  return (
    <Command.Dialog
      open={open}
      onOpenChange={handleOpenChange}
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
        <CanvasBulkBackButton flow={flow} />
        <Command.Input
          value={query}
          onValueChange={setQuery}
          onKeyDown={(event) => {
            if (event.key === 'Backspace' && query === '' && !searching) {
              event.preventDefault()
              flow.goBack()
            }
          }}
          data-testid="canvas-add-input"
          placeholder={searching ? t('canvas.card.addPlaceholder') : bulkPlaceholder(flow.step, t)}
          className="w-full bg-transparent px-3 py-3 text-sm outline-none"
        />
      </div>
      <Command.List className="max-h-80 overflow-y-auto p-2">
        {searching ? renderSearch() : <CanvasBulkAddSteps flow={flow} />}
      </Command.List>
    </Command.Dialog>
  )
}
