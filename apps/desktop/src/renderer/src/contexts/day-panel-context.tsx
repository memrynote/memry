import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from 'react'
import { getTodayString } from '@/lib/journal-utils'

export interface DayPanelContextValue {
  isOpen: boolean
  selectedDate: string
  toggle: () => void
  open: () => void
  close: () => void
  setDate: (date: string) => void
}

interface DayPanelProviderProps {
  children: ReactNode
  defaultOpen?: boolean
}

const DayPanelContext = createContext<DayPanelContextValue | null>(null)

export const useDayPanel = (): DayPanelContextValue => {
  const context = useContext(DayPanelContext)
  if (!context) {
    throw new Error('useDayPanel must be used within a DayPanelProvider')
  }
  return context
}

export const DayPanelProvider = ({
  children,
  defaultOpen = false
}: DayPanelProviderProps): React.JSX.Element => {
  const [isOpen, setIsOpen] = useState(defaultOpen)
  const [selectedDate, setSelectedDate] = useState(getTodayString)

  const toggle = useCallback(() => {
    setIsOpen((prev) => !prev)
  }, [])

  const open = useCallback(() => {
    setIsOpen(true)
  }, [])

  const close = useCallback(() => {
    setIsOpen(false)
  }, [])

  const setDate = useCallback((date: string) => {
    setSelectedDate(date)
  }, [])

  const value = useMemo<DayPanelContextValue>(
    () => ({
      isOpen,
      selectedDate,
      toggle,
      open,
      close,
      setDate
    }),
    [isOpen, selectedDate, toggle, open, close, setDate]
  )

  return <DayPanelContext.Provider value={value}>{children}</DayPanelContext.Provider>
}

export default DayPanelProvider
