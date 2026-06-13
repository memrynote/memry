import { useState, useEffect, useCallback } from 'react'
import { notesService } from '@/services/notes-service'
import { createLogger } from '@/lib/logger'

const log = createLogger('Hook:CalendarProperties')

export function useCalendarProperties() {
  const [names, setNames] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    void notesService
      .getCalendarPropertyNames()
      .then((list) => {
        if (!cancelled) setNames(new Set(list))
      })
      .catch((err) => log.error('Failed to load calendar property names', err))
    return () => {
      cancelled = true
    }
  }, [])

  const setEnabled = useCallback(async (name: string, show: boolean) => {
    setNames((prev) => {
      const next = new Set(prev)
      if (show) next.add(name)
      else next.delete(name)
      return next
    })
    try {
      await notesService.setCalendarPropertyVisibility(name, show)
    } catch (err) {
      log.error('Failed to set calendar property visibility', err)
      setNames((prev) => {
        const next = new Set(prev)
        if (show) next.delete(name)
        else next.add(name)
        return next
      })
    }
  }, [])

  const isEnabled = useCallback((name: string) => names.has(name), [names])

  return { isEnabled, setEnabled }
}
