// Single-rule pages for `standardizeContent` and `standardizeCallouts`: each is written to reach
// one branch of `dist/standardize.js`, `elements/headings.js` or `elements/callouts.js`. The
// oracle runs every case in both variants (`standardize.mjs`).
import { page, plain, prose, sweep, words } from './removal-pages.mjs'

const body = (html) => page(`${prose(1)}${html}${prose(1)}`)

export const standardizeCases = [
  // standardizeDropCaps, standardizeSpaces, removeHtmlComments
  {
    name: 'drop-caps',
    html: body(
      `<p><span data-caps="initial">T</span><small>HE REST</small> of the story</p>` +
        `<p><span data-caps="initial">A</span>nother <span data-caps="initial">B</span><b>x</b></p>`
    )
  },
  {
    name: 'nbsp',
    html: body(
      `<p>a&nbsp;b&nbsp;&nbsp;c</p><pre>x&nbsp;y</pre><p><code>q&nbsp;r</code></p>` +
        `<svg><text>s&nbsp;t</text></svg>`
    )
  },
  {
    name: 'comments',
    html: body(`<!-- top --><p>text<!-- inline --> more</p><div><!-- nested --></div>`)
  },
  // standardizeHeadings and the heading rule
  {
    name: 'headings-h1',
    html: page(
      `<h1 id="t" class="big" data-x="1" lang="en">The Long Road Home</h1>${prose(2)}<h1>Second</h1>${prose(1)}`
    )
  },
  {
    name: 'headings-title-h2-anchor',
    html: page(
      `<h1><a href="#top">¶</a>The Long Road Home</h1>${prose(2)}<h2>Later</h2>${prose(1)}`
    )
  },
  {
    name: 'headings-title-mismatch',
    html: page(`<h2>Another title</h2>${prose(2)}<h2>The Long Road Home</h2>${prose(1)}`)
  },
  {
    name: 'headings-nav',
    html: body(
      `<h2 lang="fr" dir="ltr">One <a href="#one">#</a><button>copy</button></h2>` +
        `<h3><span class="anchor">x</span>Two <a class="heading-anchor" href="/p">link</a></h3>` +
        `<h4><span><a href="#t">only</a></span></h4>` +
        `<h5><div><a title="Permalink" href="/x">word</a></div> Five</h5>` +
        `<h6><span class="permalink-widget">w</span><em>Six</em></h6>` +
        `<h2>  <b>Bold</b> <i>plain</i>  </h2><h3></h3><h4> spaced </h4>`
    )
  },
  {
    name: 'headings-permalink-forms',
    html: body(
      `<h2>A<a href="#a">§</a></h2><h2>B<a href="/b">🔗</a></h2><h2>C<a href="/c">\uFEFF</a></h2>` +
        `<h2>D<a class="Permalink-Link" href="/d">d</a></h2><h2>E<a href="/e">not</a></h2>` +
        `<p>x <a class="permalink" href="/f">¶</a> <a class="anchor-link" href="/g">h</a> <a class="heading-anchor" href="/h">h</a></p>`
    )
  },
  {
    name: 'trailing-headings',
    html: page(
      `${prose(2)}<h2>Real</h2>${prose(1)}<h2>Tail one</h2><div><h3>Tail two</h3></div><blockquote><h3>Quoted tail</h3></blockquote>`
    )
  },
  {
    name: 'trailing-headings-text-after',
    html: page(
      `${prose(2)}<h2>Tail</h2><blockquote><h3>Inner</h3></blockquote>after<blockquote><h4>Last</h4></blockquote>`
    )
  },
  // wrapPreformattedCode
  {
    name: 'wrap-preformatted-code',
    html: body(
      `<p><code style="white-space: pre">a  b</code></p><pre><code style="white-space:pre">c</code></pre>` +
        `<p><code style="white-space: pre-wrap">d</code> <code>e</code></p>`
    )
  },
  // roles
  {
    name: 'role-paragraph',
    html: body(
      `<div role="paragraph" class="x" id="y" lang="en">Hello <b>there</b></div>` +
        `<div data-testid="paragraph-1">Second</div>`
    )
  },
  {
    name: 'role-lists',
    html: body(
      `<div role="list"><div role="listitem"><span class="label">1)</span><div class="content">` +
        `<div role="paragraph">First</div>` +
        `<div role="list"><div role="listitem"><span class="label">•</span><div class="content">` +
        `<div role="paragraph">Nested</div></div></div><div role="listitem"></div></div></div></div>` +
        `<div role="listitem"><div class="content"><div role="paragraph">Loose</div></div></div></div>` +
        `<div role="list"><div role="listitem"><div class="content">Bullet</div></div></div>` +
        `<div role="list"><div role="listitem"><div class="content">Outer<div role="list"><div role="listitem"><span class="label">2)</span><div class="content">N</div></div></div></div></div></div>` +
        `<div role="listitem">No content</div>`
    )
  },
  // SVG colors, Tailwind classes and fallback styles
  {
    name: 'svg-colors',
    html: body(
      `<svg fill="var(--color-amber-600)" stroke="var(--text-black)" color="var(--x-white)">` +
        `<path fill="var(--bg-card)" stroke="var(--border-color)" d="M0 0Z"/>` +
        `<rect fill="var(--muted-text)" stop-color="var(--unknown)" width="4"/>` +
        `<circle fill="var(--foo, #123456)" flood-color="var(--a, var(--b))"/>` +
        `<ellipse fill="light-dark(#111, #eee)" lighting-color="light-dark(var(--color-red-500), blue)"/>` +
        `<polygon style="fill: var(--color-blue-300); stroke:light-dark(red, blue)"/>` +
        `<path style="color: var(--c-violet-950) ; fill: var(--q, red)"/>` +
        `<path fill="var(--color-nope-500)"/><path fill="var(--surface)"/><path fill="var(--divider)"/>` +
        `<path fill="var(--placeholder)"/><path fill="var(--COLOR-SLATE-50)"/></svg>`
    )
  },
  {
    name: 'svg-tailwind',
    html: body(
      `<svg class="size-4 fill-red-500 text-[12px]"><path class="stroke-blue-500/50 font-semibold"/>` +
        `<path class="fill-black stroke-white font-bold"/><path class="fill-transparent stroke-current font-medium"/>` +
        `<path class="fill-nope-500 text-[#fff] text-[rgb(1,2,3)] text-[hsl(1,2%,3%)] font-mono"/>` +
        `<path class="fill-red-500" style="opacity:1"/><path class="font-bold" style="opacity:1;"/><path class="font-bold" style="opacity:1"/>` +
        `<path class="fill-red-500/5"/><text class="text-[1.5em] a   b"/></svg>`
    )
  },
  {
    name: 'svg-fallback-styles',
    html: body(
      `<svg><path class="a" d="M0 0L1 1"/><path class="b" d="M0 0Z"/><path class="c" fill="red" d="M0"/>` +
        `<path class="d" fill="none" d="M1"/><path class="e" style="fill:blue" d="M2"/>` +
        `<line class="f" x1="0"/><line class="g" stroke="red"/><polyline class="h" style="stroke: blue"/>` +
        `<text class="i">t</text><tspan class="j" fill="red">u</tspan><text class="k" style="fill:red">v</text>` +
        `<defs><path class="inside" d="M"/></defs><circle class="l"/><rect class="m" fill="blue" stroke="red"/>` +
        `<g class="n"/><polygon class="o" style="fill-opacity:1"/><rect/><line/><text>u</text></svg>`
    )
  },
  {
    name: 'svg-fallback-style-element',
    html: body(`<svg><style>.a{fill:red}</style><path class="a" d="M0"/></svg>`)
  },
  {
    name: 'svg-fallback-none-unstyled',
    html: body(`<svg><path d="M0"/><path fill="red" class="a"/><line stroke="red"/></svg>`)
  },
  // replaceCustomElements, data-as, block spans, bare spans
  {
    name: 'custom-elements',
    html: body(
      `<my-widget><p>inside</p></my-widget><x-note>plain <b>text</b></x-note>` +
        `<p>keep <relative-time>3 days ago</relative-time> inline</p><svg><foo-bar/></svg>` +
        `<outer-box><inner-box><p>deep</p></inner-box></outer-box>`
    )
  },
  {
    name: 'data-as-spans',
    html: body(
      `<span data-as="p">Paragraph <b>one</b></span><span data-as="H3">Heading</span>` +
        `<span data-as="div">Not allowed</span><span data-as="blockquote">Quoted</span>` +
        `<span data-as="li">Item</span>`
    )
  },
  {
    name: 'block-spans',
    html: body(
      `<span class="block mt-2">Tailwind block</span><span class="blockquote">not block</span>` +
        `<span style="display: block">Inline style</span><span style="display:blocked">no</span>` +
        `<span class="flex block">  </span><span style="DISPLAY : BLOCK">Upper</span>` +
        `<span class="x block-y">no</span><span class="a\tblock\nb">tabs</span>`
    )
  },
  {
    name: 'bare-spans',
    html: body(
      `<p><span><span>deep</span> <span id="k">kept</span></span><span>a</span><span>b</span> end</p>`
    )
  },
  // layout tables and tables
  {
    name: 'layout-table-single-cell',
    html: body(
      `<table><tbody><tr><td><div>${words(12)}</div></td><td> </td></tr></tbody></table>` +
        `<table><tr><td></td><td><p>direct tr</p></td></tr></table>`
    )
  },
  {
    name: 'layout-table-kept',
    html: body(
      `<table><tbody><tr><td><div>one</div></td><td>two</td></tr></tbody></table>` +
        `<table><thead><tr><th>H</th></tr></thead><tbody><tr><td><p>x</p></td></tr></tbody></table>` +
        `<table><caption>cap</caption><tbody><tr><td><p>y</p></td></tr></tbody></table>` +
        `<table><tbody><tr><td><span>inline child</span></td></tr></tbody></table>` +
        `<table><tbody><tr><td><p>a</p><p>b</p></td></tr></tbody></table>`
    )
  },
  {
    name: 'tables-empty-and-columns',
    html: body(
      `<table><tbody><tr><td> </td><td></td></tr></tbody></table>` +
        `<table><tbody><tr><td><img src="a.png"></td></tr></tbody></table>` +
        `<table><tbody><tr><td> </td></tr><tr><td><svg></svg></td></tr></tbody></table>` +
        `<table><tbody><tr><td>one</td></tr><tr><td>two</td></tr></tbody></table>` +
        `<table><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></tbody></table>` +
        `<table><tbody><tr><th>h</th></tr><tr><td>c</td></tr></tbody></table>` +
        `<table><tbody><tr><td><table><tbody><tr><td>n1</td><td>n2</td></tr></tbody></table></td></tr></tbody></table>` +
        `<table></table><table><tbody></tbody></table>`
    )
  },
  // flattenWrapperElements and empty elements
  {
    name: 'flatten-wrappers',
    html: page(
      `<div class="wrapper"><div class="container"><p>${words(15)}</p></div></div>` +
        `<div><div><div><p>deep</p></div></div></div><div>loose text <b>bold</b></div>` +
        `<section><p>section p</p></section><div class="row"><span>x</span> <em>y</em></div>` +
        `<div><p>one</p><p>two</p></div><div><ul><li>a</li></ul></div><div></div>` +
        `<div role="article"><span>role</span></div><div class="main-body">main <b>b</b></div>` +
        `<div class="footnote-box"><span>fn</span></div><div><figure><img src="a.png"></figure></div>` +
        `<div><div>text a</div><div>text b</div></div><div id="x"><p>y</p><span>z</span></div>`
    )
  },
  {
    name: 'flatten-top-level',
    html:
      `<!DOCTYPE html><html><head><title>t</title></head><body><article>` +
      `<div><p>a</p><p>b</p></div><section><div><p>c</p></div></section>${prose(2)}</article></body></html>`
  },
  {
    name: 'flatten-callout-preserved',
    html: body(`<div data-callout="note"><div><p>inside</p></div></div><div><p>x</p></div>`)
  },
  {
    name: 'empty-elements',
    html: body(
      `<div><span>,</span><span> </span><span></span></div><div><span>,</span><b>x</b></div>` +
        `<div><span lang="en">,</span><span lang="en"> </span><span lang="en"></span></div>` +
        `<div><span lang="en">,</span><b lang="en">x</b></div><div><span lang="en">;</span></div>` +
        `<div class="content"><span lang="en">,</span><span lang="en"> </span></div>` +
        `<div class="content"><span lang="en">,</span><b>x</b></div><div class="content"><span lang="en">,</span> </div>` +
        `<p><img src="a.png"></p><p><img src=""></p>` +
        `<p></p><p> </p><p>&nbsp;</p><p><br></p><p><br> <br></p><span> </span><em></em>` +
        `<div><img src="a.png"></div><div><hr></div><iframe></iframe><video></video><td></td>` +
        `<p><b></b><i> </i></p><div>\u00a0</div><object></object><embed><applet></applet>` +
        `<ul><li></li></ul><div><!-- c --></div><svg><g></g></svg>`
    )
  },
  // unwrapSpecialLinks
  {
    name: 'special-links',
    html: body(
      `<p>Use <code><a href="/x">fn()</a></code> and <a href="javascript:void(0)">js</a> ` +
        `<a href="JAVASCRIPT:x">upper</a> <a href="#frag"><h3>Anchor heading</h3></a></p>` +
        `<a href="/card"><h2>Card</h2><p>desc</p></a><a href="/c2"><div><h2>Nested</h2></div></a>` +
        `<a href="#top"><p>x</p></a><a><h2>No href</h2></a><a href=""><h2>Empty</h2></a>` +
        `<a href="/c3"><span>a</span><h4 class="t">Four <b>b</b></h4><h5>Five</h5></a>`
    )
  },
  // orphaned dividers
  {
    name: 'dividers',
    html: page(`<hr> <hr>${prose(1)}<hr><hr>  <hr>${prose(1)}<hr>text<hr>text<hr> <hr> <hr><hr>`)
  },
  {
    name: 'dividers-only-nested',
    html: page(`<hr><div><hr>${prose(1)}<hr></div><hr>`)
  },
  // stripExtraBrElements
  ...sweep('br-run', [1, 2, 3, 4, 5], (n) => body(`<p>a${'<br>'.repeat(n)}b</p>`)),
  {
    name: 'br-blocks',
    html: body(
      `<p>one</p><br><p>two</p><br><br><figure></figure><br> <br><h2>H</h2><br>` +
        `<div><p>a</p><br></div><p>text<br></p><p>text<br> </p><p>text<br>more</p>` +
        `<pre>a<br><br><br><br>b</pre><p><br>lead</p><li>x<br></li><span>s<br></span>` +
        `<blockquote>q<br><br></blockquote><p>a<br> <br> <br> <br>b</p>`
    )
  },
  {
    name: 'br-body-level',
    html: `<!DOCTYPE html><html><head><title>t</title></head><body><article>${prose(1)}</article><br><p>after</p></body></html>`
  },
  // removeEmptyLines
  {
    name: 'empty-lines',
    html: body(
      `<p>a\n\n  b\t\tc   d</p><p>one , two . three !</p><p>\u200B\u200C\u200D\u200E\u200Fx\u200B\uFEFFy</p>` +
        `<p>a\u00a0\u00a0\u00a0b</p><p>x<b> bold </b>y</p><p>x <i>it </i> y</p><p><b> </b>z</p>` +
        `<div>\n\n  <span>sp</span>\n</div><p>\u200B</p><p><em>(a)</em>(<b>b</b>)</p>` +
        `<p>a<b>b</b>c<i>d</i></p><p>a,<b>b</b>;<i>c</i></p><p><span>x</span><span>y</span></p>` +
        `<pre>\n  keep  \n\n</pre><p><code> a  b </code></p><p>t <a href="/x"> link </a> u</p>` +
        `<p><b>\u200B</b>w</p><p>é\u00a0\u00a0z</p><p><strong>  </strong></p>`
    )
  },
  // video, lite-youtube, arXiv, verso
  {
    name: 'embeds',
    html: body(
      `<video src="a.mp4"></video><video controls src="b.mp4"></video>` +
        `<lite-youtube videoid="abc123" videotitle="Talk"></lite-youtube>` +
        `<lite-youtube videoid="x"></lite-youtube><lite-youtube></lite-youtube>` +
        `<object data="a"></object><embed src="b"><applet></applet>`
    )
  },
  {
    name: 'arxiv',
    html: body(
      `<table class="ltx_equation"><tbody><tr><td><math alttext="x^2" display="block"><mi>x</mi></math></td></tr></tbody></table>` +
        `<table class="ltx_eqn_table"><tr><td><math display="inline"><semantics><mi>y</mi>` +
        `<annotation encoding="application/x-tex"> y_1 </annotation></semantics></math></td></tr></table>` +
        `<table class="ltx_equationgroup"><tr><td><math><mi>z</mi></math></td></tr></table>` +
        `<table class="ltx_equation"><tr><td>no math</td></tr></table>` +
        `<p>See <span class="ltx_note_outer">footnotemark: 1</span>x ` +
        `<a class="ltx_ref" href="#S1"><span class="ltx_text ltx_ref_tag">1</span></a> ` +
        `<a class="ltx_ref" href="#S2">plain</a> <a class="ltx_ref" href="#S3"><span class="ltx_ref_tag">3</span> and</a></p>`
    )
  },
  {
    name: 'verso-code',
    html: body(
      `<div><pre data-verso-code="true"><code class="language-lean">def a := 1\n</code></pre>\n` +
        `<pre data-verso-code="true"><code data-lang="Lean">def b := 2\n\n\n</code></pre> ` +
        `<pre data-verso-code="true"><code class="language-lean">def c := 3</code></pre>` +
        `<pre data-verso-code="true"><code class="language-python">py</code></pre>` +
        `<pre data-verso-code="true"><code class="language-python">py2</code></pre>` +
        `<pre data-verso-code="true"><code class="language-lean">solo</code></pre><p>sep</p>` +
        `<pre data-verso-code="true"><span>x</span></pre><pre data-verso-code="true"><code>a</code><code>b</code></pre>` +
        `<pre data-verso-code="false"><code class="language-lean">no</code></pre></div>` +
        `<div><pre data-verso-code="true"><code class="language-lean">a</code></pre>` +
        `<pre data-verso-code="true"><code>a</code><code>b</code></pre></div>`
    )
  },
  {
    name: 'code-nesting',
    html: body(`<code><pre><code>inner</code></pre></code><pre><code>plain</code></pre>`)
  },
  // stripUnwantedAttributes
  {
    name: 'attributes',
    html: body(
      `<p id="fnref:1" class="x" onclick="a()" style="color:red" data-y="1" lang="en" dir="rtl">a</p>` +
        `<div id="fn:1" class="footnote-backref">b</div><div id="footnotes">c</div><div id="other">d</div>` +
        `<code class="language-rust extra">e</code><code class="language-rust">f</code><pre class="language-x">g</pre>` +
        `<a class="footnote-backref" href="#r" title="t" target="_blank" rel="x">h</a>` +
        `<span class="callout">i</span><span class="callout-title">j</span><span class="callouts">k</span>` +
        `<span class="callout x">l</span><img src="a.png" alt="a" width="1" loading="lazy" HREF="x">` +
        `<svg class="icon" viewBox="0 0 1 1" onclick="x"><path class="p" d="M0" data-q="1"/></svg>` +
        `<div class="callout">m</div><td colspan="2" rowspan="3" scope="row">n</td>`
    )
  },
  // paths the first review of the port left unpinned
  {
    name: 'empty-checks-nbsp',
    html: body(
      `<pre>&nbsp;</pre><p><code>&nbsp;</code></p><svg><text>a&nbsp;&nbsp;b</text><text>c&nbsp;&nbsp;&nbsp;d</text></svg>` +
        `<p>a[<b>b</b>]</p><p>a(<b>b</b>)</p><div class="content"><span lang="en">,</span><span lang="en"></span></div>` +
        `<div class="content"><span lang="en"> </span><span lang="en">,</span></div>`
    )
  },
  {
    name: 'comma-spans-with-media',
    html: body(
      `<div class="content"><span lang="en"><img src="a.png"></span></div>` +
        `<div class="content"><span lang="en"><img src="b.png"></span><span lang="en">,</span></div>` +
        `<div class="content"><span lang="en"><img src="c.png"></span><b>x</b></div>`
    )
  },
  {
    name: 'semantic-roles-and-classes',
    html: body(
      `<div role="contentinfo"><span>info</span></div><div role="navigation"><span>nav</span></div>` +
        `<div role="main"><span>main</span></div><div role="banner"><span>banner</span></div>` +
        `<div class="bibliography"><span>refs</span></div><div class="my-reference"><span>ref</span></div>` +
        `<div class="x"><div class="footnote-list"><span>fn</span></div></div>`
    )
  },
  {
    name: 'preserved-ids',
    html: body(
      `<ol id="footnotes"><li id="fn:1">one</li><li id="fn-2">two</li></ol>` +
        `<p>x<sup id="fnref:1">1</sup><sup id="fnref-2">2</sup></p>`
    )
  },
  {
    name: 'role-list-labels',
    html: body(
      `<div role="list"><div role="listitem"><span class="label">a)</span><div class="content">A</div></div></div>` +
        `<div role="list"><div role="listitem"><span class="label">12)</span><div class="content">B</div></div></div>` +
        `<div role="list"><div role="listitem"><span class="label">)</span><div class="content">C</div></div></div>` +
        `<div role="list"><div role="listitem"><span class="label">  3) x</span><div class="content">D</div></div></div>`
    )
  },
  {
    name: 'verso-lean4',
    html: body(
      `<div><pre data-verso-code="true"><code class="language-lean4">a\n</code></pre>` +
        `<pre data-verso-code="true"><code data-lang="LEAN4">b\n</code></pre></div>`
    )
  },
  {
    name: 'arxiv-group',
    html: body(
      `<table class="ltx_equation"><tr><td><math display="inline"><mi>e</mi><annotation encoding="application/x-tex">e</annotation></math></td></tr></table>` +
        `<table class="ltx_equationgroup"><tr><td><math display="inline"><mi>q</mi><annotation encoding="application/x-tex">q</annotation></math></td></tr></table>` +
        `<table class="ltx_eqn_table"><tr><td><math display="block" alttext="z"><mi>z</mi></math></td></tr></table>`
    )
  },
  {
    name: 'heading-empty-title',
    html: page(`${prose(1)}<h2><a href="#x">¶</a></h2><h2>Two</h2>${prose(1)}`, { title: '' })
  },
  {
    name: 'headings-section-symbol',
    html: body(
      `<h2>x<a href="/p">§</a></h2><h3>y<a href="/q">#</a></h3><h4>z<a href="/r">¶</a></h4>`
    )
  },
  {
    name: 'callouts-admonition-quote',
    html: body(
      `<div class="admonition quote"><p>Said</p></div><div class="admonition bug"><p>Bug</p></div>`
    )
  },
  // callouts
  {
    name: 'callouts-obsidian',
    html: body(
      `<div class="callout is-collapsed" data-callout="note"><div class="callout-title">T</div>` +
        `<div class="callout-fold">v</div><div class="callout-content" style="display: none;">Body</div></div>` +
        `<div class="callout is-collapsible" data-callout="tip" data-callout-fold="+"><div class="callout-content" style="color:red; display:none ;">B2</div></div>` +
        `<div class="callout is-collapsible is-collapsed"><div class="callout-content" style="DISPLAY:NONE">B3</div></div>` +
        `<div class="callout is-collapsible"><div class="callout-content" style="margin:0">B4</div></div>` +
        `<div class="callout is-collapsible"><div class="callout-content">B5</div></div>` +
        `<div class="callout is-collapsed"></div>`
    )
  },
  {
    name: 'callouts-github',
    html: body(
      `<div class="markdown-alert markdown-alert-warning"><p class="markdown-alert-title">Warning</p><p>Careful</p></div>` +
        `<div class="markdown-alert"><p>Plain alert</p></div>` +
        `<div class="markdown-alert markdown-alert-tip"><p>No title</p></div>` +
        `<div class="x markdown-alert-important markdown-alert"><span class="markdown-alert-title">I</span>Text <b>b</b></div>`
    )
  },
  {
    name: 'callouts-aside',
    html: body(
      `<aside class="callout-info"><div class="callout-content"><p>Inner</p></div><p>outer</p></aside>` +
        `<aside class="my-callout"><p>No type</p></aside><aside class="callout"><p>Bare</p></aside>` +
        `<aside class="x callout-danger">Direct <i>text</i></aside>`
    )
  },
  {
    name: 'callouts-admonition',
    html: body(
      `<div class="admonition warning"><p class="admonition-title">Heads up</p><p>Body</p></div>` +
        `<div class="admonition"><div class="admonition-content"><p>Content</p></div></div>` +
        `<div class="admonition tip"><div class="details-content">Details</div><p>ignored</p></div>` +
        `<div class="admonition unknown-type"><p class="admonition-title">  </p>Rest</div>` +
        `<div class="admonition quote" data-callout="x">kept</div>` +
        `<div class="admonition danger"><p class="admonition-title">D</p><div class="admonition-content">C</div><div class="details-content">E</div></div>`
    )
  },
  {
    name: 'callouts-bootstrap',
    html: body(
      `<div class="alert alert-danger alert-dismissible"><h4 class="alert-heading">Oh no</h4>Bad <a href="/x">news</a></div>` +
        `<div class="alert alert-info"><span class="alert-title"> Note </span>Info</div>` +
        `<div class="alert alert-dismissible">dismiss only</div><div class="alert">no suffix</div>` +
        `<div class="alert alert-success">Done</div>`
    )
  },
  {
    name: 'callouts-nested',
    html: body(
      `<div class="alert alert-warning"><div class="markdown-alert markdown-alert-note"><p>inner</p></div>outer</div>` +
        `<div class="admonition note"><div class="alert alert-info">x</div></div>`
    )
  },
  // pipeline-only interplay: removal selectors see the callouts the earlier step created
  {
    name: 'callouts-survive-removal',
    html: page(
      `${prose(2)}<div class="alert alert-info"><p>${words(25)}</p></div>` +
        `<div class="admonition note"><p class="admonition-title">Note</p><p>${words(25)}</p></div>${prose(1)}`
    )
  },
  {
    name: 'plain-text-only',
    html: page(plain(40))
  }
]
