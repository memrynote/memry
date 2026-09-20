import { createFenceTracker } from '@memry/shared/markdown-fences'

/**
 * Memry's `((…))` inline tokens, hidden from the markdown parser.
 *
 * A token is opaque text that has to reach the other side byte-for-byte: the
 * whole point of `((mention:<encoded url>))` is that the URL survives the
 * round trip so the node can be rebuilt from it.
 *
 * BlockNote 0.51's markdown parser breaks that. It applies `_…_` emphasis
 * inside a word, which CommonMark explicitly forbids — an underscore flanked
 * by alphanumerics is not an emphasis delimiter — so a perfectly ordinary
 * Wikipedia URL came apart:
 *
 *   ((mention:…%2FRust_%28programming_language%29))
 *   → ((mention:…%2FRust*%28programming*language%29))
 *
 * The two underscores became one emphasis run and the serializer wrote it back
 * as asterisks. `%2F…Rust*%28programming*language%29` is not the URL the author
 * saved, the token no longer decodes to it, and the damage lands in the vault
 * file on the first write-back.
 *
 * So the tokens travel as inert placeholders and are put back once the blocks
 * exist. Same shape as the hard-break and `<details>` masks: replace before the
 * parse, restore after, and make the restore unconditional so a placeholder can
 * never reach the user's file.
 */

// `mention` and `date` are the two token kinds whose payload is opaque and
// may hold an underscore. Both stop at a literal paren, which is what keeps an
// unterminated `((mention:` from swallowing the next real token.
const INLINE_TOKEN_REGEX = /\(\((?:mention|date):[^()\n\r]*\)\)/g

const placeholder = (index: number): string => `MEMRYTKN${index}X`

/**
 * A backslash escape the markdown parser would have consumed.
 *
 * A `\` inside a token is always damage \u2014 both payloads are base64url or
 * percent-encoded, neither of which contains one \u2014 and letting the parser eat
 * it is how the round trip used to heal a token some older build escaped on
 * the way out. Masking the token would otherwise preserve the damage forever,
 * so the same healing is applied here. The class is CommonMark's: a backslash
 * only escapes ASCII punctuation.
 */
const STRAY_ESCAPE = /\\([!-/:-@[-`{-~])/g

export interface MaskedInlineTokens {
  markdown: string
  /** The masked tokens, by placeholder index. Empty when nothing was masked. */
  tokens: string[]
}

/**
 * Replace every `((mention:…))` / `((date:…))` outside a code fence with an
 * inert placeholder.
 *
 * Code fences are skipped: a token inside one is the author writing about the
 * syntax, and its bytes are already safe there.
 */
export function maskInlineTokens(markdown: string): MaskedInlineTokens {
  if (!markdown.includes('((')) return { markdown, tokens: [] }

  const tokens: string[] = []
  const fence = createFenceTracker()
  const masked = markdown
    .split('\n')
    .map((line) => {
      if (fence.consume(line)) return line
      return line.replace(INLINE_TOKEN_REGEX, (token) => {
        tokens.push(token.replace(STRAY_ESCAPE, '$1'))
        return placeholder(tokens.length - 1)
      })
    })
    .join('\n')

  return tokens.length === 0 ? { markdown, tokens: [] } : { markdown: masked, tokens }
}

/**
 * Put back the tokens `maskInlineTokens` hid, for one inline text run.
 *
 * A placeholder with no matching token is left as it is rather than deleted:
 * that can only happen if the text already contained something shaped like one,
 * in which case it is the author's own bytes.
 */
export function restoreInlineTokens(text: string, tokens: string[]): string {
  if (tokens.length === 0 || !text.includes('MEMRYTKN')) return text
  return text.replace(/MEMRYTKN(\d+)X/g, (whole, index: string) => tokens[Number(index)] ?? whole)
}
