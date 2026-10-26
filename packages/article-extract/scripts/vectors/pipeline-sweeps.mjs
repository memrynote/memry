// Both sides of every number `Defuddle.parse()` compares a word count with: the 200 and 50 word
// floors that start a retry, the doubling that accepts one, the 0.7 and 30 of the hidden-content
// retry, the 1.5 of the schema.org retry and the 0.8 and 100 characters of its element search.
// Each page differs from its neighbour in one number only. A marker word shows which extraction
// the parser kept.
import { sweep } from './removal-pages.mjs'

const U = 'https://example.com/blog/2024/post'
const raw = (body, head = '') =>
  `<!DOCTYPE html><html><head><title>T</title>${head}</head><body>${body}</body></html>`

const BASE = ['garden', 'river', 'winter', 'engine']
/** `count` words; the first is `mark` when one is given. */
const w = (count, { mark, seed = 0 } = {}) =>
  Array.from({ length: count }, (_, i) => (i === 0 && mark ? mark : BASE[(i + seed) % 4])).join(' ')
const para = (count, opts) => `<p>${w(count, opts)}</p>`
const hidden = (count, opts) => `<div style="display:none">${para(count, opts)}</div>`
const related = (count, opts) => `<div class="related">${para(count, opts)}</div>`
const hiddenAttr = (count, opts) => `<div hidden>${para(count, opts)}</div>`
const ld = (data) => `<script type="application/ld+json">${JSON.stringify(data)}</script>`
const page = (body, head = '') => ({ html: raw(body, head), url: U })

export const pipelineSweepCases = [
  // wordCount < 200: the partial-selector retry runs below it (A = 199) and not at 200.
  ...sweep('sweep-retry-partial-floor', [199, 200], (a) =>
    page(`<main>${related(600, { mark: 'BBMARK' })}${para(a, { mark: 'AAMARK' })}</main>`)
  ),
  // The retry replaces the result only when it has more than twice the words (100 + B > 200).
  ...sweep('sweep-retry-partial-double', [100, 101], (b) =>
    page(`<main>${related(b, { mark: 'BBMARK' })}${para(100, { mark: 'AAMARK' })}</main>`)
  ),
  // wordCount < 50: the hidden-content retry runs below it.
  ...sweep('sweep-retry-hidden-floor', [49, 50], (a) =>
    page(`${hidden(200, { mark: 'HHMARK' })}${para(a, { mark: 'AAMARK' })}`)
  ),
  // Twice the words again (20 + H > 40); H stays under 30 so the selector retry never runs.
  ...sweep('sweep-retry-hidden-double', [20, 21], (h) =>
    page(`${hidden(h, { mark: 'HHMARK' })}${para(20, { mark: 'AAMARK' })}`)
  ),
  // The hidden selector retry needs a hidden subtree of 30 words. It sits in `[hidden]`, which
  // the retry's own selector search reads (a `display:none` style is not one of its selectors).
  ...sweep('sweep-retry-hidden-largest-words', [29, 30], (h) =>
    page(`${hiddenAttr(h, { mark: 'HHMARK' })}${para(10, { mark: 'AAMARK' })}`)
  ),
  // The retry then replaces the result when it holds more than 0.7 of the result's words
  // (0.7 * 100 = 70 exactly, so 70 words are not enough).
  ...sweep('sweep-retry-hidden-seventy-percent', [70, 71], (h) =>
    page(`${hiddenAttr(h, { mark: 'HHMARK' })}${para(30, { mark: 'AAMARK' })}`)
  ),
  // The last retry, with low scoring, partial selectors and content patterns off, runs below 50
  // words and is kept when it finds any more. The `homepage` block scores minus one: removed by
  // the scorer, back in the retry.
  ...sweep('sweep-retry-index-floor', [49, 50], (a) =>
    page(
      `${para(a, { mark: 'AAMARK' })}<div class="homepage">IDXMARK ${w(10)}${',x'.repeat(7)}</div>`
    )
  ),
  // The schema.org text replaces a result that has under 1 / 1.5 of its words.
  ...sweep('sweep-retry-schema-ratio', [150, 151], (s) =>
    page(
      para(100, { mark: 'AAMARK' }),
      ld({ '@type': 'Article', articleBody: w(s, { mark: 'SSMARK', seed: 2 }) })
    )
  ),
  // Looking for the element that holds the schema.org text: the smallest one with 0.8 of its
  // words (80 of 100). The section holds T of them; below 80 its wrapper, with the filler, wins.
  ...sweep('sweep-retry-schema-element-words', [79, 80, 81], (t) =>
    page(
      `${para(20, { mark: 'AAMARK' })}<div id="outer"><section>${w(t, { mark: 'SSMARK', seed: 2 })}</section>\n<p>${w(20, { mark: 'FFMARK' })}</p></div>`,
      ld({ '@type': 'Article', articleBody: w(100, { mark: 'SSMARK', seed: 2 }) })
    )
  ),
  // ... and it searches for the first 100 characters of that text. The section differs from the
  // schema text at index 100 (inside the phrase's reach only for a longer phrase) or at 99.
  ...sweep('sweep-retry-schema-phrase-length', [99, 100], (at) => {
    const text = w(100, { mark: 'SSMARK', seed: 2 })
    const copy = `${text.slice(0, at)}#${text.slice(at + 1)}`
    return page(
      `${para(20, { mark: 'AAMARK' })}<aside><section>${copy}</section></aside>`,
      ld({ '@type': 'Article', articleBody: text })
    )
  }),
  // With as many words as the result (40 each) the retry is taken only when its markup is
  // shorter: 1 extra letter in the hidden text leaves it shorter, 2 make the lengths equal and 3
  // longer than the visible result's.
  ...sweep('sweep-retry-hidden-shorter', [1, 2, 3], (extra) =>
    page(
      `<div hidden><p>${w(40, { mark: 'HHMARK' })}${'z'.repeat(extra)}</p></div>${para(40, { mark: 'AAMARK' })}`
    )
  )
]
