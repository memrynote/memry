import type { InboxListInput } from '@memry/rpc/inbox'
import type { WidgetSize } from '@/lib/home/types'

// Types the inbox widget can filter by. Derived from the list query input so it stays in sync
// with what the backend accepts (this intentionally omits `video`, which the list query rejects).
export type InboxWidgetType = NonNullable<InboxListInput['type']>

export const INBOX_WIDGET_TYPES: InboxWidgetType[] = [
  'link',
  'note',
  'image',
  'voice',
  'clip',
  'pdf',
  'social',
  'reminder'
]

export type ResolvedInboxFilter = { kind: 'all' } | { kind: 'type'; type: InboxWidgetType }

const isInboxWidgetType = (value: string): value is InboxWidgetType =>
  (INBOX_WIDGET_TYPES as string[]).includes(value)

/** What the header pill reflects: a specific type when configured + valid, otherwise all types. */
export function resolveInboxFilter(config: Record<string, unknown>): ResolvedInboxFilter {
  const type = typeof config.type === 'string' ? config.type : null
  if (type && isInboxWidgetType(type)) {
    return { kind: 'type', type }
  }
  return { kind: 'all' }
}

/** How many items the widget body shows for a given size — shared by the body and the footer. */
export function inboxWidgetLimit(size: WidgetSize): number {
  return size === 'L' ? 12 : size === 'M' ? 6 : 3
}

export interface InboxFooterInput {
  total: number
  shown: number
  oldestDays: number
}

/** Footer numbers: items hidden beyond what's shown, plus the oldest item age. */
export function computeInboxFooter({ total, shown, oldestDays }: InboxFooterInput): {
  olderCount: number
  oldestDays: number
} {
  return { olderCount: Math.max(0, total - shown), oldestDays }
}
