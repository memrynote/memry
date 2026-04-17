import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { toLocalDateString } from '@/components/calendar/date-utils'

export interface CalendarViewContextValue {
  anchorDate: string
  setAnchorDate: React.Dispatch<React.SetStateAction<string>>
}

interface CalendarViewProviderProps {
  children: ReactNode
}

const CalendarViewContext = createContext<CalendarViewContextValue | null>(null)

export const useCalendarView = (): CalendarViewContextValue => {
  const context = useContext(CalendarViewContext)
  if (!context) {
    throw new Error('useCalendarView must be used within a CalendarViewProvider')
  }
  return context
}

function getTodayAnchor(): string {
  return toLocalDateString(new Date())
}

export const CalendarViewProvider = ({
  children
}: CalendarViewProviderProps): React.JSX.Element => {
  const [anchorDate, setAnchorDate] = useState<string>(getTodayAnchor)

  const value = useMemo<CalendarViewContextValue>(
    () => ({ anchorDate, setAnchorDate }),
    [anchorDate]
  )

  return <CalendarViewContext.Provider value={value}>{children}</CalendarViewContext.Provider>
}

export default CalendarViewProvider
