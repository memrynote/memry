/**
 * Durable token for inline date mentions. The renderer pill serializes its
 * props to `((date:<base64url-json>))` so the date survives the markdown
 * round-trip as a single text node, and the main process derives reminder
 * rows by parsing the same token out of the note's raw markdown. This module
 * is the single source of truth for the format — imported by both sides.
 */

export type DateMentionLead = 'at' | '5m' | '1h' | '1d'

export interface DateMentionData {
  anchorId: string
  dateISO: string
  hasTime: boolean
  remind: boolean
  lead: DateMentionLead
}

export const DATE_MENTION_TOKEN_REGEX = /\(\(date:([A-Za-z0-9_-]+)\)\)/g

const LEAD_MS: Record<DateMentionLead, number> = {
  at: 0,
  '5m': 5 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000
}

function toBase64Url(s: string): string {
  // btoa/atob exist in both renderer (browser) and Electron main (Node 20+).
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(s: string): string {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/')
  return atob(padded)
}

export function serializeDateMentionToken(data: DateMentionData): string {
  return `((date:${toBase64Url(JSON.stringify(data))}))`
}

export function parseDateMentionToken(encoded: string): DateMentionData | null {
  try {
    const obj = JSON.parse(fromBase64Url(encoded)) as Partial<DateMentionData>
    if (
      typeof obj.anchorId !== 'string' ||
      typeof obj.dateISO !== 'string' ||
      typeof obj.hasTime !== 'boolean' ||
      typeof obj.remind !== 'boolean' ||
      (obj.lead !== 'at' && obj.lead !== '5m' && obj.lead !== '1h' && obj.lead !== '1d')
    ) {
      return null
    }
    return obj as DateMentionData
  } catch {
    return null
  }
}

export function computeRemindAt(dateISO: string, lead: DateMentionLead): string {
  return new Date(Date.parse(dateISO) - LEAD_MS[lead]).toISOString()
}
