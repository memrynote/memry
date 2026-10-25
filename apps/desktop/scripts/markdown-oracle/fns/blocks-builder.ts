/** Shared helpers of the hand-written `blocks` cases. */
import type { OracleCase } from '../cases-frontmatter'
import type { StubSpec } from './blocks-stubs'

export const MINI: StubSpec = { kind: 'mini' }
export const L = (text: string): string[] => text.split('\n')

function kebab(prefix: string): string {
  return prefix.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)
}

export class Builder {
  readonly cases: OracleCase[] = []
  private readonly counts = new Map<string, number>()

  add(fn: string, ...args: unknown[]): void {
    const [prefix, name] = fn.split('.')
    const group = kebab(prefix)
    const slug = kebab(name).toLowerCase()
    const key = `${group}/${slug}`
    const n = (this.counts.get(key) ?? 0) + 1
    this.counts.set(key, n)
    this.cases.push({ id: `${group}/fn/${slug}-${n}`, op: 'fn', input: { fn, args } })
  }
}

export const para = (text: string, children: unknown[] = []): Record<string, unknown> => ({
  type: 'paragraph',
  props: {},
  content: text === '' ? [] : [{ type: 'text', text, styles: {} }],
  children
})
export const item = (
  type: string,
  text: string,
  children: unknown[] = []
): Record<string, unknown> => ({
  type,
  props: {},
  content: [{ type: 'text', text, styles: {} }],
  children
})

export const table = (
  parse: Record<string, unknown[]>,
  serialize: [unknown[], string][] = []
): StubSpec => ({ kind: 'table', parse, serialize })
