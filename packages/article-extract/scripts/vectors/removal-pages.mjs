// Page builders shared by the removal cases and sweeps.
//
// Single-rule pages for the removal steps: each is written to reach one branch of
// `dist/removals/*.js`. The oracle runs every case through all variants (`removals.mjs`), so a
// branch the port gets wrong shows as a difference in the step that owns it.
export const URL = 'https://example.com/blog/2024/post'

/** `count` words of prose with commas and sentence ends, so the page scores as content. */
export const words = (count, seed = 0) => {
  const bank = [
    'garden',
    'river',
    'winter',
    'engine',
    'letter',
    'market',
    'window',
    'signal',
    'harvest',
    'lantern',
    'paper',
    'bridge'
  ]
  const out = []
  for (let i = 0; i < count; i++) {
    const w = bank[(i * 7 + seed) % bank.length]
    out.push(i % 9 === 8 ? `${w},` : i % 17 === 16 ? `${w}.` : w)
  }
  return out.join(' ')
}
export const prose = (paragraphs, seed = 0) =>
  Array.from({ length: paragraphs }, (_, i) => `<p>${words(45, seed + i)}.</p>`).join('\n')

export const page = (body, { head = '', wrap = 'article', title = 'The Long Road Home' } = {}) =>
  `<!DOCTYPE html><html><head><title>${title}</title>${head}</head><body>` +
  `<${wrap}>${body}</${wrap}></body></html>`

/** `count` plain words: no punctuation, no commas. */
export const plain = (count, seed = 0) =>
  Array.from(
    { length: count },
    (_, i) => ['garden', 'river', 'winter', 'engine'][(i + seed) % 4]
  ).join(' ')
/** A paragraph of exactly `length` characters in one word: moves what follows to that offset. */
export const pad = (length) => `<p>${'a'.repeat(length)}</p>`
export const H1 = '<h1>The Long Road Home</h1>'

/** One page per value: the pages differ only in the number a rule compares against. */
export const sweep = (name, values, make) =>
  values.map((v) => {
    const made = make(v)
    const { html, url } = typeof made === 'string' ? { html: made } : made
    return { name: `${name}-${v}`, html, ...(url ? { url } : {}) }
  })

export const byline = '<meta name="author" content="Jane Doe">'
export const pubDate = '<meta property="article:published_time" content="2024-03-04">'
