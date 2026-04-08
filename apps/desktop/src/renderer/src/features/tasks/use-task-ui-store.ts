import { useCallback, useSyncExternalStore } from 'react'
import type { TaskSelectionType } from '@/App'

interface TaskUiStoreState {
  taskSelectedId: string
  taskSelectedType: TaskSelectionType
  selectedTaskIds: Set<string>
}

const listeners = new Set<() => void>()

let state: TaskUiStoreState = {
  taskSelectedId: 'all',
  taskSelectedType: 'view',
  selectedTaskIds: new Set()
}

function emitChange(): void {
  listeners.forEach((listener) => listener())
}

function updateState(nextState: TaskUiStoreState): void {
  state = nextState
  emitChange()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): TaskUiStoreState {
  return state
}

export function useTaskUiStore() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const setSelection = useCallback((id: string, type: TaskSelectionType) => {
    updateState({
      ...state,
      taskSelectedId: id,
      taskSelectedType: type
    })
  }, [])

  const setSelectedTaskIds = useCallback((ids: Set<string>) => {
    updateState({
      ...state,
      selectedTaskIds: ids
    })
  }, [])

  return {
    ...snapshot,
    setSelection,
    setSelectedTaskIds
  }
}
