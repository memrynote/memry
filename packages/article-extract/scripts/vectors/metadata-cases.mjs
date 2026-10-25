// Small pages that put each metadata, JSON-LD and boundary rule in front of the oracle. The
// fixtures in the corpus cover whole pages; these cover one rule each, in the combinations
// Defuddle's precedence order makes observable.

const page = (head, body = '<h1>Heading</h1><p>Body.</p>', htmlAttrs = '') =>
  `<!doctype html><html${htmlAttrs}><head>${head}</head><body>${body}</body></html>`

const ld = (json) => `<script type="application/ld+json">${json}</script>`
const prose = (n = 1) =>
  Array.from(
    { length: n },
    (_, i) =>
      `<p>Paragraph ${i + 1} holds enough ordinary words, with a full stop, to read as prose.</p>`
  ).join('')

export const metadataCases = [
  {
    name: 'og full',
    html: page(
      `<title>Fallback title</title>
       <meta property="og:title" content="Post | Brand">
       <meta property="og:site_name" content="Brand">
       <meta property="og:description" content="  An og description  ">
       <meta property="og:image" content="https://cdn.brand.com/i.png">
       <meta property="og:url" content="https://www.brand.com/posts/a">
       <meta property="article:published_time" content="2024-05-06T07:08:09Z">
       <meta name="author" content="By Jane Doe and John Roe">
       <meta name="twitter:title" content="Twitter title">`
    )
  },
  {
    name: 'twitter only',
    html: page(
      `<meta name="twitter:title" content="Tw Title - Newsroom Daily">
       <meta name="twitter:description" content="Tw description">
       <meta name="twitter:image" content="https://t.example/i.jpg">
       <meta name="twitter:url" content="https://t.example/story">`
    )
  },
  {
    name: 'jsonld article graph',
    html: page(
      ld(`{
        // a line comment before the data
        "@context": "https://schema.org",
        "@graph": [
          {"@type":"WebSite","name":"The Daily Planet","url":"https://planet.example/"},
          {"@type":"NewsArticle","headline":"Super &amp; Man","datePublished":"2023-03-04T05:06:07+00:00",
           "author":[{"@type":"Person","name":"Lois Lane"},{"@type":"Person","name":"Clark Kent"},{"@type":"Person","name":"Lois Lane"}],
           "publisher":{"@type":"Organization","name":"Planet Publishing"},
           "image":{"@type":"ImageObject","url":"https://planet.example/s.jpg"},
           "inLanguage":"en_GB","description":"Schema description","articleBody":"Body from schema."}
        ]
      }`)
    )
  },
  {
    name: 'jsonld comment and cdata wrappers',
    html: page(
      `${ld('/* leading */ {"headline":"Block commented","author":{"name":"A. Writer"}} /* trailing */')}
       ${ld('<![CDATA[ {"description":"From cdata"} ]]>')}
       ${ld('  */ {"datePublished":"2020-01-02"} /*  ')}
       ${ld('\n   // only a comment\n   {"name":"Line commented"}\n')}
       ${ld('{"url":"https://x.example/a"} // trailing line comment')}`
    )
  },
  {
    name: 'jsonld broken and odd values',
    html: page(
      `${ld('{"headline": "unterminated')}
       ${ld('null')}
       ${ld('5')}
       ${ld('"a string"')}
       ${ld('[{"headline":"In array"},[{"name":"Nested list"}]]')}
       ${ld('{"b":1,"2":"two","a":3,"1":"one","b":5,"description":"dup keys"}')}
       ${ld('{"@graph":"not an array","headline":"Graph string"}')}
       ${ld('')}`
    )
  },
  {
    name: 'jsonld key order and numbers',
    html: page(
      ld(
        '{"image":[1,2.5,1e21,1e-7,100,0.1],"author":{"name":"N"},"3":{"name":"three"},"1":{"name":"one"},"copyrightHolder":{"name":"Holder"}}'
      )
    )
  },
  {
    name: 'jsonld shadowed hasOwnProperty',
    html: page(ld('{"hasOwnProperty":1,"headline":"Hidden","author":{"name":"A"}}'))
  },
  {
    // `decodeStringsInObject` assigns `newItem['__proto__']`, which sets a prototype instead of an
    // own key; a primitive value is ignored. An object or null value changes lookups in ways the
    // port does not model (see `schema_org::decode_strings`), so it has no case here.
    name: 'jsonld proto key with a primitive value',
    html: page(ld('{"__proto__":"ignored","headline":"Proto","author":{"name":"A","__proto__":5}}'))
  },
  {
    name: 'placeholders',
    html: page(
      `<title>Real title</title>
       <meta property="og:title" content="{{title}}">
       <meta name="twitter:title" content="#author.fullName}">
       <meta name="author" content=". .">
       <meta name="description" content="-">
       <meta property="og:description" content="Real description">
       <meta property="og:site_name" content="___">
       <meta name="application-name" content="Fallback App">`
    )
  },
  {
    name: 'title and h1 only',
    html: page('<title> Guide to Rust - Example Docs </title>', '<h1>Guide to Rust</h1>')
  },
  {
    name: 'title equals domain name',
    html: page(
      `<title>Example</title>
       <meta property="og:url" content="https://www.example.com/post">`,
      '<h1>The real heading</h1>'
    )
  },
  {
    name: 'title equals site name and author',
    html: page(
      `<meta property="og:title" content="Brand Blog">
       <meta property="og:site_name" content="Brand Blog">
       <meta name="author" content="Pat Smith">
       <title>Pat Smith</title>`,
      '<h1>Actual headline</h1>'
    )
  },
  {
    name: 'site name too long and author as site',
    html: page(
      `<meta property="og:site_name" content="This is the whole page title not a site">
       <meta name="author" content="Solo Writer">
       <title>A Post</title>`
    )
  },
  {
    name: 'site name from copyright and domain fallback',
    html: page(
      `<meta name="copyright" content="Copyright Holder Inc">
       <link rel="canonical" href="https://www.holder.example/x">
       <title>Post | Holder Inc</title>`
    )
  },
  {
    name: 'domain only site',
    html: page(
      `<link rel="canonical" href="https://news.example.org/a">
       <title>Plain title</title>
       <meta name="author" content="A, B">`
    )
  },
  {
    name: 'relative and invalid canonical',
    html: page('<link rel="canonical" href="/relative/path"><title>Rel</title>')
  },
  {
    name: 'rel author',
    html: page(
      '<title>T</title>',
      `<h1>H</h1><a rel="author" href="/a">Ann Author</a>
       <address rel="author">Bob <script>x()</script><style>.a{}</style> Builder</address>
       <a rel="author nofollow" href="/c">Author</a>`
    )
  },
  {
    name: 'rel author duplicates',
    html: page(
      '<title>T</title>',
      `<a rel="author" href="/a">Ann Author</a><a rel="author" href="/d">Ann Author</a><a rel="author" href="/e">AUTHORS</a>`
    )
  },
  {
    name: 'rel author too many',
    html: page(
      '<title>T</title>',
      `<a rel="author" href="/1">One</a><a rel="author" href="/2">Two</a><a rel="author" href="/3">Three</a><a rel="author" href="/4">Four</a>
       <span class="author">Fallback Person</span>`
    )
  },
  {
    name: 'author elements',
    html: page(
      '<title>T</title>',
      `<div itemprop="author"><span>Cara Writer</span> <em>Staff reporter and editor of things</em></div>
       <div class="author">Cara Writer, Dan Editor</div>
       <div class="authors"><a href="/x">Dan Editor</a><a href="/y">Eve Reporter Jones</a></div>`
    )
  },
  {
    name: 'author superstrings and limit',
    html: page(
      '<title>T</title>',
      `<div itemprop="author">Ann</div><div itemprop="author">Ann Lee</div><div itemprop="author">Bo</div>
       <div itemprop="author">C1</div><div itemprop="author">C2</div><div itemprop="author">C3</div>
       <div itemprop="author">C4</div><div itemprop="author">C5</div><div itemprop="author">C6</div>
       <div itemprop="author">C7</div><div itemprop="author">C8</div><div itemprop="author">C9</div>`
    )
  },
  {
    name: 'author too many class matches',
    html: page(
      '<title>T</title>',
      `<p class="author">A1</p><p class="author">A2</p><p class="author">A3</p><p class="author">A4</p>
       <h1>Heading</h1>`
    )
  },
  {
    name: 'author by link next to date',
    html: page(
      '<title>T</title>',
      `<h1>Headline</h1><div><a href="/jane">Jane&nbsp;Doe</a> on 26 February 2025</div><p>Body text.</p>`
    )
  },
  {
    name: 'author paragraph next to date',
    html: page(
      '<title>T</title>',
      `<h1>Headline</h1><div><p>Written by Sam Smith</p><p>March 3, 2024</p></div><p>Body text.</p>`
    )
  },
  {
    name: 'author several links next to date',
    html: page(
      '<title>T</title>',
      `<h1>Headline</h1><div><a href="/a">News</a> <a href="/b">World</a> 3 March 2024</div>`
    )
  },
  {
    name: 'byline before and after heading',
    html: page(
      '<title>T</title>',
      `<div class="top"><span>By Ann Lee</span></div><div><h1>Headline</h1></div><p>Body</p>`
    )
  },
  {
    name: 'byline in ancestor siblings',
    html: page(
      '<title>T</title>',
      `<p>intro</p><section><div><h1>Headline</h1></div></section><address>By Chris Ward</address>`
    )
  },
  {
    name: 'byline lowercase and long',
    html: page(
      '<title>T</title>',
      `<h1>Headline</h1><p>by someone lowercase</p><p>By A very very very very very very very long byline text here</p>`
    )
  },
  {
    name: 'citation authors',
    html: page(
      `<meta name="citation_author" content="Doe, Jane">
       <meta name="citation_author" content="Roe, Richard, Jr.">
       <meta name="citation_author" content="Plain Name">
       <meta name="citation_author" content="Odd,Comma">
       <meta name="citation_author" content="{{placeholder}}">
       <meta name="dc.creator" content="Ignored, Person">`
    )
  },
  {
    name: 'dublin core creator',
    html: page(
      `<meta property="dc.creator" content="Last, First">
       <meta property="dc.creator" content="Second Person">`
    )
  },
  {
    name: 'citation author multi-line',
    html: page('<meta name="citation_author" content="Doe,\nJane">')
  },
  {
    name: 'published sources',
    html: page(
      `<meta name="publishDate" content="2022-02-02">
       <meta property="article:published_time" content="2021-01-01">`,
      '<abbr itemprop="datePublished" title=" 2020-12-12 ">x</abbr><time datetime="2019-01-01">y</time>'
    )
  },
  {
    name: 'time elements and links',
    html: page(
      `<meta property="og:url" content="https://site.example/blog/post/">`,
      `<article><a href="/blog/other"><time datetime="2020-02-02">Feb 2</time></a></article>
       <a href="/blog/post"><time>3 March 2021</time></a>`
    )
  },
  {
    name: 'time in external and anchor links',
    html: page(
      `<meta property="og:url" content="https://site.example/blog/post">`,
      `<a href="#top"><time datetime="2020-02-02"></time></a>
       <a href="https://twitter.com/x/1"><time datetime=" 2021-03-03 "></time></a>`
    )
  },
  {
    name: 'time in link without page url',
    html: page('', `<a href="/other"><time datetime="2020-02-02"></time></a>`)
  },
  {
    name: 'date after heading',
    html: page('', `<h1>Headline</h1><div>Posted June 5, 2023 by team</div><p>Body</p>`)
  },
  {
    name: 'date before heading',
    html: page(
      '',
      `<div><p>Blog | March 1, 2026</p><time>5 April 2026</time></div><h1>Headline</h1><p>Body</p>`
    )
  },
  {
    name: 'date before heading only loose text',
    html: page('', `<div>Blog | March 1, 2026</div><h1>Headline</h1>`)
  },
  {
    name: 'favicon sources',
    html: page(
      `<link rel="shortcut icon" href="/short.ico"><link rel="icon" href="/icon.png">
       <meta property="og:url" content="https://f.example/x">`
    )
  },
  {
    name: 'favicon shortcut and default',
    html: page(
      `<link rel="shortcut icon" href="/short.ico"><meta property="og:url" content="https://f.example/x">`
    )
  },
  {
    name: 'favicon built from base',
    html: page(`<meta property="og:url" content="http://f.example/deep/x?y=1">`)
  },
  {
    name: 'favicon no http base',
    html: page(`<meta property="og:url" content="ftp://f.example/x">`)
  },
  {
    name: 'favicon from meta',
    html: page(
      `<meta property="og:image:favicon" content="https://m.example/f.png"><link rel="icon" href="/i.png">`
    )
  },
  {
    name: 'language sources',
    html: page('<meta name="content-language" content="fr_CA">', '<h1>x</h1>')
  },
  {
    name: 'language html lang',
    html: page('<meta name="content-language" content="fr_CA">', '<h1>x</h1>', ' lang=" pt_BR "')
  },
  {
    name: 'language http-equiv',
    html: page('<meta http-equiv="CONTENT-LANGUAGE" content=" de_AT ">')
  },
  {
    name: 'language from schema and og locale',
    html: page(`<meta property="og:locale" content="es_ES">${ld('{"inLanguage":"it_IT"}')}`)
  },
  {
    name: 'language schema only',
    html: page(ld('{"inLanguage":"it_IT"}'))
  },
  {
    name: 'entities in meta content',
    html: page(
      `<meta property="og:title" content="Tom &amp;amp; Jerry &lt;b&gt; &#169; &copy &nbsp;x">
       <meta name="description" content="a &quot;quoted&quot; &amp; done">`
    )
  },
  {
    name: 'meta attribute case',
    html: page(
      `<META NAME="Description" CONTENT="  Upper meta  ">
       <meta name="OG:SITE_NAME" content="Upper Site">
       <meta property="OG:TITLE" content="Upper Title | Upper Site">`
    )
  },
  {
    name: 'meta without content',
    html: page(
      `<meta name="description"><meta name="description" content=""><meta name="description" content="x">`
    )
  },
  {
    name: 'bare text document',
    html: 'just some text'
  },
  {
    name: 'content start with prose',
    html: page(
      '<title>Prose Title</title>',
      `<header><p>Site header paragraph with many words, and a stop.</p></header>
       <nav><p>Navigation paragraph with many words, and a stop right here.</p></nav>
       <h1>Prose Title</h1>
       <p>By Ann Lee</p>
       <p>March 3, 2024</p>
       ${prose(3)}`
    )
  },
  {
    name: 'content start container drill down',
    html: page(
      '<title>T</title>',
      `<div><div><div>
         <div><span>Navigation words only here and there no stop</span></div>
         <div><p>This wrapper paragraph has plenty of words, and sentences. Truly.</p></div>
       </div></div></div>`
    )
  },
  {
    name: 'content start multiple qualifying children',
    html: page(
      '<title>T</title>',
      `<section><div><p>First paragraph has enough words in it, ending here.</p></div>
       <div><p>Second paragraph has enough words in it, ending here too.</p></div></section>`
    )
  },
  {
    name: 'content start skips junk',
    html: page(
      '<title>T</title>',
      `<div role="dialog"><p>Dialog paragraph with many words in it, and a stop.</p></div>
       <p class="isHidden">Hidden paragraph with many words in it, and a stop.</p>
       <p class="x is-hidden y">Hidden again with many words in it, and a stop.</p>
       <p class="isHidden-big">Hidden with suffix and many words in it, and stop.</p>
       <p class="notisHidden">Visible paragraph with many words in it, and a stop.</p>`
    )
  },
  {
    name: 'content start byline date and links',
    html: page(
      '<title>T</title>',
      `<p>By Jane Smith, reporter at the paper of record, today.</p>
       <p>Posted Jan 5 2024 with a few more words in the line.</p>
       <p><a href="/a">Link text only paragraph with many many words, yes.</a></p>
       <p>2024-05-06 and then a sentence, with words enough to count here.</p>
       <p>By the residue theorem, the integral over the contour is zero, so we conclude, as promised, the claim.</p>`
    )
  },
  {
    name: 'content start script and no punctuation',
    html: page(
      '<title>T</title>',
      `<p>Paragraph with a script <script>var a = 1;</script> inside it, and many words.</p>
       <p>No sentence punctuation here but plenty of words in this paragraph</p>
       <div><span>Span only text, with many words, and a stop here ok.</span></div>`
    )
  },
  {
    name: 'content start title heading anchor',
    html: page(
      '<title>My Post</title>',
      `<p>Early prose paragraph with enough words in it, ending here.</p>
       <h2>My Post</h2><p>Later prose paragraph with enough words in it, ending here.</p>`
    )
  },
  {
    name: 'content start none',
    html: page('<title>T</title>', '<p>Too short.</p><div>Nothing</div>')
  },
  {
    name: 'content start cjk and font',
    html: page(
      '<title>T</title>',
      `<font>Font tag content with many words in it, and a full stop.</font>
       <blockquote>Quote content with many words in it, and a full stop.</blockquote>`
    )
  },
  {
    name: 'position quirks',
    html: page(
      '<title>T</title>',
      `<div id="a"><p>Shallow before.</p><div><div><p>Deeper before.</p></div></div></div>
       <section><div><p>Boundary paragraph holds many words in it, and a stop.</p></div></section>
       <div id="z"><p>Shallow after.</p></div>`
    )
  },
  {
    name: 'svg paragraphs',
    html: page(
      '<title>T</title>',
      `<svg><foreignObject><div class="isHidden"><p>SVG paragraph with many words in it, and a stop.</p></div></foreignObject></svg>
       <div class="isHidden"><p>HTML wrapper with many words in it, and a stop.</p></div>`
    )
  }
]
