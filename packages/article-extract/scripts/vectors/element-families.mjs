// Markup families for the element handlers of stage 3 (footnotes, code blocks, images): each
// builds the references and the notes of one site's footnote markup, one code block of one
// highlighter, or one image wrapper. The cases (`element-cases.mjs`) use each family on its own;
// the fuzz (`elements-fuzz.mjs`) shuffles and mixes them.
import { words } from './removal-pages.mjs'

const note = (n) => `Note number ${n} about ${words(6, n)}.`
const nums = (count) => Array.from({ length: count }, (_, i) => i + 1)

/** Footnote families: `refs(n)` is the inline reference, `defs(count)` the notes block. */
export const footnoteFamilies = {
  markdownIt: {
    refs: (n) => `<sup class="footnote-ref"><a href="#fn${n}" id="fnref${n}">[${n}]</a></sup>`,
    defs: (c) =>
      `<hr class="footnotes-sep"><section class="footnotes"><ol class="footnotes-list">${nums(c)
        .map(
          (n) =>
            `<li id="fn${n}" class="footnote-item"><p>${note(n)} <a href="#fnref${n}" class="footnote-backref">\u21a9\ufe0e</a></p></li>`
        )
        .join('')}</ol></section>`
  },
  wikipedia: {
    refs: (n) =>
      `<sup id="cite_ref-${n}" class="reference"><a href="#cite_note-${n}">[${n}]</a></sup>`,
    defs: (c) =>
      `<ol class="references">${nums(c)
        .map(
          (n) =>
            `<li id="cite_note-${n}"><span class="mw-cite-backlink"><a href="#cite_ref-${n}">^</a></span> <span class="reference-text">${note(n)}</span></li>`
        )
        .join('')}</ol>`
  },
  wikipediaMulti: {
    refs: (n) =>
      `<sup id="cite_ref-a_${n}-0" class="reference"><a href="/wiki/Page#cite_note-a-${n}">[${n}]</a></sup>`,
    defs: (c) =>
      `<ol class="references">${nums(c)
        .map(
          (n) =>
            `<li id="cite_note-a-${n}"><span class="mw-cite-backlink"><a href="#cite_ref-a_${n}-0">a</a> <a href="#cite_ref-a_${n}-1">b</a></span> <span class="reference-text">${note(n)}</span></li>`
        )
        .join('')}</ol>`
  },
  gutenberg: {
    refs: (n) =>
      `<a name="FNanchor_${n}" id="FNanchor_${n}"></a><a href="#Footnote_${n}" class="fnanchor">[${n}]</a>`,
    defs: (c) =>
      nums(c)
        .map(
          (n) =>
            `<div class="footnote"><p><a name="Footnote_${n}" id="Footnote_${n}"></a><a href="#FNanchor_${n}"><span class="label">[${n}]</span></a> ${note(n)}</p></div>`
        )
        .join('')
  },
  substack: {
    refs: (n) =>
      `<a id="footnote-anchor-${n}" class="footnote-anchor" href="#footnote-${n}">${n}</a>`,
    defs: (c) =>
      nums(c)
        .map(
          (n) =>
            `<div class="footnote" data-component-name="FootnoteToDOM"><a id="footnote-${n}" href="#footnote-anchor-${n}" class="footnote-number">${n}</a><div class="footnote-content"><p>${note(n)}</p></div></div>`
        )
        .join('')
  },
  wikidot: {
    refs: (n) =>
      `<sup class="footnoteref"><a id="footnoteref-${n}" href="javascript:;">${n}</a></sup>`,
    defs: (c) =>
      `<div class="footnotes-footer">${nums(c)
        .map(
          (n) =>
            `<div class="footnote-footer" id="footnote-${n}"><a href="javascript:;">${n}</a>. ${note(n)}</div>`
        )
        .join('')}</div>`
  },
  mdBook: {
    refs: (n) =>
      `<sup class="footnote-reference" id="fr-${n}-1"><a href="#footnote-${n}">${n}</a></sup>`,
    defs: (c) =>
      nums(c)
        .map(
          (n) =>
            `<div class="footnote-definition" id="footnote-${n}"><sup class="footnote-definition-label">${n}</sup><p>${note(n)}</p></div>`
        )
        .join('')
  },
  hugo: {
    refs: (n) => `<sup id="footnote-reference-${n}"><a href="#footnote-${n}">${n}</a></sup>`,
    defs: (c) =>
      `<div class="footnotes"><div class="footnote-definitions">${nums(c)
        .map(
          (n) =>
            `<div class="footnote-definition"><sup id="footnote-${n}"><a href="#footnote-reference-${n}">${n}</a></sup><div class="footnote-body"><p>${note(n)}</p></div></div>`
        )
        .join('')}</div></div>`
  },
  easy: {
    refs: (n) =>
      `<span class="easy-footnote"><a href="#easy-footnote-bottom-${n}-1" title="x">${n}</a></span><span class="easy-footnote-margin-adjust"></span>`,
    defs: (c) =>
      `<ol class="easy-footnotes-wrapper">${nums(c)
        .map(
          (n) =>
            `<li class="easy-footnote-single"><span id="easy-footnote-bottom-${n}-1"></span>${note(n)}<a class="easy-footnote-to-top" href="#easy-footnote-${n}-1"></a></li>`
        )
        .join('')}</ol>`
  },
  texinfo: {
    refs: (n) => `<a class="footnote" id="DOCF${n}" href="#FOOT${n}">(${n})</a>`,
    defs: (c) =>
      `<div class="footnotes-segment"><h4>Footnotes</h4>${nums(c)
        .map(
          (n) =>
            `<h5 class="footnote-body-heading"><a id="FOOT${n}" href="#DOCF${n}">(${n})</a></h5><p>${note(n)}</p>`
        )
        .join('')}</div>`
  },
  science: {
    refs: (n) => `<a role="doc-biblioref" href="#core-R${n}" data-xml-rid="">${n}</a>`,
    defs: (c) =>
      `<section role="doc-bibliography"><ol>${nums(c)
        .map(
          (n) =>
            `<li><div class="citations" id="r${n}"><div class="citation-content">${note(n)}</div></div></li>`
        )
        .join('')}</ol></section>`
  },
  nature: {
    refs: (n) => `<a id="ref-link-section-d1e${n}" href="#ref-${n}">${n}</a>`,
    defs: (c) =>
      `<ol class="article-references">${nums(c)
        .map((n) => `<li data-counter="${n}."><p>${note(n)}</p></li>`)
        .join('')}</ol>`
  },
  arxiv: {
    refs: (n) =>
      `<cite class="ltx_cite ltx_citemacro_cite">[<a href="#bib.bib${n}" class="ltx_ref">${n}</a>, <a href="#bib.bib${n + 1}" class="ltx_ref">${n + 1}</a>]</cite>`,
    defs: (c) =>
      `<ul class="ltx_biblist">${nums(c + 1)
        .map((n) => `<li id="bib.bib${n}" class="ltx_bibitem">${note(n)}</li>`)
        .join('')}</ul>`
  },
  oreilly: {
    refs: (n) => `<a data-type="noteref" id="ch1fn${n}-marker" href="ch01.html#ch1fn${n}">${n}</a>`,
    defs: (c) =>
      nums(c)
        .map(
          (n) =>
            `<p data-type="footnote" id="ch1fn${n}"><sup><a href="#ch1fn${n}-marker">${n}</a></sup> ${note(n)}</p>`
        )
        .join('')
  },
  word: {
    refs: (n) => `<a href="#_ftn${n}" name="_ftnref${n}">[${n}]</a>`,
    defs: (c) =>
      `<div>${nums(c)
        .map(
          (n) =>
            `<div id="ftn${n}"><p><a href="#_ftnref${n}" name="_ftn${n}">[${n}]</a> ${note(n)}</p></div>`
        )
        .join('')}</div>`
  },
  google: {
    refs: (n) => `<sup><a href="#ftnt${n}" id="ftnt_ref${n}">[${n}]</a></sup>`,
    defs: (c) =>
      `<h2>Footnotes</h2>${nums(c)
        .map((n) => `<div><p id="ftnt${n}"><a href="#ftnt_ref${n}">[${n}]</a> ${note(n)}</p></div>`)
        .join('')}`
  },
  genericAnchors: {
    refs: (n) => `<a href="#note${n}">${n}</a>`,
    defs: (c) =>
      `<div class="notes">${nums(c)
        .map((n) => `<p id="note${n}">${n}. ${note(n)}</p>`)
        .join('')}</div>`
  },
  looseHr: {
    refs: (n) => `<sup>${n}</sup>`,
    defs: (c) =>
      `<hr>${nums(c)
        .map((n) => `<p><sup>${n}</sup> ${note(n)}</p>`)
        .join('')}`
  },
  looseTrailing: {
    refs: (n) => `<sup>${n}</sup>`,
    defs: (c) =>
      `<h2>Notes</h2>${nums(c)
        .map((n) => `<p><strong>${n}</strong> ${note(n)}</p>`)
        .join('')}`
  },
  labeled: {
    refs: (n) => `<sup>${n}</sup>`,
    defs: (c) =>
      `<div class="post-footnotes"><h3>Footnotes</h3>${nums(c)
        .map((n) => `<p><sup>${n}</sup> ${note(n)}</p><ul><li>extra</li></ul>`)
        .join('')}</div>`
  },
  classFootnote: {
    refs: (n) => `<sup>${n}</sup>`,
    defs: (c) =>
      nums(c)
        .map((n) => `<p class="footnote"><sup>${n}</sup> ${note(n)}</p>`)
        .join('')
  },
  sidenoteContainer: {
    refs: (n) =>
      `<span class="sidenote-container">word<span class="sidenote">${note(n)}</span></span>`,
    defs: () => ''
  },
  orgSidenote: {
    refs: (n) =>
      `<label class="footref" for="fr${n}">${n}</label><input type="checkbox" class="footref-toggle" id="fr${n}"><span class="sidenote"><sup>${n}</sup>${note(n)}</span>`,
    defs: () => '<footer><div class="footdef">x</div></footer>'
  },
  sidenoteColumn: {
    refs: (n) => `<sup><a href="#sn-${n}">${n}</a></sup>`,
    defs: (c) =>
      `<aside class="sidenotes-column">${nums(c)
        .map(
          (n) =>
            `<div class="sidenote" id="sn-${n}"><span class="sidenote__id">${n}</span><span class="sidenote__label">x</span>${note(n)}<a class="sn-backref" href="#r">^</a></div>`
        )
        .join('')}</aside>`
  },
  asideOl: {
    refs: (n) => `<sup>${n}</sup>`,
    defs: (c) =>
      nums(c)
        .map((n) => `<aside><ol start="${n}"><li>${note(n)}</li></ol></aside>`)
        .join('')
  },
  hiddenAside: {
    refs: (n) => `<span data-definition="def${n}"><a href="#">*</a></span>`,
    defs: (c) =>
      nums(c)
        .map((n) => `<aside style="display:none" id="def${n}">${note(n)}</aside>`)
        .join('')
  },
  lesswrong: {
    refs: (n) =>
      `<span class="footnote-reference" data-footnote-reference="" data-footnote-index="${n}" data-footnote-id="fn${n}" role="doc-noteref" id="fnref${n}"><a href="#fn${n}">[${n}]</a></span>`,
    defs: (c) =>
      `<section class="footnotes" data-footnote-section="" role="doc-endnotes"><ol>${nums(c)
        .map(
          (n) =>
            `<li class="footnote-item" data-footnote-item="" data-footnote-index="${n}" data-footnote-id="fn${n}" role="doc-endnote" id="fn${n}"><div class="footnote-content" data-footnote-content=""><p>${note(n)}</p></div><span class="footnote-back-link" data-footnote-back-link="" data-footnote-id="fn${n}"><a href="#fnref${n}">^</a></span></li>`
        )
        .join('')}</ol></section>`
  },
  pandoc: {
    refs: (n) =>
      `<a href="#fn${n}" class="footnote-ref" id="fnref${n}" role="doc-noteref"><sup>${n}</sup></a>`,
    defs: (c) =>
      `<section class="footnotes" role="doc-endnotes"><hr><ol>${nums(c)
        .map(
          (n) =>
            `<li id="fn${n}"><p>${note(n)}<a href="#fnref${n}" class="footnote-back" role="doc-backlink">\u21a9\ufe0e</a></p></li>`
        )
        .join('')}</ol></section>`
  },
  fnColon: {
    refs: (n) => `<sup id="fnref:${n}"><a href="#fn:${n}" class="footnote">${n}</a></sup>`,
    defs: (c) =>
      `<div class="footnotes"><ol>${nums(c)
        .map(
          (n) =>
            `<li id="fn:${n}"><p>${note(n)}&nbsp;<a href="#fnref:${n}" class="reversefootnote">&#8617;</a></p></li>`
        )
        .join('')}</ol></div>`
  }
}

/** Page body: prose with the references of a family, then its notes. */
export function footnotePage(family, count = 3, { extraRefs = false } = {}) {
  const f = footnoteFamilies[family]
  let body = ''
  for (const n of nums(count)) {
    body += `<p>${words(30, n)}${f.refs(n)} and ${words(12, n + 3)}.${extraRefs && n === 1 ? f.refs(n) : ''}</p>`
  }
  return body + f.defs(count)
}

/** Code families: one code block of one highlighter. */
export const codeFamilies = {
  plainPre: () => `<pre>line one\n\tindented line\n\nline three</pre>`,
  preCodeLang: () =>
    `<pre><code class="language-python">def f(x):\n    return x * 2\n\n\nprint(f(3))\n</code></pre>`,
  hljs: () =>
    `<pre><code class="hljs language-js"><span class="hljs-keyword">const</span> a = <span class="hljs-number">1</span>;\n<span class="hljs-built_in">console</span>.log(a)</code></pre>`,
  prism: () =>
    `<div class="prismjs"><pre class="language-rust"><code class="language-rust"><span class="token keyword">fn</span> main() {}</code></pre></div>`,
  shiki: () =>
    `<pre class="shiki github-dark" style="background:#000"><code><span class="line"><span>let</span> <span>x</span></span>\n<span class="line"><span>x += 1</span></span></code></pre>`,
  ghHighlight: () =>
    `<div class="highlight highlight-source-shell"><pre>npm install\nnpm test</pre><button class="copy">Copy</button></div>`,
  syntaxHighlighter: () =>
    `<div class="syntaxhighlighter nogutter javascript"><table><tbody><tr><td class="code"><div class="container"><div class="line number1 index0 alt2"><code class="javascript keyword">var</code> <code class="javascript plain">x</code></div><div class="line number2 index1 alt1"><code class="javascript spaces">    </code><code class="javascript plain">y</code></div></div></td></tr></tbody></table></div>`,
  wpBlockCode: () =>
    `<div class="wp-block-syntaxhighlighter-code"><pre class="brush: php; title: ; notranslate"><code>echo 1;</code></pre></div>`,
  wpCode: () => `<pre class="wp-block-code"><code>a = 1\nb = 2</code></pre>`,
  langDataAttr: () => `<pre data-lang="Go"><code>fmt.Println("x")</code></pre>`,
  langOnParent: () => `<div class="language-bash"><pre><code>echo hi</code></pre></div>`,
  chromaTable: () =>
    `<div class="highlight"><table class="lntable"><tbody><tr><td class="lntd"><pre class="chroma"><code><span class="lnt">1\n</span><span class="lnt">2\n</span></code></pre></td><td class="lntd"><pre class="chroma"><code class="language-go" data-lang="go"><span class="line"><span class="cl">a := 1\n</span></span><span class="line"><span class="cl">b := 2\n</span></span></code></pre></td></tr></tbody></table></div>`,
  rouge: () =>
    `<div class="language-ruby highlighter-rouge"><div class="highlight"><table class="rouge-table"><tbody><tr><td class="rouge-gutter gl"><pre class="lineno">1\n2\n</pre></td><td class="rouge-code"><pre>puts 1\nputs 2</pre></td></tr></tbody></table></div></div>`,
  lineNumbers: () =>
    `<pre><code><span class="lineno">1</span>first\n<span class="lineno">2</span>second\n</code></pre>`,
  gutterRows: () =>
    `<pre><code><div><span>1</span><span>alpha</span></div><div><span>2</span><span>beta</span></div></code></pre>`,
  lineDivs: () =>
    `<pre><div class="line"><span class="ln">1</span><span class="code">x = 1</span></div><div class="line"><span class="ln">2</span><span class="code">y = 2</span></div></pre>`,
  lineGutter: () =>
    `<div class="code-block"><pre><div class="code-line"><span class="line-number">1</span> foo()</div><div class="code-line"><span class="line-number">2</span> bar()</div></pre></div>`,
  codeMirror: () =>
    `<pre><div><div>python</div><div class="cm-editor"><div class="cm-content"><div class="cm-line">print(1)</div><div class="cm-line">print(2)</div></div></div></div></pre>`,
  header: () =>
    `<div class="code-block"><div class="code-header"><span>bash</span><button>Copy</button></div><pre><code>ls -la</code></pre></div>`,
  versoLean: () =>
    `<code class="hl lean block"><span class="token">def</span> x := 1\n\n  <span class="token">theorem</span> t</code>`,
  versoHover: () =>
    `<pre class="hl lean lean-output"><code><span class="hover-container">hid</span>ok <span class="hover-info">tip</span></code></pre>`,
  writerside: () =>
    `<div class="code-block" data-lang="kotlin">\n  <div>\n    fun main() {\n      println(1)\n    }\n  </div>\n</div>`,
  brLines: () => `<pre><span class="line">a</span><br><span class="line">b</span><br>c<br>d</pre>`,
  styleButton: () => `<pre><code>x<style>.a{}</style><button>Copy</button>y</code></pre>`,
  nestedCode: () => `<code><pre><code class="language-sh">ls</code></pre></code>`,
  tabsNbsp: () => `<pre>\ta\u00a0b\n\t\tc</pre>`,
  empty: () => `<pre></pre>`
}

/** Image families: one image wrapper. */
export const imageFamilies = {
  lazyDataSrc: () =>
    `<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/img/photo-1.jpg" class="lazy lazyload" loading="lazy" alt="One">`,
  lazyDataSrcset: () =>
    `<img data-srcset="/img/a-480.jpg 480w, /img/a-800.jpg 800w" data-src="/img/a.jpg" alt="Two" data-ll-status="loaded">`,
  lazyOtherAttr: () =>
    `<img src="/ph.png" data-original="https://cdn.example.com/real.png" data-lazy-srcset="https://cdn.example.com/r1.png 1x, https://cdn.example.com/r2.png 2x" alt="Three">`,
  lazyJsonAttr: () =>
    `<img class="lazy" data-attrs='{"src":"https://x.test/a.png"}' data-x="[1]" alt="Four">`,
  svgPlaceholder: () =>
    `<img src="data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%3E%3C/svg%3E" data-src="/real.webp" alt="Five">`,
  pictureWithImg: () =>
    `<picture><source srcset="/a-800.webp 800w, /a-400.webp 400w" type="image/webp"><source srcset="/a.jpg" media="(min-width:600px)"><img src="/a-fallback.jpg" alt="Six"></picture>`,
  pictureMedia: () =>
    `<picture><source media="(min-width: 800px)" srcset="/wide.jpg 800w"><source media="(min-width: 400px)" srcset="/mid.jpg 1600w 2x"><img alt="Seven"></picture>`,
  pictureNoImg: () => `<picture><source srcset="/only.webp 1x, /only2.webp 2x"></picture>`,
  pictureSubstack: () =>
    `<picture><source type="image/webp" srcset="https://cdn.test/image/fetch/$s_!Yb!,w_424,c_limit,f_webp/https%3A%2F%2Fx.test%2Fa.png 424w, https://cdn.test/image/fetch/$s_!Yb!,w_848,c_limit,f_webp/https%3A%2F%2Fx.test%2Fa.png 848w"><img src="https://cdn.test/a.png" alt="Eight"></picture>`,
  figureCaption: () =>
    `<figure><img src="/photos/lake.jpg" alt="A lake"><figcaption>The lake at dawn, photographed from the north shore.</figcaption></figure>`,
  figureShortCaption: () =>
    `<figure><img src="/photos/lake.jpg" alt="A lake"><figcaption>Lake</figcaption></figure>`,
  figureNoCaption: () => `<figure><img src="/photos/lake.jpg" alt="A lake"></figure>`,
  figureUrlCaption: () =>
    `<figure><img src="/p.jpg" alt="x"><figcaption>https://example.com/original/photo.jpg</figcaption></figure>`,
  figureNestedCaption: () =>
    `<figure><picture><source srcset="/c.webp"><img src="/c.jpg" alt="x"></picture><figcaption><span>Credit:</span> <em>Someone Famous</em> and <span>Credit:</span></figcaption></figure>`,
  figureFilenameCaption: () =>
    `<figure><img src="/p.jpg" alt="x"><figcaption>my-photo_final.jpeg</figcaption></figure>`,
  figureDateCaption: () =>
    `<figure><img src="/p.jpg" alt="x"><figcaption>2024-05-06</figcaption></figure>`,
  figureVideo: () =>
    `<figure><video src="/v.mp4"></video><figcaption>A short video clip of the process.</figcaption></figure>`,
  spanImageCaption: () =>
    `<span class="img-wrap"><img src="/s.jpg" alt="Span image"><em>A reasonably long caption in emphasis</em></span>`,
  spanImageBlock: () => `<span><p>Paragraph in span</p><img src="/s.jpg" alt="Block child"></span>`,
  spanPlainImage: () => `<span><img src="/s.jpg" alt="Alone"></span>`,
  captionParagraph: () =>
    `<p><img src="/c.jpg" alt="Cap"><span class="image-caption">Photo caption text goes here</span></p>`,
  captionSibling: () =>
    `<div><figure><img src="/c.jpg" alt=""></figure><div class="caption-text">Caption sitting next to the figure</div></div>`,
  captionAria: () =>
    `<figure><img src="/c.jpg" alt=""><div aria-label="Described by aria label here"></div><div title="Titled element with title"> </div></figure>`,
  uniImage: () =>
    `<uni-image-full-width alt-text="Wide shot"><figure><img src="/placeholder.png" data-loading='{"desktop":"https://x.test/desktop.jpg","mobile":"https://x.test/m.jpg"}'><figcaption><div class="rich-text"><p>Rich caption with <em>markup</em></p></div></figcaption></figure></uni-image-full-width>`,
  uniImageBroken: () =>
    `<uni-image-full-width><figure><img src="/placeholder.png" data-loading="not json"></figure></uni-image-full-width>`,
  uniImageNoImg: () => `<uni-image-full-width><p>nothing</p></uni-image-full-width>`,
  trackingPixel: () => `<img src="https://t.example.com/pixel.gif" width="1" height="1" alt="">`,
  relativeSrc: () => `<img src="../images/rel.png" alt="Relative">`,
  svgImg: () => `<img src="/logo.svg" alt="Logo">`,
  noscriptLazy: () =>
    `<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" class="lazy" alt="x"><noscript><img src="/real.jpg" alt="x"></noscript>`
}
export { nums }

const mjxToken = (tag, text) =>
  `<mjx-${tag} class="mjx-n"><mjx-c class="mjx-c1D465">${text}</mjx-c></mjx-${tag}>`
const mjx = (inner, display = false) =>
  `<mjx-container class="MathJax" jax="CHTML"${display ? ' display="true"' : ''}><mjx-math class="MJX-TEX">${inner}</mjx-math></mjx-container>`
const mathml = (inner, attrs = '') =>
  `<math xmlns="http://www.w3.org/1998/Math/MathML"${attrs}>${inner}</math>`

/** Math families: one equation in one renderer's markup. */
export const mathFamilies = {
  katexInline: () =>
    `<span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mi>x</mi><mo>=</mo><mn>2</mn></mrow><annotation encoding="application/x-tex">x = 2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="base">x=2</span></span></span>`,
  katexDisplay: () =>
    `<span class="katex-display"><span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><mfrac><mn>1</mn><mn>2</mn></mfrac></mrow><annotation encoding="application/x-tex">\\frac{1}{2}</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">1/2</span></span></span>`,
  mathjaxV2Script: () =>
    `<span class="MathJax_Preview" style="color: inherit;"></span><span class="MathJax" id="MathJax-Element-1-Frame" tabindex="0"><nobr><span class="math">x</span></nobr></span><script type="math/tex" id="MathJax-Element-1">e^{i\\pi} + 1 = 0</script>`,
  mathjaxV2Display: () =>
    `<div class="MathJax_Display"><span class="MathJax">x</span></div><script type="math/tex; mode=display">\\sum_{i=1}^n i</script>`,
  mathjaxV3Assistive: () =>
    `<mjx-container class="MathJax" jax="CHTML" display="true"><mjx-math>x</mjx-math><mjx-assistive-mml unselectable="on" display="block"><math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><mi>a</mi><mo>+</mo><mi>b</mi></math></mjx-assistive-mml></mjx-container>`,
  mathjaxV3AssistiveAlt: () =>
    `<mjx-container class="MathJax"><mjx-assistive-mml><math alttext="a^2" xmlns="http://www.w3.org/1998/Math/MathML"><msup><mi>a</mi><mn>2</mn></msup></math></mjx-assistive-mml></mjx-container>`,
  mathjaxChtmlFrac: () =>
    mjx(
      `<mjx-mfrac><mjx-frac><mjx-num><mjx-nstrut></mjx-nstrut>${mjxToken('mn', '1')}</mjx-num><mjx-dbox><mjx-dtable><mjx-line></mjx-line><mjx-row><mjx-den><mjx-dstrut></mjx-dstrut>${mjxToken('mn', '2')}</mjx-den></mjx-row></mjx-dtable></mjx-dbox></mjx-frac></mjx-mfrac>`,
      true
    ),
  mathjaxChtmlSqrt: () =>
    mjx(
      `<mjx-msqrt><mjx-sqrt><mjx-surd><mjx-mo><mjx-c>\u221a</mjx-c></mjx-mo></mjx-surd><mjx-box><mjx-mrow>${mjxToken('mi', 'x')}${mjxToken('mo', '+')}${mjxToken('mn', '1')}</mjx-mrow></mjx-box></mjx-sqrt></mjx-msqrt>`
    ),
  mathjaxChtmlScripts: () =>
    mjx(
      `<mjx-msubsup>${mjxToken('mi', '\ud835\udc65')}<mjx-script><mjx-mn size="s">2</mjx-mn><mjx-mi size="s">i</mjx-mi></mjx-script></mjx-msubsup>` +
        `<mjx-msup>${mjxToken('mi', 'y')}<mjx-script>${mjxToken('mn', '3')}</mjx-script></mjx-msup>` +
        `<mjx-msub>${mjxToken('mi', 'z')}<mjx-script>${mjxToken('mi', 'k')}${mjxToken('mi', 'j')}</mjx-script></mjx-msub>`
    ),
  mathjaxChtmlLimits: () =>
    mjx(
      `<mjx-mrow><mjx-munderover><mjx-over>${mjxToken('mn', 'n')}</mjx-over><mjx-box><mjx-munder><mjx-row><mjx-base>${mjxToken('mo', '\u2211')}</mjx-base></mjx-row><mjx-row><mjx-under>${mjxToken('mi', 'i')}</mjx-under></mjx-row></mjx-munder></mjx-box></mjx-munderover>` +
        `<mjx-mover><mjx-over>${mjxToken('mo', '^')}</mjx-over><mjx-base>${mjxToken('mi', 'a')}</mjx-base></mjx-mover>` +
        `<mjx-munder><mjx-base>${mjxToken('mi', 'b')}</mjx-base><mjx-under>${mjxToken('mo', '_')}</mjx-under></mjx-munder>` +
        `<mjx-mo><mjx-c>\u2061</mjx-c></mjx-mo><mjx-mspace></mjx-mspace></mjx-mrow>`
    ),
  mathjaxChtmlTagged: () =>
    mjx(
      `<mjx-mtable><mjx-table><mjx-mlabeledtr><mjx-mtd>${mjxToken('mtext', '(1)')}</mjx-mtd><mjx-mtd>${mjxToken('mi', 'x')}${mjxToken('mo', '=')}${mjxToken('mn', '1')}</mjx-mtd></mjx-mlabeledtr></mjx-table></mjx-mtable>`,
      true
    ),
  mathjaxLazy: () => `<mjx-container class="MathJax"><mjx-lazy></mjx-lazy></mjx-container>`,
  plainMathml: () => mathml(`<mi>a</mi><mo>+</mo><mi>b</mi>`),
  plainMathmlAlttext: () =>
    mathml(`<mfrac><mi>a</mi><mi>b</mi></mfrac>`, ' alttext="\\frac{a}{b}" display="block"'),
  plainMathmlAnnotation: () =>
    mathml(
      `<semantics><mi>y</mi><annotation encoding="application/x-tex">y = mx + b</annotation></semantics>`
    ),
  plainMathmlUnicode: () => mathml(`<mi>f</mi><mo>\u2032</mo>`),
  taggedMathml: () =>
    mathml(
      `<mtable><mlabeledtr><mtd><mtext>(2)</mtext></mtd><mtd><mi>E</mi><mo>=</mo><mi>m</mi></mtd></mlabeledtr></mtable>`
    ),
  multiRowMathml: () =>
    mathml(`<mtable><mtr><mtd><mi>a</mi></mtd></mtr><mtr><mtd><mi>b</mi></mtd></mtr></mtable>`),
  dataLatex: () => `<span data-latex="\\alpha + \\beta">alpha plus beta</span>`,
  dataMath: () => `<span data-math="x^2">x squared</span>`,
  dataTex: () => `<span data-tex="n!">n factorial</span>`,
  dataMathml: () =>
    `<span data-mathml="&lt;math display=&quot;block&quot; alttext=&quot;q&quot;&gt;&lt;mi&gt;q&lt;/mi&gt;&lt;/math&gt;">q</span>`,
  hurmet: () =>
    `<span class="hurmet-tex" data-entry="\\int_0^1 x\\,dx"><math><mi>x</mi></math></span>`,
  wpLatexImg: () =>
    `<img class="latex" src="https://s0.wp.com/latex.php?latex=x%5E2%2By%5E2&amp;bg=ffffff" alt="">`,
  wpLatexImgAlt: () =>
    `<img class="latex" src="https://s0.wp.com/latex.php?latex=a" alt="x^2 + y^2">`,
  latexServiceImg: () =>
    `<p><img src="https://latex.codecogs.com/png.latex?%5Cfrac%7Ba%7D%7Bb%7D" alt="fraction"></p>`,
  latexServiceParam: () =>
    `<img src="https://chart.apis.google.com/chart?cht=tx&chl=%5Calpha%2B1" alt="">`,
  latexServicePath: () => `<img src="https://x.test/render/%5Cbeta%20%5Cgamma/img.png" alt="">`,
  latexAltImg: () => `<img src="/eq/1.png" alt="\\sqrt{x}">`,
  latexBeginImg: () =>
    `<img src="https://x.test/e.png?tex=%5Cbegin%7Bmatrix%7Da%5Cend%7Bmatrix%7D" alt="">`,
  mwe: () =>
    `<span class="mwe-math-element"><span class="mwe-math-mathml-inline mwe-math-mathml-a11y" style="display: none;"><math xmlns="http://www.w3.org/1998/Math/MathML" alttext="{\\displaystyle E=mc^{2}}"><semantics><mrow><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></mrow><annotation encoding="application/x-tex">{\\displaystyle E=mc^{2}}</annotation></semantics></math></span><img src="https://wikimedia.org/api/rest_v1/media/math/render/svg/abc" class="mwe-math-fallback-image-inline" aria-hidden="true" alt="E=mc^2"></span>`,
  mweDisplay: () =>
    `<span class="mwe-math-element mwe-math-element-block"><img src="https://wikimedia.org/x.svg" class="mwe-math-fallback-image-display" alt="{\\displaystyle a}"></span>`,
  katexScript: () => `<script type="math/katex">c = \\pm\\sqrt{a^2 + b^2}</script>`,
  dataKatex: () => `<span data-katex="\\hbar">hbar</span>`,
  annotationOnly: () => `<annotation encoding="application/x-tex">\\gamma</annotation>`,
  blockAfterParagraph: () => `<p>Text before.</p><math><mi>z</mi></math>`,
  mathjaxSvg: () =>
    `<span class="MathJax_SVG"><svg><g></g></svg></span><script type="math/tex">k</script>`,
  paramEq: () => `<img src="https://x.test/r.png?eq=%5Calpha+beta" alt="">`,
  paramTex: () => `<img src="https://x.test/r.png?tex=%5Cgamma" alt="">`,
  paramMath: () => `<img src="https://x.test/r.png?math=%5Cdelta" alt="">`,
  paramPlain: () => `<img src="https://x.test/r.png?a=1&latex=%5Ceta&b=2" alt="">`,
  paramNotLatex: () => `<img src="https://x.test/r.png?latex=plain" alt="">`,
  queryBare: () => `<img src="https://x.test/r.png?%5Czeta%20x#frag" alt="">`,
  mjxMathData: () => `<mjx-math data-latex="x"><mjx-mi><mjx-c>y</mjx-c></mjx-mi></mjx-math>`,
  mjxInvisible: () =>
    mjx(
      `${mjxToken('mo', '\u2062')}${mjxToken('mo', '\u2063')}${mjxToken('mo', '\u2064')}${mjxToken('mi', 'q')}`
    ),
  emptyMtable: () => mathml(`<mtable></mtable>`),
  mtableMixed: () =>
    mathml(
      `<mtable><mlabeledtr><mtd><mtext>(3)</mtext></mtd><mtd><mi>a</mi></mtd></mlabeledtr><mtr><mtd><mi>b</mi></mtd></mtr></mtable>`
    ),
  mtableEmptyLabel: () =>
    mathml(`<mtable><mlabeledtr><mtd></mtd><mtd><mi>a</mi></mtd></mlabeledtr></mtable>`),
  mtableOneCell: () => mathml(`<mtable><mlabeledtr><mtd><mi>a</mi></mtd></mlabeledtr></mtable>`),
  mathjaxMathml: () => `<span class="MathJax_MathML"><math><mi>m</mi></math></span>`,
  mathjaxDisplayScriptOnly: () => `<script type="math/tex; mode=display">\\int f</script>`,
  emptyScript: () => `<script type="math/tex"> </script>`,
  mathjaxScriptSibling: () =>
    `<div><span class="MathJax">x</span><script type="text/javascript" src="https://cdn.mathjax.org/mathjax.js"></script><script type="math/tex">\\pi</script></div>`
}

/** Raw LaTeX in text: needs a MathJax or KaTeX script in the document. */
export const rawLatexPages = {
  dollars: `<p>Inline $\\alpha + \\beta$ and $x_1$ and costs $5 and $10.</p>`,
  display: `<p>$$\\int_0^1 f(x)\\,dx$$</p>`,
  displayInline: `<p>Text $$a^2$$ more</p><div>$$b^2$$<span>x</span></div>`,
  backslash: `<p>See \\(a+b\\) and \\[c\\]</p>`,
  currency: `<p>It costs $5 and then $10 later, $ x $.</p>`,
  skipped: `<pre>$$\\alpha$$</pre><code>$x^2$</code><p>ok $y_2$</p>`,
  mixed: `<p>$\\a$ $b$ $$d$$ \\(e\\) text</p>`,
  closeBrace: `<p>costs $x}$ and $y$ and $a^b$ and $\\k$ text</p>`
}
export const rawLatexScripts = {
  src: `<script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>`,
  katexSrc: `<script src="/js/KaTeX.min.js"></script>`,
  inline: `<script>window.MathJax = { tex: {} }</script>`,
  inlineKatex: `<script>renderKaTeX()</script>`,
  none: ``,
  other: `<script src="/app.js"></script><script>var x = 1</script>`
}
