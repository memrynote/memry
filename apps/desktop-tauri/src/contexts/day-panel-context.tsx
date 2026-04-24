import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
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
  openForDayView: (date: string) => void
  closeForDayView: () => void
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
  const autoModeRef = useRef(false)

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
    autoModeRef.current = false
    setIsOpen((prev) => !prev)
  }, [])

  const open = useCallback(() => {
    autoModeRef.current = false
    setIsOpen(true)
  }, [])

  const close = useCallback(() => {
    autoModeRef.current = false
    setIsOpen(false)
  }, [])

  const openForDayView = useCallback((date: string) => {
    setSelectedDate(date)
    setIsOpen((prev) => {
      if (prev) return prev
      autoModeRef.current = true
      return true
    })
  }, [])

  const closeForDayView = useCallback(() => {
    setIsOpen((prev) => {
      if (!prev) return prev
      if (!autoModeRef.current) return prev
      autoModeRef.current = false
      return false
    })
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
      openForDayView,
      closeForDayView,
      setDate,
      setWidth,
      setIsResizing
    }),
    [
      isOpen,
      selectedDate,
      width,
      isResizing,
      toggle,
      open,
      close,
      openForDayView,
      closeForDayView,
      setDate
    ]
  )

  return <DayPanelContext.Provider value={value}>{children}</DayPanelContext.Provider>
}

export default DayPanelProvider
