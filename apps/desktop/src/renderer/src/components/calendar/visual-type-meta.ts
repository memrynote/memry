import type { CalendarProjectionVisualType } from '@/services/calendar-service'

interface VisualTypeMeta {
  label: string
  swatchColor: string
  dotColor: string
  chipClassName: string
}

export const VISUAL_TYPE_META: Record<CalendarProjectionVisualType, VisualTypeMeta> = {
  event: {
    label: 'Event',
    swatchColor: '#FAF5FF',
    dotColor: '#9810FA',
    chipClassName:
      'bg-[#FAF5FF] text-[#9810FA] border border-[#E9D4FF] dark:bg-[#6A34C821] dark:text-[#C4B5FD] dark:border-[#A78BFA47]'
  },
  external_event: {
    label: 'Imported event',
    swatchColor: '#F0FDF4',
    dotColor: '#00A63E',
    chipClassName:
      'bg-[#F0FDF4] text-[#00A63E] border border-[#B9F8CF] dark:bg-[#4ADE801A] dark:text-[#86EFAC] dark:border-[#4ADE803D]'
  },
  task: {
    label: 'Task',
    swatchColor: '#EFF6FF',
    dotColor: '#155DFC',
    chipClassName:
      'bg-[#EFF6FF] text-[#155DFC] border border-[#BEDBFF] dark:bg-[#60A5FA1A] dark:text-[#93C5FD] dark:border-[#60A5FA38]'
  },
  reminder: {
    label: 'Reminder',
    swatchColor: '#FDF2F8',
    dotColor: '#EC4899',
    chipClassName:
      'bg-[#FDF2F8] text-[#FCCEE8] border border-[#FCCEE8] dark:bg-[#EF44441A] dark:text-[#FCA5A5] dark:border-[#EF44443D]'
  },
  snooze: {
    label: 'Snooze',
    swatchColor: '#FFF7ED',
    dotColor: '#F54900',
    chipClassName:
      'bg-[#FFF7ED] text-[#F54900] border border-[#FFD6A7] dark:bg-[#FB923C1A] dark:text-[#FDBA74] dark:border-[#FB923C3D]'
  }
}

export const VISUAL_TYPE_ORDER: CalendarProjectionVisualType[] = [
  'event',
  'external_event',
  'task',
  'reminder',
  'snooze'
]
