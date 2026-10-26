// Single-branch pages for `Defuddle.parse` and `parseInternal`: each reaches one retry, one
// content-finder branch or one image/URL pass that the corpus pages do not.
import { pipelineSweepCases } from './pipeline-sweeps.mjs'
import { page, words } from './removal-pages.mjs'

const U = 'https://example.com/blog/2024/post'
const p = (n, seed = 0) => `<p>${words(n, seed)}.</p>`
const long = `${p(60)}${p(60, 3)}${p(60, 5)}${p(60, 7)}`
const wrap = (body, head = '') => page(body, { head })
const raw = (body, head = '') =>
  `<!DOCTYPE html><html><head><title>T</title>${head}</head><body>${body}</body></html>`
const img = (src, alt = 'photo', extra = '') => `<img src="${src}" alt="${alt}" ${extra}>`

export const pipelineCases = [
  // `decodeURIComponent` throws on a malformed escape; `parseInternal` returns the sanitized body.
  {
    name: 'math-latex-image-uri-error',
    html: raw(`${long}<img class="latex" src="https://s0.wp.com/latex.php?latex=%E0%A4%A">`),
    url: U
  },
  { name: 'empty-document', html: '', url: U },
  { name: 'no-body-content', html: raw(''), url: U },
  {
    name: 'tiny-hidden-article',
    html: raw(`<div style="display:none">${p(70)}</div><p>x</p>`),
    url: U
  },
  { name: 'hidden-class-article', html: raw(`<div class="hidden">${p(70)}</div>`), url: U },
  {
    name: 'index-retry',
    html: raw(
      `<div class="post-preview">${p(20)}</div><div class="post-preview">${p(20, 2)}</div>`
    ),
    url: U
  },
  {
    name: 'partial-selector-retry',
    html: raw(`<main><div class="related">${p(80)}${p(80, 1)}${p(80, 2)}</div><p>short</p></main>`),
    url: U
  },
  {
    name: 'schema-text-longer',
    html: raw(
      `<div class="feed"><p>${words(30)}</p></div>`,
      `<script type="application/ld+json">${JSON.stringify({ '@type': 'Article', articleBody: `${words(80)}.\n\n${words(80, 3)}` })}</script>`
    ),
    url: U
  },
  {
    name: 'schema-text-in-body',
    html: raw(
      `<div><section>${words(200)}</section><aside>other</aside></div>`,
      `<script type="application/ld+json">${JSON.stringify({ '@type': 'Article', articleBody: words(200) })}</script>`
    ),
    url: U
  },
  {
    name: 'table-layout-content',
    html: raw(`<table width="600"><tr><td width="100">nav</td><td>${long}</td></tr></table>`),
    url: U
  },
  {
    name: 'table-layout-peripheral',
    html: raw(`<table align="center"><tr><td>${p(10)}</td></tr></table>${long}`),
    url: U
  },
  {
    name: 'listing-parent',
    html: wrap(
      `<article>${p(60)}</article><article>${p(60, 2)}</article><article>${p(60, 4)}</article>`
    ),
    url: U
  },
  {
    name: 'main-contains-article',
    html: raw(`<main>${p(40)}<article>${long}</article></main>`),
    url: U
  },
  { name: 'block-scoring-fallback', html: raw(`<div>${long}</div><div>short</div>`), url: U },
  {
    name: 'relative-urls',
    html: wrap(
      `${long}<a href="rel/page">a</a><a href="#frag">b</a><a href='"mailto:a@b.c"'>m</a><a href="//cdn.example/x">c</a>${img('/pic.jpg')}<video poster="p.png"></video>`
    ),
    url: U
  },
  {
    name: 'base-href',
    html: raw(
      `<article>${long}<a href="x">x</a>${img('y.png')}</article>`,
      '<base href="https://other.example/dir/">'
    ),
    url: U
  },
  {
    name: 'srcset-resolution',
    html: wrap(
      `${long}<img srcset="a.jpg 1x, /b,w_2/c.jpg 2x" src="a.jpg" alt="s"><img srcset="a.jpg, b.jpg" alt="n">`
    ),
    url: U
  },
  {
    name: 'react-srcset-case',
    html: wrap(`${long}<img srcSet="/big.jpg 800w, /small.jpg 400w" src="/big.jpg" alt="r">`),
    url: U
  },
  {
    name: 'noscript-sibling-swap',
    html: wrap(
      `${long}<div>${img('data:image/gif;base64,R0lGOD', 'real')}<noscript>${img('/real.jpg', 'real', 'srcset="/r2.jpg 2x"')}</noscript></div>`
    ),
    url: U
  },
  {
    name: 'noscript-promote-figure',
    html: wrap(
      `${long}<figure class="lazy"><noscript>${img('/lazy.jpg', 'lazy')}</noscript></figure>`
    ),
    url: U
  },
  {
    name: 'noscript-tracking-pixel',
    html: wrap(`${long}<div><noscript>${img('/pixel.gif', 'x')}</noscript></div>`),
    url: U
  },
  {
    name: 'duplicate-figure-images',
    html: wrap(
      `${long}<figure>${img('/a.jpg?w=100', 'same')}${img('/a.jpg?w=900', 'same')}<figcaption>c</figcaption></figure>`
    ),
    url: U
  },
  {
    name: 'duplicate-adjacent-images',
    html: wrap(
      `${long}<div>${img('/w_100/a.jpg', 'dup')}</div><div>${img('https://example.com/w_900/a.jpg', 'dup', 'srcset="/x 2x"')}</div>`
    ),
    url: U
  },
  {
    name: 'lightbox-duplicate',
    html: wrap(
      `${long}<div><a href="/full.jpg">${img('/thumb.jpg', 'th')}</a>${img('/full.jpg', 'full')}</div>`
    ),
    url: U
  },
  {
    name: 'cover-image-removed',
    html: wrap(
      `${long}${img('/cover.jpg?x=1', 'cover', 'srcset="/cover.jpg 400w, /cover-big.jpg,w_852,c_limit 1200w"')}`,
      '<meta property="og:image" content="https://example.com/cover.jpg">'
    ),
    url: U
  },
  {
    name: 'cover-image-captioned',
    html: wrap(
      `${long}<figure>${img('/cover.jpg')}<figcaption>Caption</figcaption></figure>`,
      '<meta property="og:image" content="/cover.jpg">'
    ),
    url: U
  },
  {
    name: 'streamed-content',
    html: raw(
      `<div hidden id="S:0">${long}</div><template id="B:0"></template><div>fallback</div><!--/$--><script>$RC("B:0","S:0")</script>`
    ),
    url: U
  },
  {
    name: 'streamed-no-marker',
    html: raw(
      `<div hidden id="S:1">${long}</div><template id="B:1"></template><div>fallback</div><script>$RC("B:1","S:1")</script>`
    ),
    url: U
  },
  {
    name: 'external-footnotes',
    html: raw(
      `<main><article>${long}</article></main><div class="footnotes"><h2>Footnotes</h2><ol><li>one</li></ol></div>`
    ),
    url: U
  },
  {
    name: 'defuddle-container',
    html: raw(`<div data-defuddle="x"><p>wrapper</p><article>${long}</article></div>`),
    url: U
  },
  {
    name: 'unsafe-fallback-body',
    html: raw(
      `<div onclick="x()">hi<script>1</script><a href="javascript:x">j</a><iframe srcdoc="x"></iframe></div>`
    ),
    url: U
  },
  { name: 'blank-url', html: wrap(long), url: '' },
  { name: 'bad-url', html: wrap(`${long}<a href="x">x</a>`), url: 'not a url' },
  ...pipelineSweepCases
]
