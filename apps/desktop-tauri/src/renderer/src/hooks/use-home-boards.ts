import { useEffect, useSyncExternalStore } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { HomePage, WidgetInstance } from '@memry/contracts/home-page-api'
import { trackTelemetry } from '@/lib/telemetry'

const ACTIVE_KEY = 'memry-home-active-board'
const homeBoardsKey = ['home-boards'] as const

/**
 * The active board id is shared between hook instances, not private to one.
 *
 * `useHomeBoards` is mounted in more than one place — the Home page, and
 * `HomeTabTitleSync` above the tab tree — and `localStorage` on its own
 * notifies nobody: a write from one instance would leave every other one on the
 * value it read into `useState` at mount, so the tab title would never learn
 * which board the page switched to. A module-level store keeps them on one
 * value, and also keeps two Home panes in a split from drifting apart.
 *
 * `localStorage` stays the source of truth rather than a cached copy: the
 * snapshot is a string (stable for `useSyncExternalStore` by value), a session
 * written by an older build is read unchanged, and a test clearing storage
 * cannot be contradicted by module state that outlives it.
 */
const activeBoardListeners = new Set<() => void>()

const subscribeActiveBoardId = (listener: () => void): (() => void) => {
  activeBoardListeners.add(listener)
  return () => {
    activeBoardListeners.delete(listener)
  }
}

const getStoredActiveBoardId = (): string | null => localStorage.getItem(ACTIVE_KEY)

const setStoredActiveBoardId = (id: string): void => {
  localStorage.setItem(ACTIVE_KEY, id)
  for (const listener of activeBoardListeners) listener()
}

const trackBoardCustomized = (action: string, widgetCount?: number): void => {
  void trackTelemetry('home_board_customized', {
    surface: 'home',
    action,
    ...(widgetCount !== undefined ? { metrics: { itemCount: widgetCount } } : {})
  })
}

export function useHomeBoards() {
  const qc = useQueryClient()
  const { data: boards = [], isLoading } = useQuery({
    queryKey: homeBoardsKey,
    queryFn: () => window.api.homePages.list()
  })

  const activeBoardId = useSyncExternalStore(subscribeActiveBoardId, getStoredActiveBoardId)

  const invalidate = () => qc.invalidateQueries({ queryKey: homeBoardsKey })

  // Boards sync, so a peer's create/rename/drag/delete arrives as a main-process
  // event rather than a local mutation. Refetch on each of the three.
  useEffect(() => {
    const refetch = (): void => {
      void qc.invalidateQueries({ queryKey: homeBoardsKey })
    }
    const unsubscribers = [
      window.api.onHomePageCreated(refetch),
      window.api.onHomePageUpdated(refetch),
      window.api.onHomePageDeleted(refetch)
    ]
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe()
    }
  }, [qc])

  const createMut = useMutation({
    mutationFn: (name: string) =>
      window.api.homePages.create({ name, position: boards.length, widgets: [] }),
    onSuccess: () => {
      trackBoardCustomized('create')
      void invalidate()
    }
  })

  const updateMut = useMutation({
    mutationFn: (input: { id: string; name?: string; widgets?: WidgetInstance[] }) =>
      window.api.homePages.update(input),
    onSuccess: (_data, input) => {
      trackBoardCustomized(input.widgets ? 'widgets' : 'rename', input.widgets?.length)
      void invalidate()
    }
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => window.api.homePages.delete(id),
    onSuccess: () => {
      trackBoardCustomized('delete')
      void invalidate()
    }
  })

  const reorderMut = useMutation({
    mutationFn: (ids: string[]) => window.api.homePages.reorder(ids),
    onSuccess: () => {
      trackBoardCustomized('reorder')
      void invalidate()
    }
  })

  const resolvedActiveId =
    activeBoardId && boards.some((b) => b.id === activeBoardId)
      ? activeBoardId
      : (boards[0]?.id ?? null)

  const activeBoard = boards.find((b) => b.id === resolvedActiveId) ?? null

  return {
    boards,
    activeBoard,
    activeBoardId: resolvedActiveId,
    setActiveBoardId: setStoredActiveBoardId,
    isLoading,
    createBoard: (name: string): Promise<HomePage> => createMut.mutateAsync(name),
    renameBoard: (id: string, name: string): Promise<void> =>
      updateMut.mutateAsync({ id, name }).then(() => undefined),
    deleteBoard: (id: string): Promise<void> => deleteMut.mutateAsync(id).then(() => undefined),
    reorderBoards: (ids: string[]): Promise<void> =>
      reorderMut.mutateAsync(ids).then(() => undefined),
    updateWidgets: (boardId: string, widgets: WidgetInstance[]): Promise<void> =>
      updateMut.mutateAsync({ id: boardId, widgets }).then(() => undefined)
  }
}
