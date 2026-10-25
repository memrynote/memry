/**
 * Shared plumbing of the `markers` layer cases (#3522 stage 4): one case is a
 * function name plus its JSON arguments; the expected output is whatever the
 * TypeScript returns.
 */
import type { OracleCase } from '../cases-frontmatter'

/** Case ids are `<group>/fn/<slug>`; slugs are unique across the file. */
export class CaseList {
  readonly cases: OracleCase[] = []
  private readonly counts = new Map<string, number>()

  constructor(private readonly group: string) {}

  /** One case of `fn` with `args`; `name` is a hand-picked slug, or the call is numbered. */
  add(fn: string, args: unknown[], name?: string): void {
    const base = fn.replace(/([A-Z])/g, (c) => `-${c.toLowerCase()}`).replace(/[^a-z0-9]+/g, '-')
    const stem = name === undefined ? base : `${base}-${name.replace(/[^a-z0-9]+/g, '-')}`
    const n = (this.counts.get(stem) ?? 0) + 1
    this.counts.set(stem, n)
    const slug = name === undefined || n > 1 ? `${stem}-${n}` : stem
    this.cases.push({ id: `${this.group}/fn/${slug}`, op: 'fn', input: { fn, args } })
  }

  /** The same function over a list of single-argument inputs. */
  each(fn: string, inputs: unknown[]): void {
    for (const input of inputs) this.add(fn, [input])
  }
}

/** Markdown with the exact bytes that matter spelled out, so no editor can alter them. */
export const NASTY_LINES = [
  '',
  '   ',
  '\t',
  '\u00a0',
  '\ufeff',
  '\u2028',
  'emoji 😀 line',
  '日本語 テキスト',
  '\r',
  'a\rb',
  'a\u2028b',
  'a\u2029b'
]
