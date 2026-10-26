// Single-family pages for the element handlers of stage 3: each footnote markup, code block
// highlighter and image wrapper on its own, plus the few combinations that change a branch.
import {
  codeFamilies,
  footnoteFamilies,
  footnotePage,
  imageFamilies,
  mathFamilies,
  rawLatexPages,
  rawLatexScripts
} from './element-families.mjs'
import { page, prose, words } from './removal-pages.mjs'

const body = (html) => page(`${prose(1)}${html}${prose(1)}`)

export const elementCases0 = [
  ...Object.keys(footnoteFamilies).map((family) => ({
    name: `fn-${family}`,
    html: body(footnotePage(family, 3))
  })),
  ...['markdownIt', 'wikipedia', 'substack', 'fnColon'].map((family) => ({
    name: `fn-${family}-single`,
    html: body(footnotePage(family, 1))
  })),
  ...['markdownIt', 'wikipedia', 'pandoc', 'looseHr'].map((family) => ({
    name: `fn-${family}-repeat-ref`,
    html: body(footnotePage(family, 2, { extraRefs: true }))
  })),
  {
    name: 'fn-ref-in-span-text',
    html: body(
      `<p>Text <span>before<sup id="fnref:1"><a href="#fn:1">1</a></sup></span> and <span><sup id="fnref:2"><a href="#fn:2">2</a></sup></span> end</p>` +
        `<div class="footnotes"><ol><li id="fn:1"><p>One <a href="#fnref:1">\u21a9</a></p></li><li id="fn:2"><p>Two</p></li></ol></div>`
    )
  },
  {
    name: 'fn-multi-paragraph-note',
    html: body(
      `<p>Text<sup id="fnref:1"><a href="#fn:1">1</a></sup></p><div class="footnotes"><ol>` +
        `<li id="fn:1"><p>First para.</p><p></p><p>Second para <a href="#fnref:1">\u21a9</a></p><blockquote>Quote</blockquote></li></ol></div>`
    )
  },
  {
    name: 'fn-block-note',
    html: body(
      `<p>Text<sup id="fnref:1"><a href="#fn:1">1</a></sup></p><div class="footnotes"><ol>` +
        `<li id="fn:1"><div>Block child note</div><ul><li>a</li></ul></li></ol></div>`
    )
  },
  {
    name: 'fn-multiple-backrefs',
    html: body(
      `<p>A<sup id="fnref:1"><a href="#fn:1">1</a></sup> B<sup id="fnref:1:1"><a href="#fn:1">1</a></sup></p>` +
        `<div class="footnotes"><ol><li id="fn:1">Note <a href="#fnref:1">^</a> <a href="#fnref:1:1">^</a></li></ol></div>`
    )
  },
  {
    name: 'fn-unmatched-fragment',
    html: body(
      `<p>A <a href="#x1">1</a> and B <a href="#x2">[2]</a><sup>3</sup></p>` +
        `<ol class="footnotes"><li id="x1">Alpha</li><li id="x2">Beta</li><li id="3">Gamma</li></ol>`
    )
  },
  {
    name: 'fn-orphan-notes',
    html: body(
      `<p>No references here at all.</p><div class="footnotes"><ol><li id="fn:1">Lonely</li></ol></div><hr><hr>`
    )
  },
  {
    name: 'fn-external-section',
    html:
      `<!DOCTYPE html><html><head><title>T</title></head><body><article>${prose(2)}<p>x<sup id="fnref:1"><a href="#fn:1">1</a></sup></p></article>` +
      `<div class="footnotes"><h2>Footnotes</h2><ol><li id="fn:1">Outside</li></ol></div></body></html>`
  },
  ...Object.keys(codeFamilies).map((name) => ({
    name: `code-${name}`,
    html: body(`<p>${words(20)}</p>${codeFamilies[name]()}<p>${words(20, 2)}</p>`)
  })),
  {
    name: 'code-siblings-chrome',
    html: body(
      `<div><span>file.js</span><div><pre><code class="language-js">a()</code></pre></div><div>Copy</div><p>keep</p></div>`
    )
  },
  {
    name: 'code-in-callout',
    html: body(
      `<div data-callout="note"><div><span>Title</span></div><pre><code>x</code></pre><span>more</span></div>`
    )
  },
  {
    name: 'code-bare-language-class',
    html: body(
      `<pre class="rust nohighlight"><code>fn a() {}</code></pre><pre class="lang-ts"><code>let a</code></pre>`
    )
  },
  {
    name: 'code-lang-patterns',
    html: body(
      [
        'javascript-code',
        'code-go',
        'syntax-sql',
        'code-snippet__php',
        'highlight-yaml',
        'zig-snippet',
        'brush-cpp',
        'language-nope'
      ]
        .map((c) => `<pre class="${c}"><code>x</code></pre>`)
        .join('')
    )
  },
  ...Object.keys(imageFamilies).map((name) => ({
    name: `img-${name}`,
    html: body(`<p>${words(20)}</p>${imageFamilies[name]()}<p>${words(20, 2)}</p>`)
  })),
  {
    name: 'img-several-in-figure',
    html: body(
      `<figure><img src="/a.jpg" alt=""><img src="/b.jpg" alt="Second"><figcaption>A figure holding two images at once.</figcaption></figure>`
    )
  },
  {
    name: 'img-latex-alt',
    html: body(`<p>Inline <img src="/eq.png" alt="\\alpha + \\beta"> math</p>`)
  }
]

const supRef = (n) => `<sup id="fnref:${n}"><a href="#fn:${n}">${n}</a></sup>`
const wrapCode = (levels) => {
  let html = `<pre><code class="language-js">run()</code></pre>`
  for (let i = 1; i <= levels; i += 1)
    html = `<div class="w${i}"><span>chrome ${i}</span>${html}</div>`
  return html
}
const genericRefs = (total, matching) => {
  const refs = Array.from({ length: total }, (_, i) => {
    const n = i + 1
    return `<a href="#note${i < matching ? n : n + 100}">${n}</a>`
  }).join(' ')
  const notes = Array.from(
    { length: matching },
    (_, i) => `<p id="note${i + 1}">${i + 1}. Note ${i + 1} text.</p>`
  ).join('')
  return `<p>${words(20)} ${refs} ${words(20, 3)}</p><div class="notes">${notes}</div>`
}

const wordLetters = (count) =>
  `<p>${words(20)}${Array.from({ length: count }, (_, i) => `<a href="#_ftn${i + 1}" name="_ftnref${i + 1}">[${'i'.repeat(i + 1)}]</a>`).join(' and ')} ${words(10, 2)}</p>` +
  `<div>${Array.from({ length: count }, (_, i) => `<p><a href="#_ftnref${i + 1}" name="_ftn${i + 1}">[${'i'.repeat(i + 1)}]</a> Word note ${i + 1}.</p>`).join('')}</div>`

export const elementBoundaryCases = [
  { name: 'fn-word-letters-1', html: body(wordLetters(1)) },
  { name: 'fn-word-letters-2', html: body(wordLetters(2)) },
  { name: 'fn-word-letters-3', html: body(wordLetters(3)) },
  ...[1, 2, 3].map((n) => ({
    name: `fn-trailing-notes-${n}`,
    html: page(prose(1) + footnotePage('looseTrailing', n))
  })),
  ...[1, 2, 3].map((n) => ({
    name: `fn-trailing-hr-${n}`,
    html: page(prose(1) + footnotePage('looseHr', n))
  })),
  { name: 'fn-generic-ratio-7-of-10', html: body(genericRefs(10, 7)) },
  { name: 'fn-generic-ratio-8-of-10', html: body(genericRefs(10, 8)) },
  { name: 'fn-generic-ratio-2-of-3', html: body(genericRefs(3, 2)) },
  { name: 'fn-generic-ratio-3-of-4', html: body(genericRefs(4, 3)) },
  { name: 'fn-looseTrailing-2', html: body(footnotePage('looseTrailing', 2)) },
  { name: 'fn-looseHr-2', html: body(footnotePage('looseHr', 2)) },
  { name: 'fn-looseHr-1', html: body(footnotePage('looseHr', 1)) },
  { name: 'fn-word-2', html: body(footnotePage('word', 2)) },
  { name: 'fn-word-1', html: body(footnotePage('word', 1)) },
  { name: 'fn-google-2', html: body(footnotePage('google', 2)) },
  { name: 'fn-google-1', html: body(footnotePage('google', 1)) },
  { name: 'fn-genericAnchors-2', html: body(footnotePage('genericAnchors', 2)) },
  { name: 'fn-genericAnchors-1', html: body(footnotePage('genericAnchors', 1)) },
  { name: 'fn-classFootnote-1', html: body(footnotePage('classFootnote', 1)) },
  {
    name: 'fn-backref-sup-with-sibling',
    html: body(
      `<p>A${supRef(1)}</p><div class="footnotes"><ol><li id="fn:1"><p>Note <sup><a href="#fnref:1">\u21a9</a><b>x</b></sup> end</p></li></ol></div>`
    )
  },
  {
    name: 'fn-backref-text-nodes',
    html: body(
      `<p>A${supRef(1)}</p><div class="footnotes"><ol><li id="fn:1">^ , Bare text <a href="#fnref:1">\u21a9</a> ; . </li></ol></div>`
    )
  },
  {
    name: 'fn-big-number',
    html: body(
      `<p>A<sup>1234567890123456</sup> B<sup>2</sup></p><hr><p><sup>1234567890123456</sup> Big</p><p><sup>2</sup> Two</p>`
    )
  },
  ...[5, 6, 7].map((count) => ({
    name: `code-header-${count}-words`,
    html: body(
      `<div class="code-block"><pre><div class="code-header">${'w '.repeat(count)}</div><code>x = 1</code></pre></div>`
    )
  })),
  ...[3, 4, 5, 6].map((siblings) => ({
    name: `code-container-${siblings}-siblings`,
    html: body(
      `<div>${Array.from({ length: siblings - 1 }, (_, i) => `<span>s${i}</span>`).join('')}<pre><code>y</code></pre></div>`
    )
  })),
  ...[1, 2, 3, 4].map((levels) => ({
    name: `code-chrome-levels-${levels}`,
    html: body(wrapCode(levels))
  })),
  ...[5, 6, 7].map((n) => ({
    name: `code-sibling-words-${n}`,
    html: body(`<div><div>${'a '.repeat(n)}</div><pre><code>z</code></pre></div>`)
  })),
  ...[5, 6].map((n) => ({
    name: `img-uni-caption-${n}`,
    html: body(
      `<uni-image-full-width><figure><img src="/p.png" data-loading='{"desktop":"https://x.test/d.jpg"}'><figcaption>${'c'.repeat(n)}</figcaption></figure></uni-image-full-width>`
    )
  })),
  ...[9, 10, 11].map((n) => ({
    name: `img-caption-${n}`,
    html: body(
      `<figure><img src="/p.jpg" alt="x"><figcaption>${'c'.repeat(n)}</figcaption></figure>`
    )
  })),
  {
    name: 'img-picture-resolution-tie',
    html: body(
      `<picture><source media="(min-width:1px)" srcset="/first.jpg 400w"><source media="(min-width:2px)" srcset="/second.jpg 400w"><img alt="tie"></picture>`
    )
  },
  {
    name: 'img-picture-dpr',
    html: body(
      `<picture><source media="(min-width:1px)" srcset="/a.jpg 400w dpr=2"><source media="(min-width:2px)" srcset="/b.jpg 700w"><img alt="dpr"></picture>`
    )
  },
  {
    name: 'img-srcset-second-comma',
    html: body(
      `<picture><source srcset="data:image/svg+xml,x 1x, https://cdn.test/a,b.webp 2x"><img alt="c"></picture>`
    )
  }
]

const mathCases = [
  ...Object.keys(mathFamilies).map((name) => ({
    name: `math-${name}`,
    html: body(`<p>${words(20)}</p>${mathFamilies[name]()}<p>${words(20, 2)}</p>`)
  })),
  ...Object.keys(mathFamilies).map((name) => ({
    name: `math-inline-${name}`,
    html: body(`<p>Inline ${words(5)} ${mathFamilies[name]()} and ${words(5, 2)}.</p>`)
  })),
  ...Object.keys(mathFamilies).map((name) => ({
    name: `math-div-${name}`,
    html: body(`<div>${mathFamilies[name]()}</div>`)
  })),
  ...[
    ['class-display', `<span class="eq-display" data-latex="a">a</span>`],
    ['class-block', `<span class="blockeq" data-latex="b">b</span>`],
    ['class-upper', `<span class="DISPLAY" data-latex="c">c</span>`],
    ['attr-true', `<span display="true" data-latex="d">d</span>`],
    ['attr-false', `<span display="false" data-latex="e">e</span>`],
    ['attr-block', `<span display="block" data-latex="f">f</span>`],
    ['ancestor-true', `<div display="true"><span data-latex="g">g</span></div>`],
    ['ancestor-false', `<div display="false"><span data-latex="h">h</span></div>`],
    ['data-display', `<div data-display="block"><span data-latex="i">i</span></div>`],
    ['katex-display-ancestor', `<span class="katex-display"><span class="katex">k</span></span>`],
    [
      'katex-inline-only',
      `<span class="katex"><span class="katex-mathml"><math><mi>j</mi></math></span></span>`
    ],
    [
      'mathjax-display-ancestor',
      `<div class="MathJax_Display"><span data-latex="l">l</span></div>`
    ],
    ['mwe-display', `<span class="mwe-math-fallback-image-display" data-latex="m">m</span>`],
    ['script-display', `<script type="math/tex; mode=display">n</script>`],
    ['after-heading', `<h3>Head</h3><span data-latex="o">o</span>`]
  ].map(([name, html]) => ({ name: `math-display-${name}`, html: body(`<div>${html}</div>`) })),
  ...Object.entries(rawLatexPages).flatMap(([name, html]) =>
    Object.entries(rawLatexScripts).map(([scriptName, script]) => ({
      name: `math-raw-${name}-${scriptName}`,
      html: page(`${prose(1)}${html}${prose(1)}`, { head: script })
    }))
  ),
  {
    name: 'math-raw-with-rendered',
    html: page(`${prose(1)}<p>$\\alpha$</p>${mathFamilies.plainMathml()}`, {
      head: rawLatexScripts.src
    })
  },
  {
    name: 'math-raw-script-in-body',
    html: page(`${prose(1)}<p>$\\alpha$ and \\(b\\)</p>${rawLatexScripts.src}`)
  }
]

export const elementCases = [...elementCases0, ...elementBoundaryCases, ...mathCases]
