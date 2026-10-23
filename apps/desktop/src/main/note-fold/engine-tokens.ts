import {
  DATE_MENTION_TOKEN_REGEX,
  parseDateMentionToken,
  salvageDateMentionToken
} from '@memry/shared/date-mention'

/**
 * Memry stores a date pill as `((date:<base64>))` and a link mention as
 * `((mention:<url>))`. Neither is prose: left in, the base64 reaches the
 * folded view and the model. They are rewritten to the text a reader sees
 * before anything else reads the note, so hashes, sentences and Markdown all
 * agree. A token that cannot be decoded is dropped, never shown raw.
 */
const MENTION_TOKEN = /\(\(mention:([^()\n\r]+)\)\)/g

function formatDate(dateISO: string, hasTime: boolean, language: string): string | null {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateISO)
  const date = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(dateISO)
  if (Number.isNaN(date.getTime())) return null
  try {
    return new Intl.DateTimeFormat(language, {
      dateStyle: 'long',
      ...(hasTime && !dateOnly ? { timeStyle: 'short' as const } : {})
    }).format(date)
  } catch {
    // An unknown language tag: fall back to the runtime default locale.
    return date.toLocaleDateString()
  }
}

function mentionLabel(encoded: string): string {
  try {
    return new URL(decodeURIComponent(encoded.trim())).hostname
  } catch {
    return ''
  }
}

/** The note with every `((date:…))` and `((mention:…))` token replaced by its visible text. */
export function expandInlineTokens(markdown: string, language: string): string {
  return markdown
    .replace(DATE_MENTION_TOKEN_REGEX, (_token, payload: string) => {
      const data = parseDateMentionToken(payload) ?? salvageDateMentionToken(payload)
      return data ? (formatDate(data.dateISO, data.hasTime, language) ?? '') : ''
    })
    .replace(MENTION_TOKEN, (_token, payload: string) => mentionLabel(payload))
}

/** The note with tokens blanked, so their payload never skews language detection. */
export function withoutInlineTokens(markdown: string): string {
  return markdown.replace(DATE_MENTION_TOKEN_REGEX, ' ').replace(MENTION_TOKEN, ' ')
}
