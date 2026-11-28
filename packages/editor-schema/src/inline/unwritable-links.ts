import { maskHardBreaks } from '@memry/shared/hard-breaks'
import { maskCodeAcrossLines } from './code-mask'
import { bracketPartners, FENCE_OPENER, parenPartners } from './empty-links'
import { keptWhole, linkDestination } from './link-destinations'

/**
 * A link or an image whose address no markdown writes back as itself, kept as
 * the text it was.
 *
 * The parse ends an address at its first blank, a newline included, so
 * `[b](x(y\nz) w)` is a link to `x(y`, and `![i](x(y z) w)` an image of it. No
 * markdown spells an address with an open parenthesis and reads it back as
 * itself: the writer escapes the parenthesis, `[b](x\(y)`, and the parser keeps
 * the backslash, so each save changed the address; an image's address went
 * unescaped and the next read found no image. Nor does one spell an address
 * with a line break: `[b](<x\ny>)` is the link to `x\ny`, and the writer cuts
 * it at the break. A blank in an address with its parentheses closed is
 * another matter: it is kept whole, as written (`link-destinations.ts`).
 *
 * Such a link stays text, with its `[` and `]` escaped so the parse reads no
 * link there. The core's seed reads the same text
 * (`crates/memry-core/src/crdt/markdown_seed/links.rs`).
 */

const OPENS_ADDRESS = /\]\(/

/**
 * Whether no markdown spells `address` and reads it back as itself: one with a
 * line break in it (an angled one keeps it, and the writer cannot) or one that
 * leaves a parenthesis open, as `hrefParenTokens` counts them.
 */
function isUnwritable(address: string): boolean {
  if (address.includes('\n')) return true
  let depth = 0
  for (let at = 0; at < address.length; at++) {
    if (address[at] === '\\') {
      if (++at === address.length) return true
    } else if (address[at] === '(') depth++
    else if (address[at] === ')' && --depth < 0) return true
  }
  return depth !== 0
}

/** `markdown` with the brackets of each such link and image outside code escaped. */
export function escapeUnwritableLinks(markdown: string): string {
  if (!OPENS_ADDRESS.test(markdown) || !/\s/.test(markdown)) return markdown
  const code = maskCodeAcrossLines(markdown)
  const partners = parenPartners(markdown)
  const { opens } = bracketPartners(markdown)
  /** Past a link's label: its address, or an image's alt and address, is read as written. */
  const asWritten = new Uint8Array(markdown.length)
  const escapes: number[] = []
  let bang = false
  let lineEnd = -1
  let fenceEnd = -1
  for (let at = 0; at < markdown.length; at++) {
    const ch = markdown[at]
    if (ch === '\\') {
      at++
      bang = false
      continue
    }
    if (ch === '!') {
      bang = true
      continue
    }
    const image = bang
    bang = false
    if (ch !== '[' || code[at] !== '[' || asWritten[at] === 1) continue
    const labelEnd = opens.get(at)
    if (labelEnd === undefined || markdown[labelEnd + 1] !== '(') continue
    const close = partners.get(labelEnd + 1)
    if (close === undefined) continue
    if (lineEnd < at) {
      const found = markdown.indexOf('\n', at)
      lineEnd = found < 0 ? markdown.length : found
      FENCE_OPENER.lastIndex = markdown.lastIndexOf('\n', at - 1) + 1
      fenceEnd = FENCE_OPENER.test(markdown) ? FENCE_OPENER.lastIndex : -1
    }
    // A fence's info string holds no link, whatever its structure.
    if (fenceEnd >= 0 && at >= fenceEnd) continue
    // A hard break is a token by the time the parse ends the address, not a line break.
    const raw = markdown.slice(labelEnd + 2, close)
    if (!image && keptWhole(raw)) {
      asWritten.fill(1, labelEnd + 1, close + 1)
    } else if (isUnwritable(linkDestination(maskHardBreaks(raw).markdown))) {
      // Both brackets, so the pair stays neutral to an enclosing label's `]`.
      escapes.push(at, labelEnd)
    } else {
      asWritten.fill(1, image ? at : labelEnd + 1, close + 1)
    }
  }
  if (escapes.length === 0) return markdown
  escapes.sort((a, b) => a - b)
  let out = ''
  let last = 0
  for (const at of escapes) {
    out += `${markdown.slice(last, at)}\\`
    last = at
  }
  return out + markdown.slice(last)
}
