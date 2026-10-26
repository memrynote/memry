// Single-rule inputs for `createMarkdownContent`: each is written to reach one branch of
// `dist/markdown.js` or of turndown 7.2.4 (escape, whitespace, flanking, joining, a rule, the
// clean-up of the result) or one corner of the HTML parser turndown feeds.
const cases = [
  // Headings, paragraphs, emphasis
  ['title-heading-removed', '<h1>The Title</h1><p>Body text.</p>'],
  ['title-heading-kept-later', '<p>Intro.</p><h1>The Title</h1><p>Body.</p>'],
  ['title-heading-with-spaces', '<h1>The   Title</h1>\n\n<p>Body.</p>'],
  ['headings-all-levels', '<h2>Two</h2><h3>Three</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6>'],
  ['heading-uppercase-tag', '<H2>Shout</H2><P>text</P>'],
  ['heading-inline-markup', '<h2>A <em>b</em> <strong>c</strong> <code>d</code></h2>'],
  ['empty-heading', '<h2></h2><h3> </h3><p>after</p>'],
  ['emphasis-variants', '<p><em>a</em> <i>b</i> <strong>c</strong> <b>d</b></p>'],
  ['emphasis-blank', '<p>x<em> </em>y<strong></strong>z<i>\n</i>w</p>'],
  ['emphasis-flanking', '<p>a<em> b </em>c <strong>  d</strong>e</p>'],
  ['emphasis-nbsp-flanking', '<p>a<em>\u00a0b\u00a0</em>c <em>\u00a0 d</em></p>'],
  ['emphasis-after-space', '<p>a <em> b</em> <em>c </em> d</p>'],
  ['emphasis-block-sibling', '<div>a </div><em> b</em><em>c </em><div> d</div>'],
  [
    'emphasis-block-sibling-void',
    '<div>a <img src="i.png"></div><em> b</em><em>c </em><div><img src="j.png"> d</div>'
  ],
  ['emphasis-in-link', '<p><a href="/x"><em>why</em></a></p>'],
  ['nested-emphasis', '<p><em>a <strong>b</strong> c</em></p>'],
  ['br-lines', '<p>one<br>two<br><br>three</p>'],
  ['br-at-edges', '<p><br>start</p><p>end<br></p>'],
  ['hr', '<p>a</p><hr><p>b</p><hr/>'],
  ['blockquote', '<blockquote><p>quoted</p><p>again</p></blockquote>'],
  ['blockquote-nested', '<blockquote><p>a</p><blockquote><p>b</p></blockquote></blockquote>'],
  ['blockquote-lines', '<blockquote>one<br>two\u2028three</blockquote>'],
  ['blockquote-empty', '<blockquote></blockquote><p>x</p>'],
  ['blockquote-cr', '<blockquote>a\rb\r\nc</blockquote>'],
  // Escaping
  ['escape-punctuation', '<p>1 * 2 _ 3 [x] `y` \\ z</p>'],
  ['escape-line-start-dash', '<p>- item</p><p>-- two</p><p>x - y</p>'],
  ['escape-line-start-plus', '<p>+ plus</p><p>+plus</p>'],
  ['escape-line-start-equals', '<p>=== rule</p><p>a === b</p>'],
  ['escape-line-start-hash', '<p># not a heading</p><p>####### seven</p><p>#hash</p>'],
  ['escape-line-start-number', '<p>1. first</p><p>12. twelve</p><p>1.x</p><p>a 1. b</p>'],
  ['escape-line-start-quote', '<p>&gt; quote</p><p>a &gt; b</p>'],
  ['escape-line-start-tilde', '<p>~~~ fence</p><p>~~ two</p>'],
  [
    'escape-tag-like',
    '<p>Monte&lt;video&gt; a&lt;b c &lt;a@b.com&gt; &lt;https://x&gt; &lt;/p&gt; &lt;br/&gt; a &lt; b</p>'
  ],
  [
    'escape-tag-like-edge',
    '<p>&lt;a-b&gt; &lt;1a&gt; &lt;a\u00a0b&gt; &lt;a/b&gt; &lt;/&gt; &lt;</p>'
  ],
  ['escape-in-code-not', '<p><code>*a* _b_ [c] &lt;x&gt;</code></p>'],
  ['escape-inside-pre-not', '<pre><code>* a\n_ b\n# c</code></pre>'],
  [
    'escape-entities',
    '<p>&amp; &lt; &gt; &quot; &#39; &nbsp; &copy; &#x1F600; &notanentity; &amp</p>'
  ],
  // Whitespace and joining
  ['whitespace-runs', '<p>a \n\t b    c</p>'],
  ['whitespace-edges', '<p>  leading</p><p>trailing  </p><p> both </p>'],
  ['whitespace-between-blocks', '<div>\n  <p>a</p>\n  <p>b</p>\n</div>'],
  ['whitespace-only-inline', '<p>a<span> </span>b</p><p>a<span>  </span><span> </span>b</p>'],
  ['whitespace-nbsp', '<p>a&nbsp;b&nbsp;&nbsp;c</p><p>&nbsp;lead</p><p>trail&nbsp;</p>'],
  ['whitespace-nbsp-in-inline', '<p>a<b>&nbsp;x&nbsp;</b>b</p>'],
  ['whitespace-unicode-spaces', '<p>a\u2003b\u3000c<em>\u2003d\u2003</em>e</p>'],
  ['whitespace-void-flank', '<p>a <img src="x.png"> b <br> c <input> d</p>'],
  ['whitespace-inline-pre', '<p>a <pre>x</pre> b</p>'],
  ['whitespace-code-flank', '<p>a<code>b</code> <code> c </code> d</p>'],
  ['whitespace-wbr', '<p>long<wbr>word<WBR/>here<wbr  />end</p>'],
  ['joins-many-newlines', '<p>a</p><p></p><p></p><p>b</p><div></div><div><br></div><p>c</p>'],
  ['joins-blank-blocks', '<div> </div><div>\n</div><p>x</p><ul><li></li></ul>'],
  ['text-only', 'just text, no tags'],
  ['empty-input', ''],
  ['whitespace-input', '  \n\t '],
  ['comment-only', '<!-- nothing -->'],
  [
    'comments-everywhere',
    '<p>a<!-- one -->b</p><!-- two --><div><!-- three --></div><pre><code>x<!-- four -->y</code></pre>'
  ],
  ['pi-and-cdata', '<p>a<?php echo 1 ?>b</p><p>c<![CDATA[d]]>e</p>'],
  ['doctype-in-body', '<!DOCTYPE html><p>x</p>'],
  // Code
  ['inline-code', '<p>use <code>foo()</code> and <code>a`b</code> and <code>`tick`</code></p>'],
  [
    'inline-code-padding',
    '<p><code> pad </code> <code>  </code> <code> a</code> <code>a </code> <code> a\u2028b </code> <code> a\u2028b\u2028c </code></p>'
  ],
  ['inline-code-ticks', '<p><code>``</code> <code>`a``b```</code> <code>a`` b</code></p>'],
  ['inline-code-newlines', '<p><code>a\nb\r\nc\rd</code></p>'],
  ['inline-code-spaces-only', '<p>a<code> <img> </code>b<code> <img><br> </code>c</p>'],
  ['inline-code-empty', '<p>x<code></code>y</p>'],
  [
    'code-block-language-class',
    '<pre><code class="language-js">let a = 1;\nlet b = `2`;</code></pre>'
  ],
  ['code-block-data-lang', '<pre><code data-lang="py" class="language-js">x = 1</code></pre>'],
  ['code-block-data-language', '<pre><code data-language="rust">fn main() {}</code></pre>'],
  ['code-block-pre-language', '<pre data-language="go"><code>func main() {}</code></pre>'],
  [
    'code-block-class-word',
    '<pre><code class="hljs language-ts-x lang-ts">const a = 1</code></pre>'
  ],
  ['code-block-no-language', '<pre><code>plain\n\n  indented\n</code></pre>'],
  ['code-block-leading-blank', '<pre><code>\n\n  x\n\n</code></pre>'],
  [
    'code-block-nested-spans',
    '<pre><code><span class="k">let</span> <span class="n">a</span>\n</code></pre>'
  ],
  ['pre-without-code', '<pre>just   pre\n  text</pre>'],
  ['pre-code-deep', '<pre><div><code class="language-c">int x;</code></div></pre>'],
  [
    'pre-two-codes',
    '<pre><code class="language-a">one</code><code class="language-b">two</code></pre>'
  ],
  ['pre-inline-code-siblings', '<pre>a <code>b</code> c</pre>'],
  ['code-in-list', '<ul><li>run <code>x</code><pre><code>y</code></pre></li></ul>'],
  // Links
  ['link', '<p><a href="https://example.com/a">text</a></p>'],
  [
    'link-title',
    '<p><a href="/x" title="The &quot;title&quot;">t</a> <a href="/y" title="a\n  b\n\nc">u</a></p>'
  ],
  ['link-parens', '<p><a href="/a_(b)">x</a> <a href="/a(b">y</a></p>'],
  [
    'link-space',
    '<p><a href="/a b">x</a> <a href="/a\tb>c">y</a> <a href="/a b" title="t">z</a></p>'
  ],
  ['link-no-href', '<p><a name="x">anchor</a> <a href="">empty</a> <a>bare</a></p>'],
  ['link-empty-text', '<p>before <a href="/x"></a> after</p><p><a href="/y"> </a></p>'],
  ['link-empty-newlines', '<p>a</p>\n\n<a href="/x"></a>\n\n<p>b</p>'],
  ['link-image', '<p><a href="/p"><img src="a.png" alt="A"></a></p>'],
  ['link-block-child', '<a href="/x"><div>block</div></a>'],
  ['link-heading-complex', '<a href="/post" title="Go"><h2>Post title</h2><p>Summary here</p></a>'],
  ['link-heading-complex-no-href', '<a><h3>Head</h3><span>rest</span></a>'],
  ['link-heading-only-child', '<a href="/x"><h2>Only</h2></a>'],
  [
    'link-heading-complex-nested-heading',
    '<a href="/x"><span>a</span><h2>H <em>one</em></h2><h3>two</h3></a>'
  ],
  [
    'link-footnote-backref',
    '<p>a<a href="#fnref:1">back</a>b</p><p>c<a class="footnote-backref" href="#x">↩︎</a>d</p>'
  ],
  ['link-uppercase', '<p><A HREF="/up">Up</A></p>'],
  // Images
  ['image', '<p><img src="a.png" alt="Alt" title="Tit"></p>'],
  ['image-no-src', '<p>x<img alt="gone">y</p>'],
  ['image-alt-escaping', '<p><img src="a.png" alt="a [b] *c*" title="q &quot;x&quot;"></p>'],
  [
    'image-srcset-widths',
    '<img src="small.jpg" srcset="a.jpg 320w, b.jpg 1280w, c.jpg 640w" alt="x">'
  ],
  [
    'image-srcset-commas',
    '<img src="s.jpg" srcset="https://cdn.example/w_424,c_limit,f_webp/a.jpg 424w, https://cdn.example/w_848,c_limit,f_webp/a.jpg 848w">'
  ],
  ['image-srcset-density', '<img src="s.jpg" srcset="a.jpg 1x, b.jpg 2x, c.jpg 1.5x">'],
  ['image-srcset-mixed', '<img src="s.jpg" srcset="a.jpg 100w 2x, b.jpg 200w,c.jpg 50w">'],
  ['image-srcset-no-url', '<img src="s.jpg" srcset="100w, 200w">'],
  ['image-srcset-spaces', '<img src="s.jpg" srcset="  a.jpg    10w  ,  b.jpg  20w  ">'],
  ['image-srcset-empty', '<img src="s.jpg" srcset="">'],
  ['image-srcset-only', '<img srcset="x.jpg 10w">'],
  ['image-srcset-leading-comma', '<img srcset="a.jpg 10w, ,b.jpg 30w">'],
  ['image-srcset-tie', '<img src="s.jpg" srcset="first.jpg 100w, second.jpg 100w">'],
  ['image-srcset-large-width', '<img srcset="a.jpg 99999999999999999999w, b.jpg 5w">'],
  [
    'image-in-paragraph-text',
    '<p>See <img src="i.png" alt="icon"> here!<img src="j.png" alt="j"></p>'
  ],
  [
    'image-bang-before',
    '<p>Yey!<img src="a.png" alt="A"></p><p>Wow!<a href="/x"><img src="b.png"></a></p>'
  ],
  ['image-bang-double', '<p>a!!<img src="a.png"> b!<a href="/y"><img src="b.png"></a></p>'],
  ['image-empty-link-kept', '<p>x<img src="a.png">y</p><p><a href="/z"></a></p>'],
  ['embed-youtube', '<iframe src="https://www.youtube.com/embed/abc_DEF-123"></iframe><p>t</p>'],
  [
    'embed-youtube-nocookie',
    '<iframe src="https://www.youtube-nocookie.com/embed/xyz789?rel=0"></iframe>'
  ],
  ['embed-youtube-short', '<iframe src="https://youtu.be/q1w2e3"></iframe>'],
  ['embed-youtube-watch', '<iframe src="https://www.youtube.com/watch?v=vid123&t=5"></iframe>'],
  ['embed-youtube-no-path', '<iframe src="https://www.youtube.com/"></iframe>'],
  ['embed-tweet', '<iframe src="https://twitter.com/user/status/1234567890"></iframe>'],
  ['embed-tweet-x', '<iframe src="https://x.com/someone/status/42"></iframe>'],
  [
    'embed-tweet-platform',
    '<iframe src="https://platform.twitter.com/embed/Tweet.html?dnt=true&id=987654"></iframe>'
  ],
  [
    'embed-tweet-platform-newline',
    '<iframe src="https://platform.twitter.com/embed/Tweet.html?a=1\n&id=55"></iframe>'
  ],
  ['embed-twitter-no-match', '<iframe src="https://twitter.com/user"></iframe><p>after</p>'],
  ['embed-img-x-domain', '<p><img src="https://box.com/a.png" alt="a"></p>'],
  ['embed-other-iframe', '<iframe src="https://example.com/embed"></iframe>'],
  ['embed-video-youtube-src', '<video src="https://youtube.com/embed/aaa"></video>'],
  // Figures
  [
    'figure',
    '<figure><img src="a.png" alt="A"><figcaption>Caption <em>here</em></figcaption></figure>'
  ],
  ['figure-no-caption', '<figure><img src="a.png" alt="A"></figure>'],
  ['figure-no-image', '<figure><p>just text</p></figure>'],
  [
    'figure-paragraph-outside',
    '<figure><img src="a.png"><p>body</p><figcaption>c</figcaption></figure>'
  ],
  [
    'figure-paragraph-inside-caption',
    '<figure><img src="a.png" alt="x"><figcaption><p>one</p><p>two</p></figcaption></figure>'
  ],
  [
    'figure-paragraph-in-div-caption',
    '<figure><img src="a.png"><figcaption><div><p>deep</p></div></figcaption></figure>'
  ],
  [
    'figure-srcset',
    '<figure><img src="s.jpg" srcset="b.jpg 800w, a.jpg 400w" alt="r"><figcaption>c</figcaption></figure>'
  ],
  [
    'figure-tag-span',
    '<figure><img src="a.png"><figcaption><span class="ltx_tag_figure">Figure 1:</span> The caption</figcaption></figure>'
  ],
  [
    'figure-caption-links',
    '<figure><img src="a.png"><figcaption>See <a href="/x">link</a> [1](a)</figcaption></figure>'
  ],
  ['figure-two-images', '<figure><img src="a.png" alt="a"><img src="b.png" alt="b"></figure>'],
  ['figure-empty-src', '<figure><img alt="none"><figcaption>c</figcaption></figure>'],
  [
    'figure-picture',
    '<figure><picture><source srcset="a.webp"><img src="a.png" alt="p"></picture><figcaption>pc</figcaption></figure>'
  ],
  // Lists
  ['list-unordered', '<ul><li>a</li><li>b</li><li>c</li></ul>'],
  ['list-ordered', '<ol><li>a</li><li>b</li><li>c</li></ol>'],
  ['list-ordered-start', '<ol start="5"><li>a</li><li>b</li></ol>'],
  ['list-ordered-start-zero', '<ol start="0"><li>a</li><li>b</li></ol>'],
  ['list-ordered-start-negative', '<ol start="-2"><li>a</li><li>b</li></ol>'],
  ['list-ordered-start-junk', '<ol start="abc"><li>a</li><li>b</li></ol>'],
  [
    'list-ordered-start-decimal',
    '<ol start="1.5"><li>a</li><li>b</li></ol><ol start=" 7 "><li>c</li></ol>'
  ],
  [
    'list-ordered-start-hex',
    '<ol start="0x10"><li>a</li></ol><ol start=""><li>b</li></ol><ol start="1e2"><li>c</li></ol>'
  ],
  ['list-nested', '<ul><li>a<ul><li>b<ul><li>c</li></ul></li><li>d</li></ul></li><li>e</li></ul>'],
  ['list-nested-ordered', '<ol><li>one<ol><li>sub</li><li>sub2</li></ol></li><li>two</li></ol>'],
  ['list-mixed-nesting', '<ul><li>a<ol><li>b<ul><li>c</li></ul></li></ol></li></ul>'],
  ['list-paragraph-items', '<ul><li><p>one</p></li><li><p>two</p><p>three</p></li></ul>'],
  [
    'list-item-blocks',
    '<ul><li>text<blockquote><p>q</p></blockquote></li><li><pre><code>c</code></pre></li></ul>'
  ],
  ['list-item-empty', '<ul><li></li><li>x</li><li> </li></ul>'],
  ['list-item-br', '<ul><li>a<br>b</li></ul>'],
  ['list-item-multiline-text', '<ul><li>line one\nline two\n\n\nline three</li></ul>'],
  ['list-in-paragraph', '<p>before</p><ul><li>x</li></ul><p>after</p>'],
  ['list-direct-text', '<ul>loose<li>x</li>text</ul>'],
  ['list-li-outside', '<li>stray</li><li>second</li>'],
  ['list-non-li-children', '<ul><div>a</div><li>x</li></ul>'],
  [
    'list-task',
    '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" checked disabled> done</li><li class="task-list-item"><input type="checkbox"> todo</li></ul>'
  ],
  [
    'list-task-case',
    '<ul><li class="task-list-item"><input type="CheckBox" checked="checked"> x</li><li class="task-list-item"><input type="radio"> y</li><li><input type="checkbox" checked> z</li></ul>'
  ],
  [
    'list-task-nested',
    '<ul><li class="task-list-item"><input type="checkbox" checked> a<ul><li class="task-list-item"><input type="checkbox"> b</li></ul></li></ul>'
  ],
  [
    'list-task-empty-checked',
    '<ul><li class="task-list-item"><input type="checkbox" checked=""> a</li></ul>'
  ],
  ['list-item-whitespace-sibling', '<ul>\n<li>a</li>\n<li>b</li>\n</ul>'],
  ['list-in-blockquote', '<blockquote><ul><li>a</li><li>b</li></ul></blockquote>'],
  ['list-in-table', '<table><tr><td><ul><li>a</li></ul></td><td>b</td></tr></table>'],
  [
    'list-arxiv-enumerate',
    '<ol class="ltx_enumerate"><li><span class="ltx_tag ltx_tag_item">1.</span> first <em>item</em></li><li><span class="ltx_tag ltx_tag_item">2.</span>\n second</li><li>no tag</li></ol>'
  ],
  [
    'list-deep-nesting',
    '<ul><li>1<ul><li>2<ul><li>3<ul><li>4<ul><li>5</li></ul></li></ul></li></ul></li></ul></li></ul>'
  ],
  ['list-definition', '<dl><dt>Term</dt><dd>Definition</dd><dt>Two</dt><dd>Def two</dd></dl>'],
  // Tables
  [
    'table-simple',
    '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table>'
  ],
  ['table-no-tbody', '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>'],
  [
    'table-ragged',
    '<table><tr><td>a</td></tr><tr><td>1</td><td>2</td><td>3</td></tr><tr><td>x</td><td>y</td></tr></table>'
  ],
  [
    'table-pipes',
    '<table><tr><td>a|b</td><td>c \\| d</td></tr><tr><td>1</td><td>2</td></tr></table>'
  ],
  [
    'table-cell-markup',
    '<table><tr><td><strong>b</strong> <a href="/x">l</a></td><td><code>c</code><br>d</td></tr><tr><td><p>p1</p><p>p2</p></td><td><img src="i.png" alt="i"></td></tr></table>'
  ],
  [
    'table-cell-newlines',
    '<table><tr><td>one\ntwo</td><td>x</td></tr><tr><td>y</td><td>z</td></tr></table>'
  ],
  ['table-empty-cells', '<table><tr><td></td><td> </td></tr><tr><td>a</td><td></td></tr></table>'],
  ['table-header-only', '<table><tr><th>A</th><th>B</th></tr></table>'],
  [
    'table-caption',
    '<table><caption>Cap</caption><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>'
  ],
  [
    'table-colspan',
    '<table><tr><td colspan="2" class="x" data-y="1">a</td></tr><tr><td>1</td><td id="z" style="color:red">2</td></tr></table>'
  ],
  [
    'table-rowspan',
    '<table class="t"><tr><th rowspan="2" scope="row" align="left">h</th><td>1</td></tr><tr><td>2 &amp; 3 &lt; 4 &gt; 5 &nbsp; &quot;q&quot;</td></tr></table>'
  ],
  [
    'table-colspan-attrs',
    '<table border="1" cellpadding="3" width="100"><tr><td colspan="2" bgcolor="#fff" valign="top" headers="h" src="s" href="/h" height="2" onclick="x()">a</td></tr></table>'
  ],
  [
    'table-single-column',
    '<table><tr><td><p>one</p></td></tr><tr><td><p>two</p></td></tr></table>'
  ],
  ['table-single-cell', '<table><tr><td>only <b>cell</b></td></tr></table>'],
  [
    'table-single-row-single-cell-data',
    '<table><tr><td><table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table></td></tr></table>'
  ],
  [
    'table-layout-nested',
    '<table><tr><td><h2>Left</h2><p>text</p></td><td><table><tr><th>X</th><th>Y</th></tr><tr><td>1</td><td>2</td></tr></table></td></tr></table>'
  ],
  [
    'table-layout-two-cells-nested-data',
    '<table><tr><td>a</td><td><table><tr><td>1</td></tr></table></td></tr></table>'
  ],
  [
    'table-mixed-row-widths-small',
    '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>'
  ],
  ['table-no-rows', '<table></table><p>x</p>'],
  ['table-empty-rows', '<table><tr></tr><tr></tr></table>'],
  ['table-th-only-column', '<table><tr><th>a</th></tr><tr><th>b</th></tr></table>'],
  [
    'table-with-list-cell',
    '<table><tr><td><ul><li>a</li><li>b</li></ul></td><td>c</td></tr></table>'
  ],
  [
    'table-with-pre-cell',
    '<table><tr><td><pre><code>x\ny</code></pre></td><td>c</td></tr><tr><td>d</td><td>e</td></tr></table>'
  ],
  ['table-in-list-item', '<ul><li>item<table><tr><td>a</td><td>b</td></tr></table></li></ul>'],
  ['table-in-blockquote', '<blockquote><table><tr><td>a</td><td>b</td></tr></table></blockquote>'],
  ['table-uppercase', '<TABLE><TR><TD>a</TD><TD>b</TD></TR></TABLE>'],
  ['table-stray-cells', '<td>a</td><td>b</td>'],
  ['table-fostered-text', '<table>stray<tr><td>a</td><td>b</td></tr></table>'],
  [
    'table-tfoot',
    '<table><tfoot><tr><td>f1</td><td>f2</td></tr></tfoot><tbody><tr><td>b1</td><td>b2</td></tr></tbody></table>'
  ],
  [
    'table-colgroup',
    '<table><colgroup><col><col></colgroup><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>'
  ],
  // Kept and removed elements
  ['keep-iframe', '<iframe src="https://example.com/e" width="10" title="t"></iframe>'],
  [
    'keep-video',
    '<video controls src="v.mp4"><source src="a.mp4" type="video/mp4">fallback</video>'
  ],
  ['keep-audio', '<p>listen <audio src="a.mp3" controls></audio> now</p>'],
  ['keep-audio-block', '<audio src="a.mp3"></audio><p>x</p>'],
  ['keep-sup-sub', '<p>x<sup>2</sup> H<sub>2</sub>O <sup> </sup></p>'],
  ['keep-sup-attrs', '<p>a<sup id="fnref:9" class="c">9</sup>b</p>'],
  [
    'keep-svg',
    '<p>a <svg viewBox="0 0 1 1" xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/><circle r="1"/></svg> b</p>'
  ],
  [
    'keep-svg-foreign',
    '<svg><foreignObject><p>x &amp; y</p></foreignObject><style>a &lt; b</style><text>t</text></svg>'
  ],
  [
    'keep-svg-xlink',
    '<svg><use xlink:href="#a" xmlns:xlink="http://www.w3.org/1999/xlink"/><image href="a.png"/></svg>'
  ],
  ['keep-svg-link', '<svg><a href="/x"><text>l</text></a></svg>'],
  [
    'keep-escaping',
    '<iframe title="a &amp; b &lt; c &quot;q&quot; &nbsp;" src="x"></iframe><sup>a&nbsp;&lt;b&gt;&amp;</sup>'
  ],
  ['keep-unclosed', '<p>a<sup>b<p>c</p>'],
  [
    'remove-script-style',
    '<p>a</p><script>var x = "<p>";</script><style>p { color: red }</style><p>b</p>'
  ],
  ['remove-script-inline', '<p>a<script>1</script>b<style>x</style>c</p>'],
  ['remove-svg-script', '<svg><script>x</script><style>y</style></svg>'],
  ['noscript', '<noscript><p>fallback</p></noscript><p>x</p>'],
  ['noscript-text', '<p>a <noscript>b &lt; c</noscript> d</p><svg><noscript>x</noscript></svg>'],
  ['template', '<template><p>inside</p></template><p>outside</p>'],
  ['template-keep', '<div><template><sup>x</sup></template>y</div>'],
  ['textarea-title', '<textarea>a *b* &lt;c&gt;</textarea><title>T &amp; U</title><p>x</p>'],
  ['button', '<button>Click <b>me</b></button><p><button> </button>x</p>'],
  ['button-in-link', '<a href="/x"><button>go</button></a>'],
  ['mark', '<p>a <mark>hl</mark> <mark> </mark> b</p>'],
  ['strikethrough', '<p><del>d</del> <s>s</s> <strike>k</strike> <del> </del></p>'],
  ['select-option', '<select><option>a</option><option>b</option></select>'],
  [
    'form-controls',
    '<form><input type="text" value="v"><label>L <input type="checkbox"></label><textarea>t</textarea></form>'
  ],
  ['details-summary', '<details><summary>Sum</summary><p>Body</p></details>'],
  ['custom-elements', '<my-card><p>in custom</p></my-card><x-y>inline <b>bold</b></x-y>'],
  [
    'unknown-block-like',
    '<section><article><header><h2>H</h2></header><footer>F</footer></article></section>'
  ],
  ['center-font', '<center><font color="red">old <u>school</u></font></center>'],
  ['ruby', '<p><ruby>漢<rt>kan</rt>字<rt>ji</rt></ruby></p>'],
  ['address-menu-dir', '<address>a</address><menu><li>m</li></menu><dir><li>d</li></dir>'],
  ['hgroup-main', '<main><hgroup><h1>t</h1><p>sub</p></hgroup></main>'],
  ['div-nesting-text', '<div>a<div>b<div>c</div>d</div>e</div>'],
  ['span-blocks', '<span>a<div>b</div>c</span>'],
  // Callouts
  [
    'callout',
    '<div class="callout" data-callout="note"><div class="callout-title"><div class="callout-title-inner">My Title</div></div><div class="callout-content"><p>Body line</p><p>Second</p></div></div>'
  ],
  [
    'callout-fold-closed',
    '<div class="callout" data-callout="warning" data-callout-fold="-"><div class="callout-title"><div class="callout-title-inner"></div></div><div class="callout-content"><p>Hidden</p></div></div>'
  ],
  [
    'callout-fold-open',
    '<div class="callout" data-callout="tip" data-callout-fold="+"><div class="callout-title"><div class="callout-title-inner">Open</div></div><div class="callout-content"><ul><li>x</li></ul></div></div>'
  ],
  [
    'callout-fold-other',
    '<div class="callout" data-callout="info" data-callout-fold="?"><div class="callout-content"><p>x</p></div></div>'
  ],
  [
    'callout-no-content-wrapper',
    '<div class="callout" data-callout="note"><div class="callout-title"><div class="callout-title-inner">T</div></div><p>direct body</p></div>'
  ],
  ['callout-no-title', '<div class="callout" data-callout="example"><p>just body</p></div>'],
  [
    'callout-title-no-inner',
    '<div class="callout" data-callout="bug"><div class="callout-title">Raw title</div><div class="callout-content"><p>b</p></div></div>'
  ],
  [
    'callout-nested',
    '<div class="callout" data-callout="note"><div class="callout-content"><div class="callout" data-callout="tip"><div class="callout-content"><p>inner</p></div></div></div></div>'
  ],
  [
    'callout-not-class',
    '<div data-callout="note"><p>no class</p></div><div class="callout"><p>no data</p></div>'
  ],
  [
    'callout-empty-body',
    '<div class="callout" data-callout="note"><div class="callout-content"></div></div>'
  ],
  [
    'callout-multiline-body',
    '<div class="callout" data-callout="quote"><div class="callout-content"><p>a</p>\n\n<p>b</p><pre><code>c\nd</code></pre></div></div>'
  ],
  [
    'callout-title-unicode',
    '<div class="callout" data-callout="ünicode"><div class="callout-content"><p>x</p></div></div><div class="callout" data-callout="\u{1d4d0}b"><p>y</p></div>'
  ],
  // Footnotes
  [
    'footnote-citation',
    '<p>Claim<sup id="fnref:1-abc">1</sup> and another<sup id="fnref:note">2</sup>.</p>'
  ],
  ['footnote-citation-not-sup', '<p><span id="fnref:1">x</span><sup id="other">2</sup></p>'],
  [
    'footnote-list',
    '<ol id="footnotes"><li id="fn:1"><p>First <a href="#fnref:1" class="footnote-backref">↩︎</a></p></li><li id="fn:Two"><sup>Two</sup> Second ↩︎</li></ol>'
  ],
  [
    'footnote-list-wikipedia',
    '<div id="footnotes"><ol><li id="cite_note-Smith-1"><sup>^</sup> Smith, J. (2020).</li><li id="mw/cite_note-b_2">Second</li><li id="cite_note-">Empty</li><li id="plain">Plain</li><li>No id</li></ol></div>'
  ],
  [
    'footnote-list-sup-id',
    '<div id="footnotes"><ol><li id="fn:3"><sup>3</sup> Same id <sup>x</sup></li><li id="cite_note-7"><sup> 7 </sup>Trim</li></ol></div>'
  ],
  ['footnote-list-not-in-container', '<ol><li id="fn:1">a</li></ol>'],
  [
    'footnote-list-backlink-spacing',
    '<div id="footnotes"><ol><li id="fn:1">Text   \u21a9\ufe0e</li><li id="fn:2">Other \u21a9</li><li id="fn:3">Mid \u21a9\ufe0e tail</li></ol></div>'
  ],
  [
    'footnote-list-newline-id',
    '<div id="footnotes"><ol><li id="x/cite_note-a\nb">n</li></ol></div>'
  ],
  [
    'footnote-list-nested-ol',
    '<div id="footnotes"><ol><li id="fn:1">a<ol><li>b</li></ol></li></ol></div>'
  ],
  // Clean-up of the result
  [
    'cleanup-empty-link-newlines',
    '<p>a</p>\n<a href="/x"></a>\n<p>b</p><a href="/y"> </a>\n<p>c</p>'
  ],
  ['cleanup-empty-link-bang', '<p>a!<a href="/x"></a>b</p>'],
  ['cleanup-empty-link-first', '<a href="/x"></a><p>b</p>'],
  ['cleanup-empty-link-parens', '<p>a<a href="/x(y)"></a>b</p><p>c<a href="/z"></a></p>'],
  ['cleanup-empty-link-title', '<p>a<a href="/x" title="t"></a>b</p>'],
  ['cleanup-empty-link-multiple', '<p><a href="/a"></a><a href="/b"></a>text</p>'],
  ['cleanup-bang-image', '<p>!<img src="a.png"></p><p>!<a href="/x"><img src="b.png"></a></p>'],
  ['cleanup-title-only', '<h1>Only Title</h1>'],
  ['cleanup-title-crlf', '<h1>Title</h1>\r\n<p>x</p>'],
  ['cleanup-title-unicode-sep', '<h1>A\u2028B</h1><p>x</p>'],
  ['cleanup-two-titles', '<h1>One</h1><h1>Two</h1><p>x</p>'],
  ['cleanup-h1-after-text', 'Intro<h1>Title</h1><p>x</p>'],
  ['cleanup-leading-trailing', '\n\n<p>x</p>\n\n\t'],
  // Parser corners (domino's tree)
  ['parse-unclosed-p', '<p>one<p>two<p>three'],
  ['parse-unclosed-li', '<ul><li>a<li>b<li>c</ul>'],
  ['parse-misnested-formatting', '<p><b>bold <i>both</b> italic</i> plain</p>'],
  ['parse-adoption-agency', '<p><a href="/x">link <b>bold</a> after</b></p>'],
  ['parse-table-in-p', '<p>text<table><tr><td>a</td><td>b</td></tr></table>more</p>'],
  ['parse-nested-forms', '<form><form><input></form></form><p>x</p>'],
  ['parse-headings-nested', '<h1>a<h2>b</h2>c</h1>'],
  ['parse-nested-a', '<a href="/1">one<a href="/2">two</a></a>'],
  ['parse-button-nested', '<button>a<button>b</button></button>'],
  ['parse-dd-dt', '<dl><dt>a<dd>b<dt>c<dd>d</dl>'],
  ['parse-option-implied', '<select><option>a<option>b</select>'],
  ['parse-stray-end-tags', '</div></p></b>text</span></li>'],
  ['parse-br-end-tag', '<p>a</br>b</p>'],
  ['parse-p-end-tag', '</p>after'],
  [
    'parse-body-html-tags',
    '<html><head><title>t</title></head><body class="x"><p>b</p></body></html>'
  ],
  ['parse-frameset', '<frameset><frame src="a"></frameset><p>x</p>'],
  ['parse-image-tag', '<image src="a.png">text'],
  ['parse-isindex', '<isindex prompt="p"><p>x</p>'],
  ['parse-plaintext', '<p>a</p><plaintext><b>raw</b>'],
  [
    'parse-xmp-listing',
    '<xmp><b>raw</b></xmp><listing>\nx</listing><pre>\nfirst newline dropped</pre>'
  ],
  ['parse-entities-attribute', '<a href="/?a=1&amp;b=2&copy=3&notit;=4">x</a>'],
  ['parse-numeric-refs', '<p>&#0; &#128; &#x80; &#150; &#xD800; &#x110000; &#65; &#x41; &#9;</p>'],
  ['parse-no-semicolon-entities', '<p>&copy &amp &lt &gt &nbsp &ampx &notin &not</p>'],
  ['parse-null-chars', '<p>a\u0000b</p><p\u0000>c</p>'],
  ['parse-surrogate-emoji', '<p>😀 a\u{1d4d0}b</p>'],
  ['parse-xml-namespaces', '<p xml:lang="en" xlink:href="x">a</p>'],
  ['parse-math-free-ns', '<svg><title>t</title><desc>d</desc></svg><p>x</p>'],
  ['parse-duplicate-attributes', '<a href="/one" href="/two" class="a" class="b">dup</a>'],
  ['parse-attribute-case', '<A HREF="/up" TITLE="T">x</A><IMG SRC="a.png" ALT="A">'],
  ['parse-attribute-no-value', '<a href>x</a><img src alt>'],
  ['parse-unquoted-attributes', '<a href=/x/y title=hello>x</a><img src=a.png alt=b>'],
  ['parse-tag-in-attribute', '<a title="<b>" href="/x?a<b">x</a>'],
  ['parse-comment-edge', '<!-->a<!--->b<!----><!-- a -- b --!>c'],
  ['parse-conditional-comment', '<!--[if IE]><p>ie</p><![endif]--><p>x</p>'],
  ['parse-bogus-comment', '<p>a<!x>b<?pi?>c</p>'],
  ['parse-unterminated-tag', '<p>a</p><div class="x"'],
  ['parse-unterminated-comment', '<p>a</p><!-- open'],
  ['parse-deep-inline', `${'<span>'.repeat(60)}deep${'</span>'.repeat(60)}`],
  ['parse-wrapper-close', '<p>a</p></x-turndown><p>after wrapper</p>'],
  ['parse-wrapper-nested', '<x-turndown id="turndown-root"><p>inner</p></x-turndown>'],
  ['parse-heading-text-blocks', '<h2>a</h2>b<h3>c</h3>d'],
  ['parse-spaces-in-pre-code', '<pre>  a\n    b\n</pre><p><code>  keep  </code></p>'],
  ['parse-code-in-p-trailing', '<p>x <code>c</code>\n</p><p> <code>d</code></p>'],
  // Math rules: `math`, `katex`, `extractLatex`, `handleNestedEquations`, figure captions
  ['math-inline-mathml', '<p>Let <math><mi>x</mi><mo>=</mo><mn>1</mn></math> be.</p>'],
  ['math-inline-attached', '<p>a<math><mi>x</mi></math>b</p>'],
  ['math-inline-after-dollar', '<p>$<math><mi>x</mi></math>$</p>'],
  ['math-inline-first', '<p><math><mi>x</mi></math> then text</p>'],
  ['math-inline-last', '<p>text then <math><mi>x</mi></math></p>'],
  [
    'math-inline-blank-neighbours',
    '<p> <math><mi>x</mi></math> </p><p>a<!-- c --><math><mi>y</mi></math><!-- d -->b</p>'
  ],
  ['math-inline-astral-neighbour', '<p>😀<math><mi>x</mi></math>😀</p>'],
  [
    'math-block-display',
    '<p>Intro</p><math display="block"><mfrac><mn>1</mn><mn>2</mn></mfrac></math><p>Outro</p>'
  ],
  ['math-block-only-in-paragraph', '<p> <math><msup><mi>x</mi><mn>2</mn></msup></math> </p>'],
  [
    'math-not-only-in-paragraph',
    '<p><math><mi>x</mi></math><span>y</span></p><p><math><mi>x</mi></math>t</p>'
  ],
  [
    'math-in-table',
    '<table><tr><td><math display="block"><mi>x</mi></math></td><td>b</td></tr></table>'
  ],
  ['math-data-latex', '<p>a <math data-latex="\\alpha + \\beta"><mi>x</mi></math> b</p>'],
  [
    'math-data-latex-prose',
    '<p>a <math data-latex="fan-outfan-in"><mfrac><mi>a</mi><mi>b</mi></mfrac></math> b</p>'
  ],
  ['math-data-latex-simple', '<p>a <math data-latex="AB"><mi>A</mi><mi>B</mi></math> b</p>'],
  [
    'math-data-latex-hyphen-simple',
    '<p>a <math data-latex="fan-outfan-in"><mi>f</mi></math> b</p>'
  ],
  ['math-data-latex-empty-mathml', '<p>a <math data-latex="x^2"></math> b</p>'],
  ['math-alttext', '<p>a <math alttext="\\sqrt{2}"><msqrt><mn>2</mn></msqrt></math> b</p>'],
  [
    'math-alttext-untrusted',
    '<p>a <math alttext="hello-world"><mfrac><mi>a</mi><mi>b</mi></mfrac></math> b</p>'
  ],
  [
    'math-latex-fallback-after-failure',
    '<p>a <math data-latex="word-fragment"><mfrac><mi>a</mi></mfrac></math> b</p>'
  ],
  [
    'math-alttext-fallback-after-failure',
    '<p>a <math alttext="word-fragment"><mfrac><mi>a</mi></mfrac></math> b</p>'
  ],
  ['math-failure-no-attrs', '<p>a <math><mfrac><mi>a</mi></mfrac></math> b</p>'],
  ['math-data-latex-short-hyphen', '<p>a <math data-latex="ab-cd"><mi>q</mi></math> b</p>'],
  [
    'math-data-latex-double-backslash',
    '<math display="block" data-latex="a \\\\ b"><mfrac><mi>a</mi><mi>b</mi></mfrac></math>'
  ],
  [
    'math-annotation',
    '<p>a <math><semantics><mi>x</mi><annotation encoding="application/x-tex">x^{2}</annotation></semantics></math> b</p>'
  ],
  [
    'math-annotation-blank',
    '<p>a <math data-latex="\\gamma"><semantics><mi>x</mi><annotation encoding="application/x-tex"> </annotation></semantics></math> b</p>'
  ],
  [
    'math-annotation-other-encoding',
    '<p>a <math><semantics><mi>x</mi><annotation encoding="text/plain">plain</annotation></semantics></math> b</p>'
  ],
  [
    'math-matrix-block',
    '<math display="block"><mtable><mtr><mtd><mi>a</mi></mtd><mtd><mi>b</mi></mtd></mtr></mtable></math>'
  ],
  [
    'math-aligned-equation',
    '<math display="block"><mtable columnalign="right left"><mtr><mtd><mi>a</mi></mtd><mtd><mo>=</mo><mi>b</mi></mtd></mtr></mtable></math>'
  ],
  [
    'math-env-block',
    '<math display="block" data-latex="\\begin{cases} a \\\\ b \\end{cases}"><mi>x</mi></math>'
  ],
  ['math-ampersand-block', '<math display="block" data-latex="a &amp; b"><mi>x</mi></math>'],
  ['math-backslashes-block', '<math display="block" data-latex="a \\\\ b"><mi>x</mi></math>'],
  [
    'math-bare-matrix-latex',
    '<math display="block" data-latex="\\begin{matrix}a &amp; b\\end{matrix}"><mi>x</mi></math>'
  ],
  [
    'math-bare-matrix-nested-env',
    '<math display="block" data-latex="\\begin{matrix}\\begin{array}{c}a\\end{array}\\end{matrix}"><mi>x</mi></math>'
  ],
  ['math-empty-block', '<math display="block"></math>'],
  ['math-nbsp', '<p><math><mi>a</mi><mo>&nbsp;</mo><mi>b</mi></math></p>'],
  ['math-nested-amp-nbsp', '<p><math><mtext>a&amp;nbsp;b</mtext></math></p>'],
  [
    'math-wikipedia-inline',
    '<p>Let <span class="mwe-math-element"><math alttext="{\\displaystyle x}"><semantics><mi>x</mi><annotation encoding="application/x-tex">{\\displaystyle x}</annotation></semantics></math><img class="mwe-math-fallback-image-inline" alt="x"></span> be.</p>'
  ],
  [
    'math-wikipedia-block-after-p',
    '<p>Intro</p><span class="mwe-math-element"><math display="inline"><mi>x</mi></math></span>'
  ],
  [
    'math-wikipedia-fallback-image',
    '<p>a <span class="mwe-math-fallback-image-display" data-latex="x">y</span> b</p><span class="mwe-math-fallback-image-inline" data-latex="z">z</span>'
  ],
  [
    'math-wikipedia-element-class',
    '<p>a <span class="mwe-math-element" data-latex="q">q</span> b</p>'
  ],
  ['math-class-math-inline', '<p>a <span class="math math-inline" data-latex="k">k</span> b</p>'],
  [
    'katex-data-latex-inline',
    '<p>a <span class="katex" data-latex="E=mc^2"><span class="katex-mathml"><math><semantics><mi>E</mi></semantics></math></span></span> b</p>'
  ],
  [
    'katex-block',
    '<span class="katex" data-latex="E=mc^2"><span class="katex-mathml"><math display="block"><mi>E</mi></math></span></span>'
  ],
  [
    'katex-annotation',
    '<span class="katex"><span class="katex-mathml"><math><semantics><mi>x</mi><annotation encoding="application/x-tex">x_1</annotation></semantics></math></span><span class="katex-html">x1</span></span>'
  ],
  [
    'katex-annotation-outside-mathml',
    '<span class="katex"><math><semantics><mi>x</mi><annotation encoding="application/x-tex">x_1</annotation></semantics></math></span>'
  ],
  ['katex-text-fallback', '<span class="katex">  plain text  </span>'],
  ['katex-empty', '<span class="katex"></span>'],
  [
    'katex-math-inline-class',
    '<div class="math math-inline">a+b</div><div class="math math-display">a-b</div>'
  ],
  [
    'katex-no-latex-mathml-block',
    '<span class="katex"><span class="katex-mathml"><math display="block"><mi>x</mi></math></span>t</span>'
  ],
  [
    'katex-annotation-self',
    '<annotation class="katex" encoding="application/x-tex">self</annotation>'
  ],
  [
    'math-figure-caption',
    '<figure><img src="f.png" alt="F"><figcaption>Value <math><mi>x</mi></math> here</figcaption></figure>'
  ],
  [
    'math-figure-caption-edges',
    '<figure><img src="f.png" alt="F"><figcaption><math><mi>x</mi></math></figcaption></figure>'
  ],
  [
    'math-figure-caption-attached',
    '<figure><img src="f.png" alt="F"><figcaption>a<math><mi>x</mi></math>b $<math><mi>y</mi></math>$ c</figcaption></figure>'
  ],
  [
    'math-figure-caption-two',
    '<figure><img src="f.png" alt="F"><figcaption><math><mi>x</mi></math><math><mi>y</mi></math> text <math display="block" data-latex="\\alpha"><mi>z</mi></math></figcaption></figure>'
  ],
  [
    'math-figure-caption-tag',
    '<figure><img src="f.png" alt="F"><figcaption><span class="ltx_tag_figure">Figure 1:</span> The <math alttext="\\beta"><mi>b</mi></math> curve.</figcaption></figure>'
  ],
  [
    'math-figure-caption-newline',
    '<figure><img src="f.png" alt="F"><figcaption>a <math>\n<mi>x</mi></math> b</figcaption></figure>'
  ],
  [
    'math-figure-caption-unclosed',
    '<figure><img src="f.png" alt="F"><figcaption>a <math><mi>x</mi> b</figcaption></figure>'
  ],
  [
    'math-figure-caption-failed',
    '<figure><img src="f.png" alt="F"><figcaption>a <math><mfrac><mi>x</mi></mfrac></math> b</figcaption></figure>'
  ],
  [
    'math-figure-caption-mathml-tag-lookalike',
    '<figure><img src="f.png" alt="F"><figcaption>a <mathx>q</mathx> b</figcaption></figure>'
  ],
  [
    'table-ltx-equation',
    '<table class="ltx_equation"><tr><td><math alttext="a=b"><mi>a</mi></math></td></tr></table>'
  ],
  [
    'table-ltx-eqn-table',
    '<table class="ltx_eqn_table"><tr><td><span class="ltx_eqn_inline"><math><semantics><mi>a</mi><annotation encoding="application/x-tex">a</annotation></semantics></math></span></td><td><math alttext="b"><mi>b</mi></math></td></tr></table>'
  ],
  [
    'table-numblk',
    '<table class="numblk"><tr><td><span class="mwe-math-element-inline"><math alttext="c"><mi>c</mi></math></span></td></tr></table>'
  ],
  ['table-ltx-equation-no-math', '<table class="ltx_equation"><tr><td>plain</td></tr></table>'],
  [
    'table-ltx-equation-no-latex',
    '<table class="ltx_equation"><tr><td><math><mi>a</mi></math></td></tr></table>'
  ],
  ['table-class-near-miss', '<table class="ltx_equationx"><tr><td>a</td><td>b</td></tr></table>'],
  ['math-svg-child', '<p>a <math><svg><title>t</title></svg></math> b</p>'],
  ['math-foreign-child-no-mathml-names', '<p>a <math data-latex="x"><foo>q</foo></math> b</p>'],
  [
    'math-html-child',
    '<math data-latex="x"><annotation-xml encoding="text/html"><div>d</div></annotation-xml></math>'
  ],
  [
    'math-span-class-mi',
    '<p>a <span class="mwe-math-element" data-latex="x"><mi>q</mi></span> b</p>'
  ],
  [
    'math-complex-prose',
    '<p><math data-latex="fan-outfan"><mfrac><mi>a</mi><mi>b</mi></mfrac></math></p>'
  ],
  ['math-simple-prose-no-complex', '<p><math data-latex="fan-outfan"><mi>a</mi></math></p>'],
  [
    'mixed-document',
    '<h1>Doc</h1><p>Intro with <a href="/a">link</a>, <em>em</em>.</p><h2>Items</h2><ul><li>One</li><li>Two <code>x</code></li></ul><blockquote><p>Quote</p></blockquote><pre><code class="language-js">a()</code></pre><table><tr><th>H</th><th>I</th></tr><tr><td>1</td><td>2</td></tr></table><figure><img src="f.png" alt="F"><figcaption>Cap</figcaption></figure>'
  ]
]

export const markdownCases = cases.map(([name, html]) => ({ name, html }))
