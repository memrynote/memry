import { useCallback, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { HomePage, WidgetInstance } from '@memry/contracts/home-page-api'
import { trackTelemetry } from '@/lib/telemetry'

const ACTIVE_KEY = 'memry-home-active-board'
const homeBoardsKey = ['home-boards'] as const

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

  const [activeBoardId, setActiveBoardIdState] = useState<string | null>(() =>
    localStorage.getItem(ACTIVE_KEY)
  )

  const setActiveBoardId = useCallback((id: string) => {
    localStorage.setItem(ACTIVE_KEY, id)
    setActiveBoardIdState(id)
  }, [])

  const invalidate = () => qc.invalidateQueries({ queryKey: homeBoardsKey })

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
    setActiveBoardId,
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
