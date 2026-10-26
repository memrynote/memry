/**
 * The deterministic parse/serialize pair `blocks.ts` hands to the callout,
 * quote and column functions in place of BlockNote. The Rust test defines the
 * same pair by this description, so both sides run identical callbacks.
 *
 * `mini` reads a tiny markdown: blocks split on `\n\n`; a chunk whose every
 * line is a list item (`-`/`*`/`+` or `1.`, a space, the text, two spaces per
 * nesting level) is a nested list, `# x` a heading, `> x` a quote, anything
 * else a paragraph. It writes the canonical forms back (`- `, `1. `, `# `,
 * `> `), so `* a` settles to `- a` and nothing else moves.
 * `table` answers `parse` from a lookup (a miss throws) and `serialize` from a
 * list of `[blocks, markdown]` pairs, falling back to `mini`.
 */
import type { ParsedBlockShape } from '../../../../../packages/editor-schema/src/blocks/markdown'

export type StubSpec =
  | { kind: 'mini' }
  | {
      kind: 'table'
      parse: Record<string, ParsedBlockShape[]>
      serialize: [ParsedBlockShape[], string][]
    }
  | { kind: 'parse-error' }
  | { kind: 'serialize-error' }

export interface Stub {
  parse: (markdown: string) => Promise<ParsedBlockShape[]>
  serialize: (blocks: ParsedBlockShape[]) => Promise<string>
}

interface MiniBlock extends ParsedBlockShape {
  props: Record<string, unknown>
  children: MiniBlock[]
}

function inline(text: string): unknown[] {
  return text === '' ? [] : [{ type: 'text', text, styles: {} }]
}

function block(type: string, props: Record<string, unknown>, text: string): MiniBlock {
  return { type, props, content: inline(text), children: [] }
}

/** `(depth, ordered, text)` of a list line, or null. */
function listLine(line: string): { depth: number; ordered: boolean; text: string } | null {
  let spaces = 0
  while (line[spaces] === ' ') spaces++
  const rest = line.slice(spaces)
  if (rest.length >= 2 && '-*+'.includes(rest[0]) && rest[1] === ' ') {
    return { depth: Math.floor(spaces / 2), ordered: false, text: rest.slice(2) }
  }
  let digits = 0
  while (digits < rest.length && rest[digits] >= '0' && rest[digits] <= '9') digits++
  if (digits > 0 && rest[digits] === '.' && rest[digits + 1] === ' ') {
    return { depth: Math.floor(spaces / 2), ordered: true, text: rest.slice(digits + 2) }
  }
  return null
}

function parseChunk(chunk: string): MiniBlock[] {
  const lines = chunk.split('\n')
  const items = lines.map(listLine)
  if (items.every((item) => item !== null)) {
    const roots: MiniBlock[] = []
    const stack: { depth: number; block: MiniBlock }[] = []
    for (const item of items) {
      let node: MiniBlock
      if (item.ordered) node = block('numberedListItem', {}, item.text)
      else if (item.text.startsWith('[ ] ') || item.text.startsWith('[x] ')) {
        node = block('checkListItem', { checked: item.text[1] === 'x' }, item.text.slice(4))
      } else node = block('bulletListItem', {}, item.text)
      while (stack.length > 0 && stack[stack.length - 1].depth >= item.depth) stack.pop()
      const parent = stack[stack.length - 1]
      if (parent) parent.block.children.push(node)
      else roots.push(node)
      stack.push({ depth: item.depth, block: node })
    }
    return roots
  }
  if (chunk.startsWith('# ')) return [block('heading', { level: 1 }, chunk.slice(2))]
  if (chunk.startsWith('> ')) {
    const text = lines.map((line) => (line.startsWith('> ') ? line.slice(2) : line)).join('\n')
    return [block('quote', {}, text)]
  }
  return [block('paragraph', {}, chunk)]
}

export function miniParse(markdown: string): MiniBlock[] {
  return markdown
    .split('\n\n')
    .filter((chunk) => chunk.trim() !== '')
    .flatMap(parseChunk)
}

function inlineText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((item: unknown) =>
      typeof item === 'object' && item !== null && 'text' in item && typeof item.text === 'string'
        ? item.text
        : ''
    )
    .join('')
}

function childBlocks(b: ParsedBlockShape): ParsedBlockShape[] {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- children are blocks; the stub reads only the fields it wrote
  return Array.isArray(b.children) ? (b.children as ParsedBlockShape[]) : []
}

function checked(b: ParsedBlockShape & { props?: unknown }): boolean {
  const props = b.props
  return typeof props === 'object' && props !== null && 'checked' in props && props.checked === true
}

function miniSerializeBlock(b: ParsedBlockShape, depth: number): string {
  const pad = '  '.repeat(depth)
  const text = inlineText(b.content)
  const children = childBlocks(b)
  if (b.type === 'bulletListItem' || b.type === 'numberedListItem' || b.type === 'checkListItem') {
    const marker =
      b.type === 'numberedListItem'
        ? '1.'
        : b.type === 'checkListItem'
          ? `- [${checked(b) ? 'x' : ' '}]`
          : '-'
    return [
      `${pad}${marker} ${text}`,
      ...children.map((c) => miniSerializeBlock(c, depth + 1))
    ].join('\n')
  }
  const own =
    b.type === 'heading'
      ? `# ${text}`
      : b.type === 'quote'
        ? text
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n')
        : text
  return [own, ...children.map((c) => miniSerializeBlock(c, 0))].join('\n\n')
}

export function miniSerialize(blocks: ParsedBlockShape[]): string {
  return blocks.map((b) => miniSerializeBlock(b, 0)).join('\n\n')
}

export function makeStub(spec: StubSpec): Stub {
  switch (spec.kind) {
    case 'mini':
      return { parse: async (m) => miniParse(m), serialize: async (b) => miniSerialize(b) }
    case 'table':
      return {
        parse: async (m) => {
          const blocks = Object.hasOwn(spec.parse, m) ? spec.parse[m] : undefined
          if (!blocks) throw new Error(`table stub: no parse entry for ${JSON.stringify(m)}`)
          return blocks
        },
        serialize: async (blocks) => {
          const key = JSON.stringify(blocks)
          const hit = spec.serialize.find(([candidate]) => JSON.stringify(candidate) === key)
          return hit ? hit[1] : miniSerialize(blocks)
        }
      }
    case 'parse-error':
      return {
        parse: async () => {
          throw new Error('parse-error stub')
        },
        serialize: async (b) => miniSerialize(b)
      }
    default:
      return {
        parse: async (m) => miniParse(m),
        serialize: async () => {
          throw new Error('serialize-error stub')
        }
      }
  }
}
