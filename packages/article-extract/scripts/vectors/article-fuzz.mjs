// Seeded random whole pages for the article pipeline: a head of metadata variants, page chrome
// and a body assembled from article blocks (prose, headings, lists, tables, code, images,
// footnotes, math, comments, hidden and promotional content), with a little tag soup mixed in.
// They reach the interactions between the removal, standardize and markdown stages that the
// hand-made corpus does not enumerate. No `select` and no `</p>` inside `svg`: html5ever 0.40 and
// domino build different trees there (see crates/AGENTS.md).
import { extractFromHtml } from '../../src/node.ts'
import { rng } from './dom.mjs'

const WORDS = [
  'small',
  'tools',
  'notes',
  'sync',
  'local',
  'first',
  'merge',
  'vector',
  'clock',
  'device',
  'vault',
  'search',
  'index',
  'draft',
  'review',
  'ship',
  'cache',
  'queue',
  'model',
  'graph'
]

const pick = (random, list) => list[Math.floor(random() * list.length)]
const words = (random, n) => Array.from({ length: n }, () => pick(random, WORDS)).join(' ')
const sentence = (random) => `${words(random, 6 + Math.floor(random() * 14))}.`

const BLOCKS = [
  (r) => `<p>${sentence(r)} ${sentence(r)}</p>`,
  (r) => `<p>${sentence(r)} <a href="/p/${words(r, 1)}">${words(r, 2)}</a> ${sentence(r)}</p>`,
  (r) => `<p>${sentence(r)} <a href="https://other.example/${words(r, 1)}">${words(r, 3)}</a></p>`,
  (r) => `<h2>${words(r, 3)}</h2><p>${sentence(r)}</p>`,
  (r) => `<h3 id="${words(r, 1)}">${words(r, 2)}</h3><p>${sentence(r)}</p>`,
  (r) => `<h1>${words(r, 4)}</h1>`,
  (r) => `<ul>${'<li>' + words(r, 3) + '</li>'.repeat(1)}<li>${words(r, 5)}</li></ul>`,
  (r) => `<ol><li>${sentence(r)}</li><li>${sentence(r)}</li></ol>`,
  (r) => `<blockquote><p>${sentence(r)}</p></blockquote>`,
  (r) =>
    `<pre><code class="language-js">const ${words(r, 1)} = ${Math.floor(r() * 100)};\nconsole.log(${words(r, 1)})</code></pre>`,
  (r) => `<p>Use <code>${words(r, 1)}()</code> and <kbd>${words(r, 1)}</kbd>. ${sentence(r)}</p>`,
  (r) =>
    `<table><tr><th>${words(r, 1)}</th><th>${words(r, 1)}</th></tr><tr><td>${words(r, 2)}</td><td>${Math.floor(r() * 90)}</td></tr></table>`,
  (r) =>
    `<figure><img src="/img/${words(r, 1)}.jpg" alt="${words(r, 2)}"><figcaption>${sentence(r)}</figcaption></figure>`,
  (r) =>
    `<img src="data:image/gif;base64,R0lGOD" data-src="https://cdn.example/${words(r, 1)}.png" alt="">`,
  (r) => `<img srcset="a.jpg 400w, b.jpg 800w" sizes="100vw" src="c.jpg" alt="${words(r, 1)}">`,
  (r) => `<p>${sentence(r)}<sup id="fnref:1"><a href="#fn:1">1</a></sup></p>`,
  (r) =>
    `<div id="footnotes"><ol><li id="fn:1"><p>${sentence(r)} <a href="#fnref:1">\u21a9</a></p></li></ol></div>`,
  (r) =>
    `<p>The value <math><mi>x</mi><mo>=</mo><mfrac><mi>a</mi><mi>b</mi></mfrac></math> holds. ${sentence(r)}</p>`,
  (r) =>
    `<div class="byline">By ${pick(r, ['Jane Doe', 'Sam Roe'])} on March ${1 + Math.floor(r() * 27)}, 2024</div>`,
  (r) => `<p class="read-time">${3 + Math.floor(r() * 9)} min read</p>`,
  (r) =>
    `<time datetime="2024-0${1 + Math.floor(r() * 9)}-1${Math.floor(r() * 9)}">March ${1 + Math.floor(r() * 27)}</time>`,
  () =>
    `<div class="share-buttons"><a href="#">Share</a><a href="#">Tweet</a><button>Copy link</button></div>`,
  () =>
    `<div class="newsletter"><h3>Subscribe</h3><form><input type="email"><button>Go</button></form></div>`,
  (r) =>
    `<aside class="related"><h3>Related</h3><ul><li><a href="/a">${words(r, 3)}</a></li><li><a href="/b">${words(r, 3)}</a></li></ul></aside>`,
  (r) => `<div class="comments" id="comments"><h3>Comments</h3><p>${sentence(r)}</p></div>`,
  (r) => `<div style="display:none"><p>${sentence(r)}</p></div>`,
  (r) => `<div hidden>${sentence(r)}</div>`,
  (r) => `<div class="advertisement"><a href="/buy">Buy ${words(r, 2)} now</a></div>`,
  () => `<nav><a href="/">Home</a> <a href="/about">About</a> <a href="/blog">Blog</a></nav>`,
  (r) => `<details><summary>${words(r, 2)}</summary><p>${sentence(r)}</p></details>`,
  () => `<hr>`,
  (r) => `<p>${sentence(r)}<br>${sentence(r)}</p>`,
  (r) =>
    `<div class="callout" data-callout="note"><div class="callout-content"><p>${sentence(r)}</p></div></div>`,
  (r) => `<iframe src="https://www.youtube.com/embed/abc${Math.floor(r() * 9)}"></iframe>`,
  (r) => `<p>${'word '.repeat(5 + Math.floor(r() * 5))}</p>`,
  (r) => `<span>${words(r, 2)}</span> loose text ${words(r, 2)}`,
  (r) => `<ruby>\u6f22<rt>kan</rt></ruby> ${sentence(r)}`,
  (r) =>
    `<p dir="rtl">\u0645\u0631\u062d\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645 ${sentence(r)}</p>`
]

const SOUP = [
  '<div>',
  '</div>',
  '<span>',
  '</span>',
  '<b>',
  '</b>',
  '<i>',
  '</i>',
  '<p>',
  '</p>',
  '<a href="/s">',
  '</a>',
  '<br>',
  '<li>',
  '<td>',
  '</tr>',
  '</table>',
  '<!-- c -->',
  '&amp;',
  '&nbsp;',
  '\u00a0',
  '<font>',
  '</font>',
  '<center>',
  '</center>',
  '<my-el>',
  '</my-el>'
]

const HEADS = [
  (r) => `<title>${words(r, 4)}</title>`,
  (r) =>
    `<title>${words(r, 3)} | Example Blog</title><meta name="description" content="${sentence(r)}">`,
  (r) =>
    `<title>${words(r, 3)}</title><meta property="og:title" content="${words(r, 4)}"><meta property="og:site_name" content="Example"><meta property="og:image" content="/og.png">`,
  (r) =>
    `<title>${words(r, 3)}</title><meta name="author" content="Jane Doe"><meta property="article:published_time" content="2024-0${1 + Math.floor(r() * 9)}-05T10:00:00Z">`,
  (r) =>
    `<title>${words(r, 3)}</title><script type="application/ld+json">{"@type":"Article","headline":"${words(r, 4)}","author":{"@type":"Person","name":"Sam Roe"},"datePublished":"2023-11-0${1 + Math.floor(r() * 9)}"}</script>`,
  (r) =>
    `<title>${words(r, 3)}</title><link rel="canonical" href="/canon/${words(r, 1)}"><meta name="twitter:creator" content="@sam">`
]

const WRAPS = [
  (body) => `<article>${body}</article>`,
  (body) => `<main>${body}</main>`,
  (body) => `<div class="post-content">${body}</div>`,
  (body) => `<div class="content"><div class="entry">${body}</div></div>`,
  (body) => `<div>${body}</div>`,
  (body) => body
]

function page(random) {
  const head = pick(random, HEADS)(random)
  const count = 3 + Math.floor(random() * 10)
  let body = ''
  for (let i = 0; i < count; i += 1) {
    body += pick(random, BLOCKS)(random)
    if (random() < 0.25) body += pick(random, SOUP)
  }
  const chrome = random() < 0.5 ? `<header><a href="/">Site</a></header>` : ''
  const footer = random() < 0.5 ? `<footer><p>\u00a9 2024 Example</p></footer>` : ''
  const wrapped = pick(random, WRAPS)(body)
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">${head}</head><body>${chrome}${wrapped}${footer}</body></html>`
}

export async function articleFuzzVectors(count, seed = 0x3543a1) {
  const random = rng(seed)
  const now = '2025-03-04T05:06:07.000Z'
  const out = []
  for (let i = 0; i < count; i += 1) {
    const html = page(random)
    const url = `https://fuzz.example.org/posts/${i}`
    const expected = JSON.parse(JSON.stringify(await extractFromHtml(html, url, { now })))
    out.push({ input: { html, url, now }, expected })
  }
  return out
}
