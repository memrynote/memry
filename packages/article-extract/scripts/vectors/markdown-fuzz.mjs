// Seeded random inputs for `createMarkdownContent`: token soups of the elements, attributes and
// text its rules and turndown's whitespace handling look at. They reach the parser recoveries
// and rule combinations that single-rule inputs do not enumerate. There is no `select`: html5ever
// 0.40 parses its content as in body (customizable select), domino as the older InSelect mode.
// Defuddle's exact selectors remove `select` before markdown, so only that corner differs.
import { rng } from './dom.mjs'
import { markdownVector } from './markdown.mjs'

const PIECES = [
  '<p>',
  '</p>',
  '<div>',
  '</div>',
  '<span>',
  '</span>',
  '<b>',
  '</b>',
  '<i>',
  '</i>',
  '<em>',
  '</em>',
  '<strong>',
  '</strong>',
  '<a href="/x">',
  '<a href="/a b" title="t">',
  '<a>',
  '</a>',
  '<code>',
  '</code>',
  '<pre>',
  '</pre>',
  '<br>',
  '<hr>',
  '<ul>',
  '</ul>',
  '<ol>',
  '<ol start="3">',
  '</ol>',
  '<li>',
  '</li>',
  '<li class="task-list-item"><input type="checkbox" checked>',
  '<blockquote>',
  '</blockquote>',
  '<figure>',
  '</figure>',
  '<figcaption>',
  '</figcaption>',
  '<h1>',
  '</h1>',
  '<h2>',
  '</h2>',
  '<h3>',
  '</h3>',
  '<table>',
  '</table>',
  '<tbody>',
  '</tbody>',
  '<tr>',
  '</tr>',
  '<td>',
  '</td>',
  '<th>',
  '</th>',
  '<td colspan="2">',
  '<img src="a.png" alt="A">',
  '<img srcset="a.jpg 10w, b.jpg 20w" src="s.jpg">',
  '<iframe src="https://www.youtube.com/embed/abc">',
  '</iframe>',
  '<sup>',
  '</sup>',
  '<sup id="fnref:1">',
  '<sub>',
  '</sub>',
  '<mark>',
  '</mark>',
  '<del>',
  '</del>',
  '<button>',
  '</button>',
  '<svg>',
  '</svg>',
  '<path d="M0">',
  '<script>x</script>',
  '<style>y</style>',
  '<noscript>',
  '</noscript>',
  '<template>',
  '</template>',
  '<textarea>',
  '</textarea>',
  '<form>',
  '</form>',
  '<input>',
  '<div class="callout" data-callout="note">',
  '<div class="callout-content">',
  '<div class="callout-title"><div class="callout-title-inner">T</div></div>',
  '<div id="footnotes">',
  '<li id="fn:1">',
  '<wbr>',
  // Math arrives as closed units: html5ever 0.40 and domino differ on block content inside
  // unclosed foreign elements (`annotation-xml` is no scope boundary in html5ever, and `<table>`
  // or `</p>` inside `mi` or `math` break out differently).
  '<math><mi>x</mi></math>',
  '<math display="block"><mfrac><mi>a</mi><mi>b</mi></mfrac></math>',
  '<math data-latex="a_b"><mi>z</mi></math>',
  '<math alttext="q"><mfrac><mi>a</mi><mi>b</mi></mfrac></math>',
  '<span class="katex" data-latex="k"><span class="katex-mathml"><math><mi>k</mi></math></span></span>',
  '<span class="mwe-math-element"><math><semantics><mi>x</mi><annotation encoding="application/x-tex">w</annotation></semantics></math></span>',
  '<figure><img src="i.png"><figcaption>c <math><mi>m</mi></math> d</figcaption></figure>',
  '<table class="ltx_equation"><tr><td><math alttext="a"><mi>a</mi></math></td></tr></table>',
  '<my-el>',
  '</my-el>',
  '<!-- c -->',
  '<!x>',
  '<details>',
  '</details>',
  '<summary>',
  '</summary>',
  'word',
  'two words',
  ' ',
  '\n',
  '\n\n',
  '\t',
  '\u00a0',
  '\u2003',
  '  spaced  ',
  '- dash',
  '* star',
  '# hash',
  '1. one',
  '> quote',
  '<tag-like>',
  '[x](y)',
  '`tick`',
  'a_b_c',
  '\\back',
  '&amp;',
  '&lt;',
  '&nbsp;',
  '&copy',
  '|pipe|',
  '😀',
  '漢字'
]

export function markdownFuzzVectors(count, seed = 0x3543d2) {
  const random = rng(seed)
  return Array.from({ length: count }, () => {
    const length = 2 + Math.floor(random() * 28)
    let soup = ''
    let svgDepth = 0
    for (let i = 0; i < length; i += 1) {
      const piece = PIECES[Math.floor(random() * PIECES.length)]
      // A `</p>` inside `<svg>` ends the svg in html5ever 0.40 (the current spec) but inserts an
      // empty `<p>` in domino's older foreign content rules.
      if (svgDepth > 0 && piece === '</p>') continue
      if (piece === '<svg>') svgDepth += 1
      if (piece === '</svg>') svgDepth = Math.max(0, svgDepth - 1)
      soup += piece
    }
    return markdownVector(soup)
  })
}
