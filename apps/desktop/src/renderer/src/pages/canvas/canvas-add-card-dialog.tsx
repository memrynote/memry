/**
 * The canvas "Add card" picker: search notes, tasks and events, or create a
 * new note. Filtering is ours (shouldFilter={false}) because results arrive
 * pre-filtered from two different sources.
 */

import React, { useEffect, useMemo, useState } from 'react'
import { Command } from 'cmdk'
import { Plus } from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'
import type { CanvasEntityType } from '@memry/contracts/canvas-api'
import {
  candidatesFromEvents,
  candidatesFromSearch,
  groupCandidates,
  markOnCanvas,
  type AddCardCandidate
} from './canvas-add-card'
import { CanvasAddCardRow } from './canvas-add-card-row'
import { entityKey } from './canvas-cards'
import { useCanvasAddSearch } from './use-canvas-add-search'

/** cmdk value for the pinned create row; never collides with an entityKey. */
const CREATE_VALUE = '__create_note__'

export interface CanvasAddCardDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** `entityType:entityId` keys already carded on this canvas. */
  onCanvasKeys: ReadonlySet<string>
  onCreateNote: (title: string) => void
  onPick: (entityType: CanvasEntityType, entityId: string) => void
  onReveal: (entityType: CanvasEntityType, entityId: string) => void
}

export function CanvasAddCardDialog({
  open,
  onOpenChange,
  onCanvasKeys,
  onCreateNote,
  onPick,
  onReveal
}: CanvasAddCardDialogProps): React.JSX.Element {
  const { t } = useT('common')
  const [query, setQuery] = useState('')
  const [value, setValue] = useState(CREATE_VALUE)
  const { results, events, loading } = useCanvasAddSearch(open, query)

  // Reset between openings so a stale query never greets the next open.
  useEffect(() => {
    if (!open) {
      setQuery('')
    }
  }, [open])

  const groups = useMemo(() => {
    const merged = [...candidatesFromSearch(results), ...candidatesFromEvents(events)]
    return groupCandidates(markOnCanvas(merged, onCanvasKeys))
  }, [results, events, onCanvasKeys])

  // A blank query always highlights the create row — the hook clears `events`
  // in its own effect, so for one frame after the user clears the input the
  // groups can still hold a stale match, and without this guard Enter would
  // add that stale card instead of creating a note. For a non-blank query the
  // first match takes the highlight, so Enter picks an existing item; the
  // create row is one arrow-up away.
  useEffect(() => {
    if (query.trim() === '') {
      setValue(CREATE_VALUE)
      return
    }
    const first = groups.note[0] ?? groups.task[0] ?? groups.calendar_event[0]
    setValue(first ? entityKey(first.entityType, first.entityId) : CREATE_VALUE)
  }, [groups, query])

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

  const hasResults =
    groups.note.length > 0 || groups.task.length > 0 || groups.calendar_event.length > 0

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
      <Command.Input
        value={query}
        onValueChange={setQuery}
        data-testid="canvas-add-input"
        placeholder={t('canvas.card.addPlaceholder')}
        className="w-full border-b border-border bg-transparent px-3 py-3 text-sm outline-none"
      />
      <Command.List className="max-h-80 overflow-y-auto p-2">
        <Command.Item
          value={CREATE_VALUE}
          data-testid="canvas-add-create-note"
          onSelect={() => {
            onCreateNote(query.trim())
            onOpenChange(false)
          }}
          className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm data-[selected=true]:bg-muted"
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
        {renderGroup(t('canvas.card.addGroupNotes'), groups.note)}
        {renderGroup(t('canvas.card.addGroupTasks'), groups.task)}
        {renderGroup(t('canvas.card.addGroupEvents'), groups.calendar_event)}
      </Command.List>
    </Command.Dialog>
  )
}
