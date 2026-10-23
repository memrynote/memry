/**
 * Inline Markdown that survives folding. `stripInline` (engine.ts) yields the
 * plain text the model, the hashes and caret matching use. Here the same steps
 * run over a position-tracked string, so every plain sentence maps back to its
 * Markdown source (bold, italic, code, links, wiki-links).
 */

interface Tracked {
  text: string
  /** pos[i] = UTF-16 index in the original Markdown of text[i]. */
  pos: number[]
}

/** Mirrors the `stripInline` replace chain: `keep` lists the capture groups a match leaves behind. */
const STEPS: { re: RegExp; keep: number[] }[] = [
  { re: /!\[[^\]]*\]\([^)]*\)/dg, keep: [] },
  { re: /\[\[([^\]|]*\|)?([^\]]*)\]\]/dg, keep: [2] },
  { re: /\[([^\]]*)\]\([^)]*\)/dg, keep: [1] },
  { re: /(\*\*|__|~~|`)/dg, keep: [] },
  { re: /(^|\s)[*_]([^*_\n]+)[*_](?=\s|$|[.,;:!?])/dg, keep: [1, 2] },
  { re: /<[^>]+>/dg, keep: [] }
]

function applyStep(t: Tracked, re: RegExp, keep: number[]): Tracked {
  let text = ''
  const pos: number[] = []
  const copy = (from: number, to: number): void => {
    text += t.text.slice(from, to)
    for (let i = from; i < to; i++) pos.push(t.pos[i])
  }
  let last = 0
  for (const m of t.text.matchAll(re)) {
    copy(last, m.index)
    for (const g of keep) {
      const range = m.indices?.[g]
      if (range) copy(range[0], range[1])
    }
    last = m.index + m[0].length
  }
  copy(last, t.text.length)
  return { text, pos }
}

function collapseWhitespace(t: Tracked): Tracked {
  let text = ''
  const pos: number[] = []
  for (let i = 0; i < t.text.length; i++) {
    if (/\s/.test(t.text[i])) {
      if (text.length > 0 && !text.endsWith(' ')) {
        text += ' '
        pos.push(t.pos[i])
      }
    } else {
      text += t.text[i]
      pos.push(t.pos[i])
    }
  }
  if (text.endsWith(' ')) {
    text = text.slice(0, -1)
    pos.pop()
  }
  return { text, pos }
}

function trackInline(md: string): Tracked {
  let t: Tracked = { text: md, pos: Array.from({ length: md.length }, (_, i) => i) }
  for (const step of STEPS) t = applyStep(t, step.re, step.keep)
  return collapseWhitespace(t)
}

const escapePlain = (s: string): string => s.replace(/[\\`*_~[\]<]/g, '\\$&')

const count = (s: string, needle: string): number => s.split(needle).length - 1

/** A sentence cut out of a longer span can hold half a pair; close it, or give up. */
function balance(md: string): string | null {
  let s = md.trim()
  for (const d of ['**', '__', '~~', '`']) {
    if (count(s, d) % 2 === 0) continue
    if (s.startsWith(d)) s += d
    else if (s.endsWith(d)) s = d + s
    else return null
  }
  const single = s.replace(/\*\*|__|~~/g, '')
  for (const d of ['*', '_']) {
    if (count(single, d) % 2 === 0) continue
    if (single.startsWith(d)) s += d
    else if (single.endsWith(d)) s = d + s
    else return null
  }
  return count(s, '[') === count(s, ']') ? s : null
}

/**
 * Inline Markdown per plain sentence, aligned 1:1 with `sentences`. `plain`
 * is `stripInline(md)`; when the tracked text disagrees with it, or a sentence
 * cannot be cut cleanly, that sentence falls back to escaped plain text.
 */
export function sentencesToMarkdown(md: string, plain: string, sentences: string[]): string[] {
  const fallback = (): string[] => sentences.map(escapePlain)
  const clean = md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]{2,}/g, ' ')
  const tracked = trackInline(clean)
  if (tracked.text !== plain) return fallback()

  const starts: number[] = []
  let cursor = 0
  for (const s of sentences) {
    const at = plain.indexOf(s, cursor)
    if (at < 0) return fallback()
    starts.push(at)
    cursor = at + s.length
  }
  const cuts = starts.map((a) => (a === 0 ? 0 : tracked.pos[a - 1] + 1))
  return sentences.map((s, i) => {
    const slice = clean.slice(cuts[i], i + 1 < cuts.length ? cuts[i + 1] : clean.length)
    return balance(slice) ?? escapePlain(s)
  })
}
