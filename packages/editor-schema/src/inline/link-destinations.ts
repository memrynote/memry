import { createFenceTracker } from '@memry/shared/markdown-fences'

/**
 * A link destination that holds whitespace, kept whole as the link's `href`.
 *
 * BlockNote's link mark keeps only `href`, so the parser dropped a title and
 * the angle brackets around a spaced address: `[a](u "t")` wrote `[a](u)`, and
 * `[a](<u (y)>)` wrote `[a](u \(y\))`, then `[a](u)` (BBF-109). Whitespace
 * inside the destination is what marks both, so such a destination travels as
 * an inert placeholder and comes back as the link's `href`, byte for byte; the
 * writer spells it back as it is (`hrefParenTokens`). The core's markdown seed
 * keeps the same `href` (`crates/memry-core/src/crdt/markdown_seed/links.rs`).
 */

// Per process, so note text does not hold a placeholder (as in `emphasis-runs.ts`).
const PROCESS_WORD = String.fromCharCode(
  ...crypto.getRandomValues(new Uint8Array(12)).map((byte) => 65 + (byte % 26))
)
const placeholder = (index: number): string => `MEMRYLNK${PROCESS_WORD}${index}X`
const PLACEHOLDER = new RegExp(`MEMRYLNK${PROCESS_WORD}(\\d+)X`, 'g')

// BlockNote's `isAllowedUri` (link.ts). A destination its link mark refuses is
// left to the parser, which keeps only the link text.
const ALLOWED_URI =
  /^(?:(?:http|https|ftp|ftps|mailto|tel|callto|sms|cid|xmpp):|[^a-z]|[a-z0-9+.-]+(?:[^a-z+.\-:]|$))/i
const UNICODE_WHITESPACE = /[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g

/** BlockNote's `findClosingBracket` / `findClosingParen`. */
function closing(text: string, openAt: number, open: string, close: string): number {
  let depth = 0
  for (let at = openAt; at < text.length; at++) {
    if (text[at] === '\\' && at + 1 < text.length) {
      at++
      continue
    }
    if (text[at] === open) depth++
    if (text[at] === close && --depth === 0) return at
  }
  return -1
}

/** The address half of BlockNote's `parseDestinationAndTitle`. */
export function linkDestination(href: string): string {
  const raw = href.trim()
  if (raw.startsWith('<')) {
    const close = raw.indexOf('>')
    return close < 0 ? raw.slice(1) : raw.slice(1, close)
  }
  for (let at = 0; at < raw.length; at++) {
    if (raw[at] === '\\' && at + 1 < raw.length) at++
    else if (/[ \t\n]/.test(raw[at])) return raw.slice(0, at)
  }
  return raw
}

function keptWhole(raw: string): boolean {
  return (
    raw === raw.trim() &&
    /\s/.test(raw) &&
    !/[\n`]/.test(raw) &&
    [raw, linkDestination(raw)].every((uri) =>
      ALLOWED_URI.test(uri.replace(UNICODE_WHITESPACE, ''))
    )
  )
}

function maskSegment(text: string, destinations: string[]): string {
  let out = ''
  let last = 0
  for (let at = 0; at < text.length; at++) {
    if (text[at] === '\\') {
      at++
      continue
    }
    if (text[at] !== '[') continue
    const textEnd = closing(text, at, '[', ']')
    if (textEnd < 0 || text[textEnd + 1] !== '(') continue
    const parenEnd = closing(text, textEnd + 1, '(', ')')
    if (parenEnd < 0) continue
    const raw = text.slice(textEnd + 2, parenEnd)
    if (text[at - 1] !== '!' && keptWhole(raw)) {
      out += text.slice(last, textEnd + 2) + placeholder(destinations.push(raw) - 1)
      last = parenEnd
    }
    at = parenEnd
  }
  return out + text.slice(last)
}

export interface MaskedLinkDestinations {
  markdown: string
  /** The destinations, by placeholder index. Empty when none was masked. */
  destinations: string[]
}

/** Replace each spaced link destination outside a code fence with a placeholder. */
export function maskLinkDestinations(markdown: string): MaskedLinkDestinations {
  if (!markdown.includes('](')) return { markdown, destinations: [] }
  const destinations: string[] = []
  const fence = createFenceTracker()
  const out: string[] = []
  let prose: string[] = []
  const flush = (): void => {
    if (prose.length > 0) out.push(maskSegment(prose.join('\n'), destinations))
    prose = []
  }
  for (const line of markdown.split('\n')) {
    if (fence.consume(line)) {
      flush()
      out.push(line)
    } else prose.push(line)
  }
  flush()
  return destinations.length === 0
    ? { markdown, destinations: [] }
    : { markdown: out.join('\n'), destinations }
}

/** Put back the destinations `maskLinkDestinations` hid, in a run's text or a link's `href`. */
export function restoreLinkDestinations(text: string, destinations: string[]): string {
  if (destinations.length === 0 || !text.includes('MEMRYLNK')) return text
  return text.replace(PLACEHOLDER, (whole, index: string) => destinations[Number(index)] ?? whole)
}
