/**
 * A code block whose language holds a backtick, written back as a fence.
 *
 * BlockNote fences a block with backticks and puts its language after them,
 * and CommonMark opens no backtick fence whose info string holds a backtick:
 * the language `` x `` came back as `````` `` x ``, which reads as the language
 * `x`, and the block lost two characters on every save. A tilde fence has no
 * such rule, so the block is written with one. The fence is hidden behind a
 * placeholder while BlockNote serializes (a language with no backtick opens
 * a backtick fence as always) and put back as tildes after.
 */
import { MASK_WORD } from './mask-word.ts'

interface BlockLike<B> {
  type?: string
  props?: Record<string, unknown>
  children?: B[]
}

const token = (index: number): string => `MEMRYFLG${MASK_WORD}${index};`
const FENCE_LINE = new RegExp(`^([ >]*)(\`{3,})MEMRYFLG${MASK_WORD}(\\d+);$`)

/** `blocks` with each language that holds a backtick replaced by a placeholder. */
export function hideBacktickLanguages<B extends BlockLike<B>>(
  blocks: B[]
): { blocks: B[]; languages: string[] } {
  const languages: string[] = []
  const walk = (list: B[]): B[] =>
    list.map((block) => {
      const children = block.children === undefined ? undefined : walk(block.children)
      const language = block.props?.language
      const hidden =
        block.type === 'codeBlock' &&
        typeof language === 'string' &&
        language.includes('`') &&
        !language.includes('\n')
      if (!hidden) return children === block.children ? block : { ...block, children }
      const props = { ...block.props, language: token(languages.push(language) - 1) }
      return { ...block, props, children }
    })
  const hidden = walk(blocks)
  return { blocks: languages.length === 0 ? blocks : hidden, languages }
}

/** `markdown` with each placeholder fence a tilde fence holding its language. */
export function spellBacktickLanguages(markdown: string, languages: string[]): string {
  if (languages.length === 0) return markdown
  const lines = markdown.split('\n')
  for (let open = 0; open < lines.length; open++) {
    const found = FENCE_LINE.exec(lines[open])
    if (!found) continue
    const [, prefix, ticks, index] = found
    const close = lines.indexOf(prefix + ticks, open + 1)
    if (close < 0) continue
    // A body line of tildes as long as the fence would close it.
    const longest = Math.max(
      0,
      ...lines
        .slice(open + 1, close)
        .flatMap((line) => (line.match(/~+/g) ?? []).map((run) => run.length))
    )
    const tildes = '~'.repeat(Math.max(3, longest + 1))
    const language = languages[Number(index)]
    // A language that opens with tildes would run into the fence's own.
    lines[open] = `${prefix}${tildes}${language.startsWith('~') ? ' ' : ''}${language}`
    lines[close] = prefix + tildes
    open = close
  }
  return lines.join('\n')
}
