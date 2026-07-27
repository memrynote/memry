/**
 * Shared URL detection for the capture surfaces (inbox quick capture and the
 * project hub's capture input). Lives here so the two cannot drift apart —
 * a string one surface treats as a link must be a link in the other too.
 */

const URL_REGEX =
  /^(https?:\/\/|www\.)[^\s]+$|^[^\s]+\.(com|org|net|io|co|dev|app|me|info|biz|edu|gov)[^\s]*$/i

/** Whether the whole value is a URL. Multi-line input is prose that happens to contain one. */
export function isLikelyUrl(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.includes('\n')) return false
  return URL_REGEX.test(trimmed)
}

/** Add a scheme when the user typed a bare domain. */
export function normalizeUrl(text: string): string {
  const trimmed = text.trim()
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed
  if (trimmed.startsWith('www.')) return `https://${trimmed}`
  return `https://${trimmed}`
}

export type CaptureIntent = 'url' | 'text'

/** What the hub's capture input should do with a submitted value. */
export function classifyCapture(text: string): CaptureIntent {
  return isLikelyUrl(text) ? 'url' : 'text'
}
