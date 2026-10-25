// The selector lists the DOM vectors run: every selector literal Defuddle 0.19.0 passes to
// querySelector, querySelectorAll, closest and matches, the joined constants it builds from its
// tables, and hand-written probes of the css-select behaviors the port has to reproduce.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { byCodeUnit, findPackage, packageRoot } from './paths.mjs'

const CALL =
  /\.(?:querySelector|querySelectorAll|closest|matches)\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g

function distFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return entry === 'types' ? [] : distFiles(path)
    return path.endsWith('.js') ? [path] : []
  })
}

/** Selectors written as literals in Defuddle's sources. Template literals with `${}` are skipped. */
function literalSelectors(dist) {
  const found = new Set()
  for (const file of distFiles(dist)) {
    if (file.endsWith('cli.js')) continue
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(CALL)) {
      const [, quote, body] = match
      if (quote === '`' && body.includes('${')) continue
      const selector = body.replace(/\\(['"`\\])/g, '$1')
      if (selector.trim()) found.add(selector)
    }
  }
  return [...found].toSorted(byCodeUnit)
}

/** Selectors built from the constant tables, as selectors.js and defuddle.js join them. */
function constantSelectors(dist) {
  const require = createRequire(join(dist, 'constants.js'))
  const c = require('./constants.js')
  const out = [
    c.EXACT_SELECTORS_JOINED,
    c.HIDDEN_EXACT_SELECTOR,
    c.HIDDEN_EXACT_SKIP_SELECTOR,
    c.TEST_ATTRIBUTES_SELECTOR,
    c.BLOCK_ELEMENTS_SELECTOR,
    c.CONTENT_ELEMENT_SELECTOR,
    c.FOOTNOTE_LIST_SELECTORS,
    c.FOOTNOTE_INLINE_REFERENCES,
    ...c.ENTRY_POINT_ELEMENTS,
    ...c.FOOTNOTE_LIST_SELECTORS.split(','),
    ...c.FOOTNOTE_INLINE_REFERENCES.split(',')
  ]
  return [...new Set(out.filter((s) => typeof s === 'string' && s.trim()))]
}

/**
 * Probes: one selector per css-what and css-select code path the port reimplements, including
 * the ones where css-select differs from the CSS specification, and the selectors it rejects.
 */
export const probes = [
  // Type, universal, class, id, combinators.
  'div',
  'DIV',
  'p',
  '*',
  'body > *',
  'div p',
  'div > p',
  'h1 + p',
  'h2 ~ p',
  'ul li',
  'ul > li',
  'a, p',
  'div  >  p',
  'div>p',
  'p+p',
  'li~li',
  '.a',
  '.a.b',
  'div.a',
  '.A',
  '#main',
  'div#main',
  '#a#b',
  '.a .b',
  '.a > .b',
  '#main p',
  // Attribute operators, quoting, flags, names.
  '[href]',
  '[HREF]',
  '[data-x]',
  '[class]',
  '[id]',
  '[class=""]',
  '[class="a"]',
  '[class=a]',
  '[class~=a]',
  '[class~="a b"]',
  '[class^=a]',
  '[class$=b]',
  '[class*=a]',
  '[class|=a]',
  '[class!=a]',
  '[class!=""]',
  '[class^=""]',
  '[class$=""]',
  '[class*=""]',
  '[class~=""]',
  '[href^="http"]',
  '[href$=".pdf"]',
  '[href*="example"]',
  '[href="https://example.com/"]',
  "[href='x']",
  '[type=text]',
  '[type=TEXT]',
  '[type="text" i]',
  '[type="text" s]',
  '[lang|=en]',
  '[lang=EN]',
  '[rel~=nofollow]',
  '[title="a b"]',
  '[ data-x ]',
  '[data-x = "1" ]',
  '[data-x="a\\"b"]',
  '[data-1]',
  '[ID]',
  '[Data-X]',
  '[data-x][data-y]',
  'a[href][title]',
  'input[type=checkbox][checked]',
  '[hidden]',
  '[aria-hidden=true]',
  '[aria-hidden="true"]',
  '[style*="display:none"]',
  '[style*="display: none"]',
  '[role=dialog]',
  '[itemprop]',
  '[itemtype*="schema.org/Article"]',
  '[data-testid]',
  '[xml\\:lang]',
  // Pseudo classes.
  ':first-child',
  ':last-child',
  ':only-child',
  ':first-of-type',
  ':last-of-type',
  ':only-of-type',
  ':nth-child(2)',
  ':nth-child(odd)',
  ':nth-child(even)',
  ':nth-child(2n+1)',
  ':nth-child(-n+3)',
  ':nth-child(n+2)',
  ':nth-child(n)',
  ':nth-child(0n+0)',
  ':nth-last-child(1)',
  ':nth-last-child(2n)',
  ':nth-of-type(2)',
  ':nth-last-of-type(1)',
  'li:nth-child(3n)',
  'p:nth-of-type(odd)',
  ':empty',
  'p:empty',
  ':root',
  'html:root',
  ':not(p)',
  'div:not(.a)',
  ':not(.a, .b)',
  ':not(div > p)',
  ':not([class])',
  'p:not(:first-child)',
  ':is(h1, h2, h3)',
  ':is(div p, span)',
  ':matches(h1, h2)',
  ':where(h1, h2)',
  ':is(*)',
  ':not(*)',
  'div:has(p)',
  'div:has(> p)',
  'div:has(+ p)',
  'div:has(~ p)',
  'div:has(p, ul)',
  'li:has(a[href])',
  'ul:has(> li:first-child)',
  ':has(img)',
  ':has(> img)',
  'section:has(h2):has(p)',
  ':contains(text)',
  ':contains("a b")',
  ':icontains(TEXT)',
  'p:contains(the)',
  ':checked',
  ':disabled',
  ':enabled',
  ':required',
  ':optional',
  ':selected',
  ':any-link',
  ':link',
  ':parent',
  ':header',
  ':button',
  ':input',
  ':text',
  ':checkbox',
  ':radio',
  ':hover',
  ':visited',
  ':active',
  // :scope and relative selectors.
  ':scope',
  ':scope > p',
  ':scope p',
  ':scope > div > p',
  ':scope + p',
  ':scope ~ p',
  '> p',
  '> div p',
  '+ p',
  ':scope:not(.a)',
  'div:not(:scope)',
  ':scope :not(p)',
  ':scope > :not(.a)',
  ':scope :is(p, a)',
  ':scope > li:first-child',
  ':scope li:has(> a)',
  'p:scope',
  // Escapes, comments, whitespace, namespaces.
  '.a\\:b',
  '#a\\.b',
  '.\\31 23',
  '.a\\62 ',
  '[data-x="\\41"]',
  '.\u00e9l\u00e8ve',
  '.caf\u00e9',
  'div /* c */ p',
  '/* c */ div',
  ' div ',
  'div,p',
  'div , p',
  // Selectors css-select rejects.
  'div:unknown',
  ':hover(x)',
  ':first-child(x)',
  'a::before',
  'a::selection',
  'ns|div',
  '*|div',
  '[ns|a]',
  '[*|a]',
  '|div',
  'div || p',
  ':not()',
  ':is()',
  ':has()',
  ':nth-child()',
  ':nth-child(foo)',
  ':nth-child(2 of .a)',
  ':host',
  ':host(.a)',
  ':contains',
  ':icontains',
  'div >',
  '> ',
  ', div',
  'div,',
  'div > > p',
  '[a',
  '[a=',
  '[a="b',
  ':not(div',
  'div)',
  ':is("a")',
  '.',
  '#',
  '[]',
  'a[b=c d]',
  ':nth-child(2'
]

export function buildSelectors() {
  const dist = join(findPackage(packageRoot, 'defuddle'), 'dist')
  return {
    defuddle: [...literalSelectors(dist), ...constantSelectors(dist)],
    probes
  }
}
