/**
 * Resolves the entities referenced by visible canvas cards into a live
 * title/status/dangling map.
 *
 * Fetch-on-visible with a small cache (C2): only the entities whose cards are
 * currently on screen are loaded, and each is loaded once. Live one-way IPC
 * events keep the cached state fresh — a note/task edited in its own tab
 * updates its card here with no polling. `get(id) === null` (or an archived
 * task/event) is the dangling signal.
 */

import { useEffect, useMemo, useReducer, useRef } from 'react'
import { notesService, onNoteUpdated, onNoteDeleted, onNoteRenamed } from '@/services/notes-service'
import {
  tasksService,
  onTaskUpdated,
  onTaskDeleted,
  onTaskCompleted
} from '@/services/tasks-service'
import { calendarService, onCalendarChanged } from '@/services/calendar-service'
import { createLogger } from '@/lib/logger'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import { entityKey, type CanvasCardRef } from './canvas-cards'
import type { CanvasEntityType } from '@memry/contracts/canvas-api'

const log = createLogger('SpatialCanvas')

export type CanvasEntityState =
  | { status: 'loading' }
  | { status: 'dangling' }
  | { status: 'ready'; kind: 'note'; title: string; emoji: string | null; body: string }
  | { status: 'ready'; kind: 'task'; title: string; completed: boolean; dueDate: string | null }
  | {
      status: 'ready'
      kind: 'calendar_event'
      title: string
      startAt: string
      endAt: string | null
      isAllDay: boolean
    }

export { entityKey }

type EntityMap = ReadonlyMap<string, CanvasEntityState>

type Action =
  | { type: 'set'; key: string; state: CanvasEntityState }
  | { type: 'prune'; keep: ReadonlySet<string> }

function reducer(state: EntityMap, action: Action): EntityMap {
  switch (action.type) {
    case 'set': {
      const existing = state.get(action.key)
      if (existing && shallowEqual(existing, action.state)) {
        return state
      }
      const next = new Map(state)
      next.set(action.key, action.state)
      return next
    }
    case 'prune': {
      let changed = false
      const next = new Map(state)
      for (const key of state.keys()) {
        if (!action.keep.has(key)) {
          next.delete(key)
          changed = true
        }
      }
      return changed ? next : state
    }
  }
}

function shallowEqual(a: CanvasEntityState, b: CanvasEntityState): boolean {
  const ak = Object.keys(a) as (keyof CanvasEntityState)[]
  const bk = Object.keys(b)
  if (ak.length !== bk.length) {
    return false
  }
  return ak.every(
    (key) => (a as Record<string, unknown>)[key] === (b as Record<string, unknown>)[key]
  )
}

async function loadEntity(
  entityType: CanvasEntityType,
  entityId: string
): Promise<CanvasEntityState> {
  if (entityType === 'note') {
    const note = await notesService.get(entityId)
    if (!note) {
      return { status: 'dangling' }
    }
    return {
      status: 'ready',
      kind: 'note',
      title: note.title,
      emoji: note.emoji ?? null,
      body: note.content
    }
  }
  if (entityType === 'task') {
    const task = await tasksService.get(entityId)
    if (!task || task.archivedAt) {
      return { status: 'dangling' }
    }
    return {
      status: 'ready',
      kind: 'task',
      title: task.title,
      completed: task.completedAt !== null,
      dueDate: task.dueDate
    }
  }
  const event = await calendarService.getEvent(entityId)
  if (!event || event.archivedAt) {
    return { status: 'dangling' }
  }
  return {
    status: 'ready',
    kind: 'calendar_event',
    title: event.title,
    startAt: event.startAt,
    endAt: event.endAt,
    isAllDay: event.isAllDay
  }
}

export function useCanvasEntities(visibleRefs: readonly CanvasCardRef[]): EntityMap {
  const [entities, dispatch] = useReducer(
    reducer,
    undefined,
    () => new Map<string, CanvasEntityState>()
  )

  // Distinct (type, id) pairs currently visible, and a stable signature for the
  // effect. The effect keys off the signature only (not the map identity) so a
  // `loading` dispatch re-render doesn't re-run it and cancel in-flight loads.
  const wanted = useMemo(() => {
    const map = new Map<string, { entityType: CanvasEntityType; entityId: string }>()
    for (const ref of visibleRefs) {
      map.set(entityKey(ref.entityType, ref.entityId), {
        entityType: ref.entityType,
        entityId: ref.entityId
      })
    }
    return map
  }, [visibleRefs])
  const wantedSignature = useMemo(() => Array.from(wanted.keys()).sort().join('|'), [wanted])
  const wantedRef = useRef(wanted)
  // Declared before the load effect so it runs first and the load effect reads
  // the fresh map (effects fire in declaration order).
  useEffect(() => {
    wantedRef.current = wanted
  }, [wanted])

  // Everything currently loaded/loading, so events can target only live cards.
  const loadedRef = useRef<Set<string>>(new Set())
  // Cancellation is per-hook, not per-effect: an effect re-run for a changed
  // visible set must not cancel a still-wanted load (dispatch is gated on the
  // key still being in loadedRef, which prune removes).
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    const current = wantedRef.current
    const keep = new Set(current.keys())
    dispatch({ type: 'prune', keep })
    for (const key of loadedRef.current) {
      if (!keep.has(key)) {
        loadedRef.current.delete(key)
      }
    }

    for (const [key, ref] of current) {
      if (loadedRef.current.has(key)) {
        continue
      }
      loadedRef.current.add(key)
      dispatch({ type: 'set', key, state: { status: 'loading' } })
      void loadEntity(ref.entityType, ref.entityId)
        .then((state) => {
          if (mountedRef.current && loadedRef.current.has(key)) {
            dispatch({ type: 'set', key, state })
          }
        })
        .catch((err: unknown) => {
          if (mountedRef.current && loadedRef.current.has(key)) {
            log.error('Failed to load canvas card entity', err)
            dispatch({ type: 'set', key, state: { status: 'dangling' } })
          }
        })
    }
  }, [wantedSignature])

  // Live updates. Refetch (or apply payload) only for entities we hold.
  useEffect(() => {
    const has = (key: string): boolean => loadedRef.current.has(key)
    const refresh = (entityType: CanvasEntityType, entityId: string): void => {
      const key = entityKey(entityType, entityId)
      if (!has(key)) {
        return
      }
      void loadEntity(entityType, entityId)
        .then((state) => dispatch({ type: 'set', key, state }))
        .catch((err: unknown) => {
          log.error('Failed to refresh canvas card entity', err)
          trackRendererError('canvas_card_refresh', err)
          dispatch({ type: 'set', key, state: { status: 'dangling' } })
        })
    }

    const unsubscribes = [
      onNoteUpdated((event) => refresh('note', event.id)),
      onNoteRenamed((event) => refresh('note', event.id)),
      onNoteDeleted((event) => {
        const key = entityKey('note', event.id)
        if (has(key)) dispatch({ type: 'set', key, state: { status: 'dangling' } })
      }),
      onTaskUpdated((event) => refresh('task', event.id)),
      onTaskCompleted((event) => refresh('task', event.id)),
      onTaskDeleted((event) => {
        const key = entityKey('task', event.id)
        if (has(key)) dispatch({ type: 'set', key, state: { status: 'dangling' } })
      }),
      onCalendarChanged((event) => {
        if (event.entityType === 'calendar_event') {
          refresh('calendar_event', event.id)
        }
      })
    ]
    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe())
    }
  }, [])

  return entities
}
