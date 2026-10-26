// Single-rule pages for the removal steps: each is written to reach one branch of
// `dist/removals/*.js`. The oracle runs every case through all variants (`removals.mjs`), so a
// branch the port gets wrong shows as a difference in the step that owns it.
import { URL, byline, page, prose, pubDate, words } from './removal-pages.mjs'
import { sweepCases } from './removal-sweeps.mjs'
import { edgeSweepCases } from './removal-sweeps-edges.mjs'

export const singleRuleCases = [
  // removeMetadataBlock
  {
    name: 'metadata-block-date-sibling',
    html: page(`<h1>The Long Road Home</h1><div>March 24, 2026</div>${prose(3)}`, { head: byline })
  },
  {
    name: 'metadata-block-date-in-child',
    html: page(
      `<h1>The Long Road Home</h1><div class="meta"><span>Posted</span><p>2026-04-07</p></div>${prose(3)}`,
      { head: pubDate }
    )
  },
  {
    name: 'metadata-block-third-sibling',
    html: page(
      `<h1>The Long Road Home</h1><p>Intro line</p><p>Another line</p><div>24th March 2026</div>${prose(3)}`,
      { head: byline }
    )
  },
  {
    name: 'metadata-block-too-long',
    html: page(`<h1>The Long Road Home</h1><div>March 24, 2026 ${words(80)}</div>${prose(3)}`, {
      head: byline
    })
  },
  {
    name: 'metadata-block-no-meta',
    html: page(`<h1>The Long Road Home</h1><div>March 24, 2026</div>${prose(3)}`)
  },
  { name: 'wbr', html: page(`<p>${words(20)}<wbr>${words(20)}</p>${prose(2)}`) },
  // findSmallImages / removeSmallImages
  {
    name: 'small-images-sizes',
    html: page(
      `${prose(2)}<img src="a.png" width="10" height="10"><img src="b.png" style="width: 20px">` +
        `<img src="c.png" width="200" height="12"><img src="d.png" width="64" height="64">` +
        `<img src="e.png" width="0"><img src="f.png" style="height:8px;width:100px">` +
        `<svg viewBox="0 0 16 16"><path d="M0 0"/></svg><svg viewBox="0, 0, 400, 300"><path d="M0 0"/></svg>` +
        `<svg viewBox="0 0 24" width="12"></svg><svg width="500" height="500" id="big"></svg>` +
        `<svg width="16" height="16" id="icon-small"></svg><svg width="16" height="16" class="ico x"></svg>` +
        `<svg viewBox="1 1 8 8" id=""></svg>${prose(1)}`
    )
  },
  {
    name: 'small-images-srcset',
    html: page(
      `${prose(2)}<img srcset="https://cdn.example.com/a.jpg?w=24 1x, https://cdn.example.com/a.jpg?w=48 2x">` +
        `<img srcset="https://cdn.example.com/b.jpg?width=400 1x">` +
        `<img srcset="https://cdn.example.com/c/w:16/c.jpg 1x">` +
        `<img srcset="https://cdn.example.com/d.jpg?x=1&w_=20 1x">` +
        `<img data-srcset="https://cdn.example.com/e.jpg?w=10 1x" width="12">` +
        `<img data-src="https://cdn.example.com/f.jpg" width="9"><img data-src="https://cdn.example.com/f.jpg">` +
        `<img src="https://cdn.example.com/g.jpg" data-src="https://cdn.example.com/f.jpg">`
    )
  },
  {
    name: 'small-images-math-kept',
    html: page(
      `${prose(2)}<img src="m1.png" width="10" height="10" alt="\\alpha + \\beta">` +
        `<img src="m2.png" width="10" height="10" class="latex"><img src="m3.png" width="10" class="tex">` +
        `<img src="m4.png" width="10" data-latex="x"><img src="m5.png" width="10" data-math="y">` +
        `<img src="m6.png" width="10" alt="\\a"><img src="m7.png" width="10" alt="plain">`
    )
  },
  {
    name: 'small-images-no-source',
    html: page(
      `${prose(2)}<img alt="none"><img src="" alt="empty"><img src="" data-lazy-src="x.jpg">` +
        `<img src="" data-original="y.jpg"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="p">` +
        `<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="real.jpg">` +
        `<picture><img src="data:image/png;base64,iVBORw0KGgo="><source srcset="a.webp"></picture>` +
        `<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" alt="s">` +
        `<img src="data:image/png;base64,${'A'.repeat(132)}"><img src="data:image/png;base64,${'A'.repeat(133)}">` +
        `<img src="data:image/jpeg;base64,${'B'.repeat(200)}">`
    )
  },
  {
    name: 'small-images-identifier-kinds',
    html: page(
      `${prose(2)}<svg id="logo" width="10" height="10"></svg><svg id="logo" width="400" height="400"></svg>` +
        `<svg viewBox="0 0 12 12" width="12"></svg><svg viewBox="0 0 12 12" width="400" height="400"></svg>` +
        `<svg class="chev" width="12" height="12"></svg><svg class="chev" width="300" height="300"></svg>` +
        `<img class="avatar" src="" srcset="s.jpg 1x" width="5"><img class="avatar" srcset="s.jpg 1x" height="400">` +
        `<img src="u1.png" width="10"><img src="u1.png" width="500">`
    )
  },
  // removeHiddenElements
  {
    name: 'hidden-inline-styles',
    html: page(
      `${prose(1)}<div style="display:none">a b c</div><div style="color:red; display: none;">b</div>` +
        `<div style="visibility:hidden">c</div><div style="opacity:0">d</div><div style="opacity: 0;">e</div>` +
        `<div style="opacity:0.5">f</div><div style="display:none-ish">g</div>` +
        `<div style="DISPLAY : NONE">h</div><div style="margin:0;opacity:0 ">i</div>` +
        `<div style="visibility:hidden;display:block">j</div><div style="display:flex">k</div>${prose(1)}`
    )
  },
  {
    name: 'hidden-classes',
    html: page(
      `${prose(1)}<div class="hidden">a</div><div class="x invisible y">b</div><div class="sm:hidden">c</div>` +
        `<div class="lg:invisible">d</div><div class="[&_.x]:hidden">e</div><div class="group-[.s]:hidden">f</div>` +
        `<div class="hidden sm:flex">g</div><div class="hidden md:block">h</div><div class="hiddenish">i</div>` +
        `<div class="not-machine:hidden">j</div><div class="2xl:contents hidden">k</div>` +
        `<div class="min-[100px]:grid hidden">l</div><div class="xs:block hidden">m</div>${prose(1)}`
    )
  },
  {
    name: 'hidden-math-kept',
    html: page(
      `${prose(1)}<span style="display:none"><math><mi>x</mi></math></span>` +
        `<div class="hidden"><span class="katex-mathml">y</span></div><div class="hidden" data-mathml="z">z</div>` +
        `<div style="display:none"><div data-mathml="q"></div></div><math style="display:none"></math>` +
        `<div class="hidden"><span>plain</span></div>`
    )
  },
  // removeBySelector, exact
  {
    name: 'selectors-exact',
    html: page(
      `<nav>menu</nav>${prose(2)}<aside>side</aside><footer>foot</footer><div class="ad">ad</div>` +
        `<div class="gradient ad">g</div><div class="ad-slot">x</div><div class="top-ad">y</div>` +
        `<div role="banner">b</div><div role="BANNER">B</div><script>var a;</script><script type="math/tex">x</script>` +
        `<style>p{}</style><noscript>n</noscript><audio></audio><audio src="a.mp3"></audio>` +
        `<video><source src="v.mp4"></video><video></video><div id="ad-top">z</div><div data-ad-wrapper>w</div>` +
        `<link rel="x"><meta name="y">${prose(1)}`
    )
  },
  {
    name: 'selectors-exact-hidden-skip',
    html: page(
      `${prose(2)}<div hidden>hid</div><div aria-hidden="true">ah</div><div class="hidden">ch</div>` +
        `<div class="invisible">ci</div><div role="dialog" class="modal"><div hidden>in</div></div>` +
        `<div hidden role="Dialog"><p>d</p></div><div hidden><nav>n</nav></div>` +
        `<div aria-hidden="true" class="math">m</div><div aria-hidden="true" class="paywall">p</div>` +
        `<svg aria-hidden="true"></svg><div class="hidden sm:flex"><nav>x</nav></div>${prose(1)}`
    )
  },
  {
    name: 'selectors-exact-code-and-heading-anchor',
    html: page(
      `${prose(2)}<pre><code><nav>keep</nav><span class="ad">ad</span></code></pre>` +
        `<h2>Title <a href="#t" class="anchor sidebar">#</a></h2><h3>Other<a class="ad">x</a></h3>${prose(1)}`
    )
  },
  {
    name: 'selectors-buttons',
    html: page(
      `${prose(1)}<button class="share-button"><img src="zoom.jpg" alt="z"><svg></svg>Zoom</button>` +
        `<p>Hello <button class="tooltip-btn">term</button> world</p>` +
        `<button class="print-button">Print</button><div><button class="close-button"><picture><img src="p.jpg"></picture></button></div>` +
        `<li><button class="menu-button">in li</button></li><span><button class="share-btn"><b>bold</b> txt</button></span>` +
        `<button class="sidebar-toggle"><video src="v.mp4"></video></button>${prose(1)}`
    )
  },
  {
    name: 'selectors-footnote-protection',
    html: page(
      `${prose(1)}<div class="footnotes"><div class="sidebar-note">n</div><ol><li class="comments">c</li></ol></div>` +
        `<div class="footnote-footer sidebar"></div><section class="footnotes"><div class="share">s</div><ol><li>1</li></ol></section>` +
        `<div class="comments"><ol class="footnotes-list"><li>x</li></ol></div>` +
        `<div id="footnotes"><a class="footnote-backref sidebar" href="#fnref1">↩</a><p class="comments">q</p></div>` +
        `<a class="footnote-backref sidebar" href="#x">out</a>${prose(1)}`
    )
  },
  // removeBySelector, partial
  {
    name: 'selectors-partial',
    html: page(
      `${prose(2)}<div class="sidebar-widget">s</div><div class="Related-Posts">r</div>` +
        `<section data-testid="comments-section">c</section><div data-component="newsletter-signup">n</div>` +
        `<div data-test="x"><span data-qa="share-bar">q</span></div><div data-cy="social-links">c</div>` +
        `<div data-test-id="promo-box">p</div><div class="main-access-wall">m</div><div class="access-wall">a</div>` +
        `<div class="article-author">a</div><div class="plain">keep</div>${prose(1)}`
    )
  },
  {
    name: 'selectors-partial-ids',
    html: page(
      `${prose(2)}<div id="sidebar-left">a</div><div id="feedback-form">b</div><div id="theroleofthings">c</div>` +
        `<div id="comments">d</div><div id="footer">e</div><div id="hero">f</div><div id="loopsandfeedback">g</div>` +
        `<h2 id="comments">Heading id</h2><h2 class="comments-title">Heading class</h2>` +
        `<h3 data-testid="comments-x" id="sidebar">h3</h3><div id="main_content">k</div><div id="share:this">l</div>`
    )
  },
  {
    name: 'selectors-partial-skips',
    html: page(
      `${prose(2)}<pre class="sidebar"><code class="comments">code</code></pre><div class="share"><pre>x</pre></div>` +
        `<code class="advert">c</code><p>Use <code class="social">z</code></p>` +
        `<div class="comments" data-defuddle="1"><div class="share">kept</div></div>` +
        `<div class="widget-share"><div class="sidebar">nested</div></div>` +
        `<ul class="share-list"><li class="share-item">i</li></ul>${prose(1)}`
    )
  },
  {
    name: 'selectors-ancestor-of-main',
    html:
      `<!DOCTYPE html><html><head><title>T</title></head><body><div class="sidebar-wrapper">` +
      `<article>${prose(3)}</article></div></body></html>`
  },
  // scoring
  {
    name: 'scoring-nav-blocks',
    html: page(
      `${prose(3)}<div><a href="/a">Home</a> <a href="/b">About us</a> <a href="/c">Contact page</a></div>` +
        `<div>Subscribe to our newsletter and follow us on social media for more popular stories</div>` +
        `<section><ul><li><a href="/1">One</a></li><li><a href="/2">Two</a></li><li><a href="/3">Three</a></li>` +
        `<li><a href="/4">Four</a></li><li><a href="/5">Five</a></li><li><a href="/6">Six</a></li>` +
        `<li><a href="/7">Seven</a></li><li><a href="/8">Eight</a></li><li><a href="/9">Nine</a></li></ul></section>` +
        `<div class="widget">Some short widget text here</div><div>Terms, privacy and cookie notice apply</div>`
    )
  },
  {
    name: 'scoring-card-grid',
    html: page(
      `${prose(3)}<div><div><h3>One title</h3><img src="1.jpg"><p>x</p></div><div><h3>Two title</h3>` +
        `<img src="2.jpg"><p>y</p></div><div><h3>Three title</h3><img src="3.jpg"><p>z</p></div></div>` +
        `<section><h2>Alpha story</h2><h3>Beta story</h3><h4>Gamma story</h4><img src="a.jpg" alt="a">` +
        `<img src="b.jpg" alt="b"><span>tiny</span></section>`
    )
  },
  {
    name: 'scoring-social-and-byline',
    html: page(
      `${prose(3)}<div>Follow <a href="https://twitter.com/jane">Jane</a> and <a href="https://x.com/intent/tweet">share</a></div>` +
        `<div>Find me <a href="https://www.linkedin.com/in/jane">here</a></div>` +
        `<div>Posted <a href="https://mastodon.social/@jane">on</a> mastodon today</div>` +
        `<div>Read <a href="https://twitter.com/intent/follow">follow intent</a> button text</div>` +
        `<div>By Jane Doe March 4 2026 edition</div><div>By jane lower March 4 2026</div>` +
        `<div>See <a href="https://instagram.com/jane">insta</a> <a href="https://threads.net/jane">threads</a> <a href="https://facebook.com/share/x">fb</a></div>` +
        `<div>Plain words <a href="https://x.com/">root</a> and <a href="https://twitter.com/">root</a> here</div>`
    )
  },
  {
    name: 'scoring-likely-content',
    html: page(
      `${prose(2)}<div role="main"><a href="/a">a</a> <a href="/b">b</a> <a href="/c">c</a></div>` +
        `<div class="post-list"><a href="/a">x</a> <a href="/b">y</a> <a href="/c">z</a></div>` +
        `<div id="story1"><a href="/a">x</a> <a href="/b">y</a> <a href="/c">z</a></div>` +
        `<div><pre>c</pre><a href="/a">menu</a> <a href="/b">menu</a> <a href="/c">menu</a></div>` +
        `<div><h2>Real Heading</h2></div><div><h2>Related articles</h2></div><div><h3>Table of contents</h3></div>` +
        `<div><h2>Related articles</h2><p>${words(250)}.</p></div>` +
        `<div><h2>Share this</h2><p>${words(260)}.</p><a href="/1">a</a> ${'<a href="/x">l</a> '.repeat(70)}</div>` +
        `<div><h2>More articles</h2>${prose(30)}</div>`
    )
  },
  {
    name: 'scoring-prose-and-lists',
    html: page(
      `${prose(2)}<div>${words(60)} and <a href="/a">link</a></div><div>${words(110)}</div>` +
        `<div><p>${words(35)}</p></div><div>Short prose here, indeed. It reads like a sentence.</div>` +
        `<div>Short prose with <a href="/a">a</a> <a href="/b">b</a> <a href="/c">c</a> links, indeed. Yes!</div>` +
        `<div><ul><li>${words(30)}</li><li>${words(30)}</li></ul></div><div>${words(8)}</div>`
    )
  },
  {
    name: 'scoring-table-footnotes-code',
    html: page(
      `${prose(2)}<table><tr><td><div><a href="/a">menu</a> <a href="/b">menu</a> <a href="/c">menu</a> header nav</div></td></tr></table>` +
        `<pre><div class="nav">nav in pre</div></pre><div class="footnotes"><ol><li>footnote</li></ol></div>` +
        `<div><sup class="reference">1</sup> header menu nav footer sidebar</div>` +
        `<div class="nav" data-defuddle="1">menu menu menu</div><div class="footer-note">Footer text goes here now</div>`
    )
  },
  {
    name: 'scoring-class-penalties',
    html: page(
      `${prose(3)}<div class="advert banner">Buy now and save big on every order, today</div>` +
        `<div id="menu-nav">Home About Contact Help Terms</div><div class="subscribe sponsored related">Sponsored, related and more content</div>`
    )
  },
  // removeByContentPattern
  {
    name: 'content-breadcrumb-list',
    html: page(
      `<ul><li><a href="/">Home</a></li><li><a href="/blog">Blog</a></li><li>Post</li></ul>` +
        `<h1>The Long Road Home</h1>${prose(3)}`
    )
  },
  {
    name: 'content-breadcrumb-wrapped',
    html: page(
      `<div><nav><ol><li><a href="/archive/">Archive</a></li><li><a href="/archive/2024">2024</a></li><li>Post</li></ol></nav></div>` +
        `<h1>The Long Road Home</h1>${prose(3)}`
    )
  },
  {
    name: 'content-breadcrumb-rejected',
    html: page(
      `<ul><li><a href="https://other.com/a">Home</a></li><li><a href="/blog">Blog</a></li><li>Post</li></ul>` +
        `<h1>The Long Road Home</h1>${prose(3)}`
    )
  },
  {
    name: 'content-promo-banner',
    html: page(
      `<a href="/event"><div>You are invited: join our event</div></a>` +
        `<a href="/long"><div>${words(30)}</div></a><a href="/img"><div><img src="i.png">Look</div></a>` +
        `<a href="/sentence"><div>Hello there. More text</div></a><h1>The Long Road Home</h1>${prose(3)}` +
        `<a href="/after"><div>After heading</div></a>`
    )
  },
  {
    name: 'content-hero-header',
    html: page(
      `<div class="hero"><h1>The Long Road Home</h1><time datetime="2024-03-04">March 4, 2024</time>` +
        `<img src="hero.jpg" alt="hero"></div>${prose(4)}`
    )
  },
  {
    name: 'content-hero-header-nested',
    html: page(
      `<div class="wrap"><header><div class="in"><h1>The Long Road Home</h1><span>by someone</span></div>` +
        `<p><time datetime="2024-03-04">Mar 4</time></p></header></div>${prose(4)}` +
        `<div class="x"><h2>Section</h2><time datetime="2024-01-01">Jan 1</time>${prose(2)}</div>`
    )
  },
  {
    name: 'content-audio-widget',
    html: page(
      `<div class="player"><p>Listen to this article</p><audio src="a.mp3"></audio></div>` +
        `<h1>The Long Road Home</h1>${prose(3)}<div><video src="v.mp4"></video></div>` +
        `<div class="pre"><audio><source src="x.mp3"></audio></div><audio></audio>` +
        `<div>${words(30)}<audio src="b.mp3"></audio></div><div>Listen to this story <video src="q.mp4"></video></div>`
    )
  },
  {
    name: 'content-audio-preplayer',
    html: page(
      `<div class="widget"><span>Play</span><video src="x.mp4"></video></div><h1>The Long Road Home</h1>${prose(3)}`
    )
  },
  {
    name: 'content-toc',
    html: page(
      `<h1>The Long Road Home</h1><p>${words(30)}.</p><h2>Contents</h2><div><ul>` +
        `<li><a href="#a">A</a></li><li><a href="#b">B</a></li><li><a href="${URL}#c">C</a></li>` +
        `<li><a href="https://example.com/other#d">D</a></li></ul></div><hr>${prose(4)}<h2 id="a">A</h2>${prose(2)}`
    )
  },
  {
    name: 'content-toc-hr-and-label',
    html: page(
      `<h1>The Long Road Home</h1><p>${words(30)}.</p><hr><h3>On this page</h3><ul>` +
        `<li><a href="#a">A</a></li><li><a href="#b">B</a></li><li><a href="#c">C</a></li></ul><hr>${prose(4)}`
    )
  },
  {
    name: 'content-toc-rejected',
    html: page(
      `<h1>The Long Road Home</h1><ul><li><a href="#a">A</a></li><li><a href="#b">B</a></li><li><a href="https://x.com/z">C</a></li></ul>` +
        `<ul><li><a href="#a">A</a><img src="i.png"></li><li><a href="#b">B</a></li><li><a href="#c">C</a></li></ul>` +
        `<ul><li><a href="#a">A</a></li></ul>${prose(4)}<ul><li><a href="#a">A</a></li><li><a href="#b">B</a></li><li><a href="#c">C</a></li></ul>`
    )
  },
  {
    name: 'content-timezone-pinned',
    html: page(
      `<h1>The Long Road Home</h1><div class="tz"><p>Current time in</p><span>NYC</span></div>` +
        `<p>Pinned</p><div>Pinned</div><span>pinned</span><p>Pinned post</p>${prose(3)}`
    )
  },
  {
    name: 'content-duplicate-title-description',
    html: page(
      `<div>The Long Road Home</div><h1>The Long Road Home</h1><div>  A quiet “walk”  through the hills </div>` +
        `<span>The Long Road Home</span>${prose(4)}<div>The Long Road Home</div>`,
      { head: '<meta name="description" content="A quiet &quot;walk&quot; through the hills">' }
    )
  },
  {
    name: 'content-metadata-header-block',
    html: page(
      `<div>21 hours ago - Politics</div><h1>The Long Road Home</h1><div>March 4, 2024 · News</div>` +
        `<p>Mar 5 2024</p><div>Date: March 4, 2024</div><div>Posted today. March 4 2024</div>` +
        `<div><h2>${words(10)}</h2>March 3, 2024</div>${prose(4)}<div>Jan 2 2020</div>`
    )
  },
  {
    name: 'content-category-badge',
    html: page(
      `<div><a href="/cat"><img src="c.png" alt=""></a><a href="/cat">Travel</a></div>` +
        `<div><img src="x.png"><a href="/c">Cat</a> plain extra text here</div>` +
        `<div><img src="y.png">No links here</div><h1>The Long Road Home</h1>${prose(4)}`
    )
  },
  {
    name: 'content-byline',
    html: page(
      `<h1>The Long Road Home</h1><div class="wrap"><span>By Jane Doe</span></div>` +
        `<p>Posted by John</p><p>by Another</p>${prose(4)}<p>By Late Author</p>`
    )
  },
  {
    name: 'content-byline-sentence',
    html: page(`<h1>The Long Road Home</h1><p>By the way.</p><p>By x</p>${prose(4)}`)
  },
  {
    name: 'content-read-time',
    html: page(
      `<h1>The Long Road Home</h1><p>8 min read</p><div>Mar 4th 2026 | 3 min read</div>` +
        `<p>Reading time: 5 minutes</p><span>Estimated 12 mins read</span>${prose(4)}` +
        `<p>2 min read and then some words</p><div>5 min read</div>`
    )
  },
  {
    name: 'content-author-date',
    html: page(
      `<h1>The Long Road Home</h1><div class="by"><p>Jane Doe • March 4, 2026</p></div>` +
        `<p>March 5, 2026 — John Smith</p><p>Date: March 4 2026 Jane Doe</p>` +
        `<p>Jane doe March 4 2026</p><p>One Two Three Four Five March 4</p>${prose(4)}`
    )
  },
  {
    name: 'content-standalone-date',
    html: page(
      `<h1>The Long Road Home</h1><p>March 4, 2026</p><div class="d"><span>4th March 2026</span></div>` +
        `<p>2026-03-04</p><p>Mon, 4 Mar 2024</p><p>March 4, 2026 and more</p>${prose(4)}`
    )
  },
  {
    name: 'content-boundary-time',
    html: page(
      `<p><time datetime="2024-03-04">March 4</time></p><h1>The Long Road Home</h1><p><em><time>Mar 5</time></em></p>` +
        `${prose(8)}<p>Inline <time>today</time> stays when far from edges ${words(10)}</p>${prose(8)}` +
        `<div><b><time>Updated</time></b></div><p><time>last one</time></p>`
    )
  },
  {
    name: 'content-metadata-list',
    html: page(
      `<h1>The Long Road Home</h1><ul><li>Mar 4, 2024</li><li>5 min</li><li>Jane</li></ul>` +
        `<dl><dt>Author</dt><dd>Jane Doe</dd></dl><ul><li>One</li></ul>${prose(5)}` +
        `<h2>Tags</h2><ul><li>a</li><li>b</li></ul><p>Things to do:</p><ul><li>a</li><li>b</li></ul>` +
        `<ul><li>Sentence ends.</li><li>b</li></ul><ul><li>${words(12)}</li><li>b</li></ul>` +
        `<ol><li>a</li><li>b</li><li>c</li><li>d</li><li>e</li><li>f</li><li>g</li><li>h</li><li>i</li></ol>` +
        `<div><ul><li>Share</li><li>Tweet</li></ul></div>`
    )
  },
  {
    name: 'content-section-breadcrumb',
    html: page(
      `<div><a href="/blog/">Blog</a> / <span>Post</span></div><h1>The Long Road Home</h1>` +
        `<a href="/blog">back to blog</a><p>Some <a href="/blog/2024">inline</a> link text</p>${prose(3)}` +
        `<span><a href="/other">other</a></span><div><a href="../index.html">index</a></div>` +
        `<div><a href="/">root</a></div><div><a href="${URL}">self</a></div>`
    ),
    url: 'https://example.com/blog/2024/post'
  },
  {
    name: 'content-section-breadcrumb-relative',
    html: page(
      `<p><a href="../index.html">up</a></p><div><span><a href="index.php">idx</a></span></div>` +
        `<h1>The Long Road Home</h1>${prose(3)}`
    ),
    url: 'https://example.com/articles/hensels'
  },
  {
    name: 'content-section-breadcrumb-embedded',
    html: page(
      `<div>Go <a href="/blog/">Blog</a> now</div><h2>Heading</h2><div>x <a href="/blog/">Blog</a> y</div>` +
        `<div><a href="/blog/">Blog</a> tail</div>${prose(3)}`
    )
  },
  {
    name: 'content-trailing-external-list',
    html: page(
      `<h1>The Long Road Home</h1>${prose(4)}<h2>Our picks</h2><ul>` +
        `<li><a href="https://shop.example.net/a">Product A</a></li>` +
        `<li><a href="https://www.other.org/b">Product B</a></li></ul>`
    )
  },
  {
    name: 'content-trailing-external-list-rejected',
    html: page(
      `<h1>The Long Road Home</h1>${prose(4)}<h2>Internal</h2><ul>` +
        `<li><a href="https://www.example.com/a">Local</a></li><li><a href="https://x.net/b">Ext</a></li></ul>` +
        `<h2>No links</h2><ul><li>a</li><li>b</li></ul><h2>Mixed</h2><ul><li><a href="https://x.net/b">E</a> and lots of other text around</li><li><a href="https://y.net/b">Y</a></li></ul>` +
        `<h2>Trailing text</h2><ul><li><a href="https://x.net/b">E</a></li><li><a href="https://y.net/b">Y</a></li></ul><p>after</p>`
    )
  },
  {
    name: 'content-trailing-related-posts',
    html: page(
      `<h1>The Long Road Home</h1>${prose(4)}<hr><section><p><a href="/a">Post A</a> <a href="/c">cat</a></p>` +
        `<p><a href="/b">Post B</a></p><br></section><br>`
    )
  },
  {
    name: 'content-trailing-related-rejected',
    html: page(
      `<h1>The Long Road Home</h1>${prose(4)}<div><p><a href="/a">Post A</a>. It was great</p><p><a href="/b">Post B</a></p></div>`
    )
  },
  {
    name: 'content-trailing-thin-section',
    html: page(
      `<h1>The Long Road Home</h1>${prose(10)}<hr><div><h3>Stay in touch</h3><p>Join us</p></div>`
    )
  },
  {
    name: 'content-trailing-thin-section-rejected',
    html: page(
      `<h1>The Long Road Home</h1>${prose(10)}<h2>Conclusion</h2><p>${words(8)}</p><p>${words(9)}</p>`
    )
  },
  {
    name: 'content-trailing-thin-footnotes',
    html: page(
      `<h1>The Long Road Home</h1>${prose(10)}<h3>Subscribe</h3><svg><text>${words(60)}</text></svg>` +
        `<div id="footnotes"><ol><li>f</li></ol></div>`
    )
  },
  {
    name: 'content-boilerplate',
    html: page(
      `<h1>The Long Road Home</h1>${prose(10)}<p>Originally published on Example</p><p>More</p><div><p>Tail</p></div>`
    )
  },
  {
    name: 'content-boilerplate-copyright',
    html: page(
      `<h1>The Long Road Home</h1>${prose(10)}<div><p>© 2024 Example Corp</p></div><p>after</p>`
    )
  },
  {
    name: 'content-boilerplate-orphans',
    html: page(
      `<div><p>Comments</p></div><h1>The Long Road Home</h1>${prose(10)}<div class="end"><span>Loading...</span></div>`
    )
  },
  {
    name: 'content-boilerplate-each',
    html: page(
      `<h1>The Long Road Home</h1>${prose(8)}<div><p>Leave a reply</p><p>A version of this story was published in The Paper</p>` +
        `<p>Any reuse permitted with credit.</p><p>Affiliate links may earn a commission</p>` +
        `<p>Please Read our Comment Policy first</p><p>Thank you for joining our community today</p>` +
        `<p>This piece originally appeared in Nowhere</p></div>`
    )
  },
  {
    name: 'content-related-heading',
    html: page(
      `<h1>The Long Road Home</h1>${prose(14)}<div class="rel"><h2>Related articles</h2><ul><li>a</li></ul></div>` +
        `<p>after related</p><div><p>more</p></div>`
    )
  },
  {
    name: 'content-related-heading-direct',
    html: page(
      `<h1>The Long Road Home</h1>${prose(14)}<h2>Related posts</h2><p>x</p><h2>Subscribe</h2><p>y</p>`
    )
  },
  {
    name: 'content-related-heading-thin-preceding',
    html: page(
      `<h1>The Long Road Home</h1>${prose(14)}<div><p>Join the club</p></div><div><div class="s"><h3>You might also like</h3>` +
        `<p>a</p></div></div><p>tail</p>`
    )
  },
  {
    name: 'content-related-heading-variants',
    html: page(
      `<h1>The Long Road Home</h1>${prose(14)}<section><h3>About the author</h3><p>bio</p></section>` +
        `<section><h3>Latest news &amp; events</h3><p>a</p></section>`
    )
  },
  {
    name: 'content-related-intro',
    html: page(
      `<h1>The Long Road Home</h1>${prose(3)}<p>For more on this topic</p><p>For more about ${words(25)}</p>` +
        `<p>For more on <code>x</code></p><p>for more about x</p>`
    )
  },
  {
    name: 'content-related-cards',
    html: page(
      `<h1>The Long Road Home</h1>${prose(14)}<div class="outer"><div class="cards">` +
        `<div><img src="1.jpg"><h3>One</h3></div><div><img src="2.jpg"><a href="/2">Two</a></div>` +
        `<div><picture><img src="3.jpg"></picture><h2>Three</h2></div></div></div><p>tail</p>`
    )
  },
  {
    name: 'content-related-cards-rejected',
    html: page(
      `<h1>The Long Road Home</h1><div><div><img src="1.jpg"><h3>One</h3></div><div><img src="2.jpg"><a href="/2">Two</a></div></div>` +
        `${prose(14)}<div><div><img src="1.jpg"><h3>One</h3></div><span>x</span><span>y</span></div>`
    )
  },
  {
    name: 'content-newsletter',
    html: page(
      `<h1>The Long Road Home</h1>${prose(5)}<div><div><p>Subscribe to our newsletter</p>` +
        `<p>Never miss the latest updates</p></div></div>${prose(1)}`
    )
  },
  {
    name: 'content-newsletter-forms',
    html: page(
      `<h1>The Long Road Home</h1>${prose(5)}<section>Sign up for our email alerts today</section>` +
        `<div>Don’t miss the latest reports</div><ul><li>Sign-up newsletter</li><li>Daily</li></ul>` +
        `<div><img src="i.png">Subscribe newsletter</div><div>newsletterSubscribe now</div>`
    )
  },
  {
    name: 'content-newsletter-list',
    html: page(
      `<h1>The Long Road Home</h1>${prose(5)}<ul><li><a href="/n">Newsletter</a> subscribe</li><li>x</li></ul>${prose(1)}`
    )
  },
  {
    name: 'content-author-contact',
    html: page(
      `<h1>The Long Road Home</h1>${prose(5)}<div class="c"><div>Contact</div><div>Jane Doe</div>` +
        `<div>jane@example.com</div></div>`
    )
  },
  {
    name: 'content-author-contact-phone',
    html: page(
      `<h1>The Long Road Home</h1>${prose(5)}<section><dl><dt>Reporter</dt><dd>John Smith</dd></dl>` +
        `<span>(555) 123‑4567</span></section><div><p>Written by</p><a href="mailto:a@b.co">Mail</a></div>`
    )
  },
  {
    name: 'content-share-widget',
    html: page(
      `<h1>The Long Road Home</h1><div class="a"><span>Author</span><span>Jane</span></div>${prose(5)}` +
        `<p>Share</p><div><div><span>Written by</span></div></div><div><p>Follow</p><img src="a.png"></div>` +
        `<div><p>Share</p><pre>c</pre></div>`
    )
  },
  {
    name: 'content-social-counter',
    html: page(
      `<h1>The Long Road Home</h1>${prose(5)}<a>12 Likes</a><a href="/x">3 Comments</a><p>9 Shares</p>` +
        `<div><span>1 Restack</span></div><p>5 Likes</p>${prose(3)}<p>1 Reposts</p>`
    )
  },
  {
    name: 'content-trailing-tag-block',
    html: page(
      `<h1>The Long Road Home</h1>${prose(5)}<div><a href="/t/a">Features</a> <a href="/t/b">Amazon</a></div>` +
        `<div><a href="/t">One</a> then words</div><div><a href="/t">Sentence.</a></div>` +
        `<div><pre>c</pre><a href="/t">x</a></div><div>no links</div>`
    )
  },
  {
    name: 'eyebrow-label',
    html: page(`<div>Blog post</div><h1>The Long Road Home</h1>${prose(3)}`)
  },
  {
    name: 'eyebrow-wrapped',
    html: page(
      `<span>Announcements</span><div class="t"><div class="u"><h1>The Long Road Home</h1></div></div>${prose(3)}`
    )
  },
  {
    name: 'eyebrow-rejected',
    html: page(
      `<p>This is a sentence.</p><h1>One</h1><div>March 4</div><h2>Two</h2><div>${'x'.repeat(41)}</div><h2>Three</h2>` +
        `<div><time>t</time>Label</div><h2>Four</h2>${prose(2)}`
    )
  },
  {
    name: 'eyebrow-h2-fallback',
    html: page(`<p>Category</p><h2>The Long Road Home</h2>${prose(3)}`)
  },
  {
    name: 'main-wrapper-with-sidebar',
    html:
      `<!DOCTYPE html><html><head><title>Wrapped</title></head><body><header><nav><a href="/">Home</a> ` +
      `<a href="/a">A</a></nav></header><main><h1>Wrapped</h1>${prose(5)}</main>` +
      `<aside class="sidebar">side</aside><footer>© 2024</footer></body></html>`
  },
  {
    name: 'no-main-element',
    html:
      `<!DOCTYPE html><html><head><title>Bare</title></head><body><div><a href="/">Home</a></div>` +
      `<div class="post-list">${prose(3)}</div><div class="related">Related <a href="/x">x</a></div></body></html>`
  }
]

export const removalCases = [...singleRuleCases, ...sweepCases, ...edgeSweepCases].map((c) => ({
  url: URL,
  ...c
}))
