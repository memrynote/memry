import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  type ReactNode
} from 'react'
import { getTodayString } from '@/lib/journal-utils'

const DAY_PANEL_OPEN_KEY = 'day-panel-open'
const DAY_PANEL_WIDTH_KEY = 'day-panel-width'
export const DAY_PANEL_WIDTH_DEFAULT_PX = 320
export const DAY_PANEL_WIDTH_MIN_PX = 280
export const DAY_PANEL_WIDTH_MAX_PX = 600

export interface DayPanelContextValue {
  isOpen: boolean
  selectedDate: string
  width: number
  isResizing: boolean
  toggle: () => void
  open: () => void
  close: () => void
  setDate: (date: string) => void
  setWidth: React.Dispatch<React.SetStateAction<number>>
  setIsResizing: React.Dispatch<React.SetStateAction<boolean>>
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
  const [isOpen, setIsOpen] = useState(() => {
    try {
      const stored = localStorage.getItem(DAY_PANEL_OPEN_KEY)
      if (stored !== null) return stored === 'true'
    } catch {
      /* localStorage unavailable */
    }
    return defaultOpen
  })

  const [width, setWidth] = useState(() => {
    try {
      const stored = localStorage.getItem(DAY_PANEL_WIDTH_KEY)
      return stored ? Number(stored) : DAY_PANEL_WIDTH_DEFAULT_PX
    } catch {
      return DAY_PANEL_WIDTH_DEFAULT_PX
    }
  })

  const [isResizing, setIsResizing] = useState(false)
  const [selectedDate, setSelectedDate] = useState(getTodayString)

  useEffect(() => {
    try {
      localStorage.setItem(DAY_PANEL_OPEN_KEY, String(isOpen))
    } catch {
      /* localStorage unavailable */
    }
  }, [isOpen])

  useEffect(() => {
    if (!isResizing) {
      try {
        localStorage.setItem(DAY_PANEL_WIDTH_KEY, String(width))
      } catch {
        /* localStorage unavailable */
      }
    }
  }, [width, isResizing])

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
      width,
      isResizing,
      toggle,
      open,
      close,
      setDate,
      setWidth,
      setIsResizing
    }),
    [isOpen, selectedDate, width, isResizing, toggle, open, close, setDate]
  )

  return <DayPanelContext.Provider value={value}>{children}</DayPanelContext.Provider>
}

export default DayPanelProvider
