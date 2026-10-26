// Boundary sweeps for the rules whose first sweeps sat on a page another rule had already
// decided (a mutation run left these thresholds unpinned). Each page keeps the rule under test
// alone: the heading or eyebrow rules that would remove the same node are kept out of reach, and
// scoring blocks sit under `gates-off` where only `removeLowScoring` can remove them.
import { H1, pad, page, plain, prose, sweep } from './removal-pages.mjs'

const words = (n) =>
  Array.from({ length: n }, (_, i) => ['garden', 'river', 'winter', 'engine'][i % 4]).join(' ')
const article = (block) => page(`${H1}${prose(8)}${block}`)
const card = (text) => `<div><img src="i.png"><a href="/x">${text}</a></div>`
const grid = (cards) => `<section><div>${cards.join('')}</div></section>`
const linkItems = (n, text) =>
  Array.from({ length: n }, (_, i) => `<a href="/p${i}">${text(i)}</a>`)

// A same-page link list of three items; `a` characters of text come before it and `b` after.
const TOC_ITEM = (id) => `<li><a href="#${id}">${plain(9)} ${id}</a></li>`
const TOC = `<ul>${TOC_ITEM('a')}${TOC_ITEM('b')}${TOC_ITEM('c')}</ul>`
const TOC_CHARS = 186

export const edgeSweepCases = [
  ...sweep('sweep-edge-toc-position', [28, 30, 32], (percent) => {
    const before = 300
    const total = Math.round((before * 100) / percent)
    return page(`${pad(before)}${TOC}${pad(total - before - TOC_CHARS)}`)
  }),
  ...sweep('sweep-edge-read-time-near-start', [4, 5, 6], (n) =>
    page(
      `<p>${['Estimated', 'reading', 'time', '8', 'min', 'read'].slice(6 - n).join(' ')}</p><p>Hello there.</p>${H1}${prose(4)}`
    )
  ),
  // The hero block must sit at the content start's depth, because linkedom's
  // `compareDocumentPosition` reports a deeper node as preceding.
  ...sweep('sweep-edge-hero-prose-words', [29, 30, 31], (n) =>
    page(
      `<div><time datetime="2024-03-04">${words(16)}</time><h1> The Long Road Home </h1><p>${plain(n - 1)} end.</p></div>${prose(4)}`
    )
  ),
  ...sweep('sweep-edge-related-cards-position', [499, 500, 501], (k) =>
    page(`${pad(k)}${grid([card('ZqZqZ one'), card('Yy two')])}${prose(4)}`)
  ),
  ...sweep('sweep-edge-related-cards-first-text', [4, 5, 6], (n) =>
    page(`${prose(4)}${grid([card('abcdefgh'.slice(0, n)), card('Yy two')])}${prose(1)}`)
  ),
  ...sweep('sweep-edge-related-cards-count', [1, 2], (n) =>
    page(`${prose(4)}${grid([card('ZqZqZ one'), card('Yy two')].slice(0, n))}${prose(1)}`)
  ),
  ...sweep('sweep-edge-related-cards-ratio', [13, 14, 15], (k) =>
    page(
      `${prose(4)}${grid(Array.from({ length: 20 }, (_, i) => (i < k ? card(i ? `c${i} x` : 'ZqZqZ one') : `<div>plain ${i}</div>`)))}${prose(1)}`
    )
  ),
  ...sweep('sweep-edge-related-cards-grid-share', [28, 30, 32], (g) =>
    page(
      `${pad(600)}${grid([card(`ZqZqZ ${plain(g / 2 - 1)}`), card(plain(g / 2))])}<p>${plain(99 - g)}</p>`
    )
  ),
  ...sweep('sweep-edge-external-list-ratio', [5, 6, 7], (k) => {
    const item = `<li><a href="https://other.com/p">${'a'.repeat(k)}</a>${'b'.repeat(10 - k)}</li>`
    return page(`${H1}${prose(4)}<h2>Picks</h2><ul>${item}${item}</ul>`)
  }),
  ...sweep('sweep-edge-related-posts-ratio', [5, 6, 7], (k) => {
    const p = `<p><a href="/z">${'a'.repeat(k)}</a>${'b'.repeat(10 - k)}</p>`
    return page(`${H1}${prose(4)}<div>${p}${p}</div>`)
  }),
  // isLikelyContent: a navigation heading with 200+ words keeps the block only below 0.2 links
  // per word.
  ...sweep('sweep-edge-nav-heading-link-ratio', [39, 40, 41, 42], (links) =>
    article(
      `<div><h2>Related articles</h2>\n<p>${linkItems(links, (i) => `l${i}`).join(' ')} ${plain(200 - 2 - links - 2)}</p>\n<p>MARKERPP QQ</p></div>`
    )
  ),
  // Prose without <p>: one link in ten words is the limit.
  ...sweep('sweep-edge-prose-link-ratio', [1, 2, 3], (links) =>
    article(`<div>cookie ${plain(19 - links)}. ${linkItems(links, () => 'a').join(' ')}</div>`)
  ),
  // scoreNonContentBlock: link text above 0.8 of a short block.
  ...sweep('sweep-edge-score-link-text-share', [4, 5, 6], (k) =>
    article(
      `<div><a href="/l1">${'a'.repeat(22)}</a> <a href="/l2">${'b'.repeat(22)}</a>${' c'.repeat(k)}</div>`
    )
  ),
  // The link-share rule needs fewer than 80 words; the blocks are 79 and 80 words.
  ...sweep('sweep-edge-score-link-share-words', [79, 80], (n) =>
    article(
      `<div><a href="/l1">${'a'.repeat(400)}</a> <a href="/l2">${'b'.repeat(400)}</a>${' c'.repeat(n - 2)}</div>`
    )
  ),
  // A list with more than three links per list loses ten points; commas offset nine.
  ...sweep('sweep-edge-score-links-per-list', [3, 4], (links) =>
    article(
      `<div>a,b,c,d,e,f,g,h,i<ul>${linkItems(links, (i) => `<li>x${i}</li>`).join('')}</ul> ${plain(14)}</div>`
    )
  ),
  // `advert` in a class costs eight points; seven commas offset seven of them.
  ...sweep('sweep-edge-score-class-penalty', [7, 8], (commas) =>
    article(`<div class="advert">${plain(4)}${',x'.repeat(commas)} end</div>`)
  ),
  // A layout table is wider than 400, so its middle cell counts as the content cell.
  ...sweep('sweep-edge-table-width', [399, 400, 401], (width) =>
    page(
      `${H1}<table width="${width}"><tr><td>${plain(3)}</td><td>${plain(5)}, ${plain(5)}</td><td>${plain(3)}</td></tr></table>${prose(2)}`
    )
  ),
  // The exact-selector rule skips `code` as well as `pre`.
  ...sweep('sweep-edge-exact-selector-in-code', [0, 1], (n) =>
    page(
      `${H1}${prose(4)}<div>${n ? '<code>' : '<span>'}<aside>ASIDEMARK</aside>${n ? '</code>' : '</span>'}</div>`
    )
  )
]
