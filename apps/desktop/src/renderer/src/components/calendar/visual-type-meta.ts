import type { CalendarProjectionVisualType } from '@/services/calendar-service'

interface VisualTypeMeta {
  label: string
  swatchColor: string
  chipClassName: string
}

export const VISUAL_TYPE_META: Record<CalendarProjectionVisualType, VisualTypeMeta> = {
  event: {
    label: 'Event',
    swatchColor: '#FAF5FF',
    chipClassName: 'bg-[#FAF5FF] text-[#9810FA] border border-[#314446]'
  },
  external_event: {
    label: 'Imported event',
    swatchColor: '#17412E',
    chipClassName: 'bg-[#17412E] text-white/90 border border-[#17412E]'
  },
  task: {
    label: 'Task',
    swatchColor: '#0C354B',
    chipClassName: 'bg-[#0C354B] text-white/90 border border-[#0C354B]'
  },
  reminder: {
    label: 'Reminder',
    swatchColor: '#B9F8CF',
    chipClassName: 'bg-[#B9F8CF] text-green-900 border border-green-900'
  },
  snooze: {
    label: 'Snooze',
    swatchColor: '#FFF7ED',
    chipClassName: 'bg-[#FFF7ED] text-orange-900 border border-orange-900'
  }
}

export const VISUAL_TYPE_ORDER: CalendarProjectionVisualType[] = [
  'event',
  'external_event',
  'task',
  'reminder',
  'snooze'
]
