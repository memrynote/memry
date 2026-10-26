/**
 * Seeded random documents for the `text` layer: strings built from the tokens
 * each scanner reads, so the line and character interplay (not just the
 * hand-picked shapes) is held against the TypeScript.
 */

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** `count` documents of `minTokens..maxTokens` tokens drawn from `alphabet`. */
export function fuzzDocs(
  alphabet: string[],
  seed: number,
  count: number,
  minTokens: number,
  maxTokens: number
): string[] {
  const random = mulberry32(seed)
  const docs: string[] = []
  for (let i = 0; i < count; i++) {
    const length = minTokens + Math.floor(random() * (maxTokens - minTokens + 1))
    let doc = ''
    for (let j = 0; j < length; j++) doc += alphabet[Math.floor(random() * alphabet.length)]
    docs.push(doc)
  }
  return docs
}

export const GENERAL_ALPHABET = [
  '\n',
  '\n',
  '\n\n',
  '\n\n\n',
  '\r\n',
  '\r',
  '\u2028',
  ' ',
  '  ',
  '\t',
  '\\',
  '\\\n',
  '`',
  '``',
  '```\n',
  '~~~\n',
  '<br>',
  '<br/>',
  '<!--',
  '-->',
  '%%',
  '[',
  ']',
  '](',
  '(',
  ')',
  '!',
  '[[',
  ']]',
  '|',
  '- ',
  '1. ',
  '> ',
  '# ',
  '((mention:',
  '((date:',
  '))',
  'x',
  'y',
  '\u65e5',
  '\u{1F600}',
  '"',
  '<a href="u">',
  '</a>',
  '<code>',
  '</code>',
  '    ',
  ':',
  '[a]: u',
  '*',
  '_',
  '~',
  '\u00a0'
]

export const BREAK_ALPHABET = [
  'a',
  'b',
  ' ',
  '  ',
  '\t',
  '\n',
  '\n',
  '\n\n',
  '\\',
  '\\\n',
  '<br>',
  '<br />',
  '<BR/>',
  '- ',
  '* ',
  '1. ',
  '> ',
  '# ',
  '[',
  ']',
  '](',
  '(',
  ')',
  '`',
  '<',
  '>',
  '![',
  '"',
  '\u00a0',
  '\r',
  '- [ ] ',
  '    ',
  'u',
  '<b>',
  '</b>',
  '```\n',
  '|'
]

export const COMMENT_ALPHABET = [
  '<!--',
  '-->',
  '%%',
  '\n',
  '\n',
  '\n\n',
  ' ',
  'x',
  '`',
  '``',
  '|',
  '- ',
  '> ',
  '1. ',
  '    ',
  '\t',
  '```\n',
  '~~~\n',
  '[[',
  ']]',
  '\\',
  '\r\n',
  '<!-- alt -->',
  '<!-- align:center -->',
  '<!-- link-card:{"size":"small"} -->\n',
  '[[Note]]',
  '**',
  '~~',
  '_',
  '[^1]: ',
  '\u65e5',
  '\u{1F600}'
]

export const REFERENCE_ALPHABET = [
  '[',
  ']',
  ']: ',
  '[a',
  '[b',
  '[^',
  '\\',
  ' ',
  '\t',
  '\n',
  '\n',
  '\n\n',
  '"t"',
  "'t'",
  '(t)',
  '<',
  '>',
  'u',
  'http://x',
  '!',
  '(',
  ')',
  '`',
  '```\n',
  '\r',
  'A',
  '\u65e5',
  '\u{1F600}',
  ': ',
  '  '
]

export const LINK_ALPHABET = [
  '[',
  ']',
  '(',
  ')',
  '](',
  '[a',
  '](u',
  ' ',
  '"t"',
  '\\',
  '!',
  '`',
  '``',
  '<',
  '>',
  '\n',
  'u',
  'v w',
  '```\n',
  '\u00a0',
  '\t',
  '[[',
  ']]',
  'http://x',
  'javascript:',
  'a1:',
  ':',
  '\u65e5',
  '\u{1F600}'
]

export const TABLE_ALPHABET = [
  '|',
  ' ',
  '  ',
  '-',
  ':',
  '\n',
  '\n',
  'a',
  'bb',
  '`',
  '``',
  'x y',
  '\t',
  '\\',
  '\\|',
  '[[',
  ']]',
  '|alias',
  '<br>',
  '<!-- c -->',
  '\\\n',
  '* ',
  '- ',
  '\u65e5\u672c',
  '\u{1F600}',
  '\r\n',
  '```\n',
  '\u00a0'
]

export const NESTING_ALPHABET = [
  '<!-- memry:block-nesting-level=1 -->\n',
  '<!-- memry:block-nesting-level=2 -->\n',
  '<!-- memry:block-nesting-level=0 -->\n',
  '<!--memry:block-nesting-level=3-->\n',
  'text\n',
  'x\n',
  '\n',
  '```\n',
  '~~~\n',
  '   ```\n',
  '<!-- memry:block-nesting-level= -->\n',
  '- item\n',
  '\r\n',
  ' '
]

export const HTML_ALPHABET = [
  '<a href="u">',
  '<A>',
  '</a>',
  '</A>',
  '<code>',
  '</code>',
  '<CODE>',
  '`',
  '``',
  ' ',
  'x',
  '<b>',
  '</b>',
  '<abbr>',
  '<a2>',
  '\n',
  '<',
  '>',
  'a b',
  '\u65e5',
  '\u{1F600}',
  '<code class="c">'
]
