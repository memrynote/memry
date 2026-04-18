export interface CalendarEventDraft {
  title: string
  description: string
  location: string
  isAllDay: boolean
  startAt: string
  endAt: string
  /** M2: Google calendar this event should be pushed to. Null = fall through to default. */
  targetCalendarId: string | null
}

export interface AnchorRect {
  x: number
  y: number
  width: number
  height: number
}
