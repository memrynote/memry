import { useState, useEffect, useCallback } from 'react'
import {
  tasksService,
  onTaskUpdated,
  onTaskDeleted,
  onTaskCompleted,
  type Task
} from '@/services/tasks-service'

interface UseTaskBlockDataResult {
  task: Task | null
  isLoading: boolean
  isDeleted: boolean
}

export function useTaskBlockData(taskId: string): UseTaskBlockDataResult {
  const [task, setTask] = useState<Task | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isDeleted, setIsDeleted] = useState(false)

  const loadTask = useCallback(async (id: string): Promise<void> => {
    setIsLoading(true)
    try {
      const result = await tasksService.get(id)
      if (result) {
        setTask(result)
        setIsDeleted(false)
      } else {
        setIsDeleted(true)
      }
    } catch {
      setIsDeleted(true)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!taskId) return
    loadTask(taskId)
  }, [taskId, loadTask])

  useEffect(() => {
    if (!taskId) return

    const unsubUpdated = onTaskUpdated((event) => {
      if (event.id === taskId) {
        setTask(event.task)
      }
    })

    const unsubCompleted = onTaskCompleted((event) => {
      if (event.id === taskId) {
        setTask(event.task)
      }
    })

    const unsubDeleted = onTaskDeleted((event) => {
      if (event.id === taskId) {
        setIsDeleted(true)
        setTask(null)
      }
    })

    return () => {
      unsubUpdated()
      unsubCompleted()
      unsubDeleted()
    }
  }, [taskId])

  return { task, isLoading, isDeleted }
}
