// Vectors for `MathMLToLaTeX.convert` (mathml-to-latex 1.8.0 on the repo's pinned xmldom 0.8.15):
// hand-written inputs for every element converter and every xmldom recovery path, and seeded
// token soups of MathML. Each expected value is the string the library returns, or an error flag
// where it throws.
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { rng } from './dom.mjs'
import { dist } from './probes.mjs'

const require = createRequire(join(dist, 'x.js'))
const { MathMLToLaTeX } = require('mathml-to-latex')

export function mathmlVector(input) {
  try {
    return { input, ok: MathMLToLaTeX.convert(input).toWellFormed() }
  } catch (error) {
    return { input, error: error.constructor.name }
  }
}

const m = (body, attrs = '') => `<math${attrs}>${body}</math>`
const mi = (x, attrs = '') => `<mi${attrs}>${x}</mi>`
const mo = (x, attrs = '') => `<mo${attrs}>${x}</mo>`
const mn = (x) => `<mn>${x}</mn>`

export const mathmlCases = [
  m(mi('x') + mo('=') + mn('1')),
  m(mi('x') + mo('+') + mi('y')),
  m('<mrow>' + mi('a') + mo('+') + mi('b') + '</mrow>'),
  '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><mi>x</mi></math>',
  '<mml:math><mml:mi>x</mml:mi></mml:math>',
  '<math>\n  <mi>x</mi>\r\n  <mo>=</mo>\r<mn>2</mn>\n</math>',
  // identifiers
  ...[
    'bold',
    'italic',
    'bold-italic',
    'double-struck',
    'bold-fraktur',
    'script',
    'bold-script',
    'fraktur',
    'sans-serif',
    'bold-sans-serif',
    'sans-serif-italic',
    'sans-serif-bold-italic',
    'monospace',
    'normal',
    ''
  ].map((v) => m(mi('R', ` mathvariant="${v}"`))),
  m(mi('α') + mi('β') + mi('Γ') + mi('∞') + mi('ℝ') + mi('ℏ')),
  m(mi('é') + mi('à') + mi('ä') + mi('ñ') + mi('ǎ') + mi('Ž') + mi('ẑ') + mi('ȇ')),
  m(mi('𝐀') + mi('𝐁') + mi('𝚯') + mi('𝚭') + mi('Ε') + mi('𝛀')),
  m(mi(' ') + mi('  ') + mi('') + mi('\u00a0') + mi('x y')),
  m(mi('x1') + mi('sin') + mi('constructor') + mi('toString') + mi('__proto__')),
  m(mi('½') + mi('⅓') + mi('①') + mi('⑩') + mi('㊿') + mi('₀') + mi('²') + mi('ⁿ')),
  // operators
  m(
    mo('∑') +
      mo('∏') +
      mo('∫') +
      mo('∮') +
      mo('∬') +
      mo('±') +
      mo('×') +
      mo('÷') +
      mo('·') +
      mo('−')
  ),
  m(
    mo('→') +
      mo('←') +
      mo('⇒') +
      mo('⟹') +
      mo('≤') +
      mo('≥') +
      mo('≠') +
      mo('≈') +
      mo('∈') +
      mo('∉')
  ),
  m(
    mo('&amp;') +
      mo('&lt;') +
      mo('&gt;') +
      mo('%') +
      mo('\\') +
      mo('^') +
      mo('~') +
      mo('_') +
      mo('!') +
      mo('√')
  ),
  m(mo('⁡') + mo('⁢') + mo('⁣') + mo('⁤') + mo('′') + mo('″') + mo('‴') + mo('∂') + mo('∇') + mo('¬')),
  m(mo(' + ') + mo('\n+\n') + mo('') + mo('toString') + mo('hasOwnProperty')),
  m(mn('42') + mn(' 3.14 ') + mn('') + mn('½') + mn('constructor') + mn('٣')),
  // structure
  m('<msqrt>' + mn('2') + '</msqrt>'),
  m('<msqrt>' + mi('a') + mo('+') + mi('b') + '</msqrt>'),
  m('<mroot>' + mi('x') + mn('3') + '</mroot>'),
  m('<mroot>' + mi('x') + '</mroot>'),
  m('<mfrac>' + mn('1') + mn('2') + '</mfrac>'),
  m('<mfrac>' + mn('1') + '</mfrac>'),
  m('<mfrac>' + mn('1') + mn('2') + mn('3') + '</mfrac>'),
  m('<mfrac bevelled="true">' + mn('1') + mn('2') + '</mfrac>'),
  m(
    '<mfrac bevelled="true"><mrow>' + mi('a') + mo('+') + mi('b') + '</mrow>' + mn('2') + '</mfrac>'
  ),
  m('<mfrac bevelled="">' + mn('1') + mn('2') + '</mfrac>'),
  ...[
    '0',
    '0px',
    '1',
    '2',
    '0.5',
    '.5',
    '-1',
    '1.5pt',
    '2em',
    '3px',
    '50%',
    'thin',
    'thick',
    'medium',
    'THICK',
    ' 2 PT ',
    '1e3',
    'abc',
    '1.',
    '10cm',
    '1.25mm',
    '7in',
    '0.0001',
    '99999999999999999999999',
    '3q',
    '0.001px',
    '0.005px',
    '-0.001px',
    '0.0005%'
  ].map((t) => m(`<mfrac linethickness="${t}">` + mn('1') + mn('2') + '</mfrac>')),
  m('<msub>' + mo(' + ') + mn('1') + '</msub>'),
  m(mo(' | ') + mi('x') + mo('|')),
  m('<msup>' + mi('x') + mn('2') + '</msup>'),
  m('<msup><mrow>' + mi('x') + mi('y') + '</mrow>' + mn('2') + '</msup>'),
  m('<msup><mi>xy</mi>' + mn('2') + '</msup>'),
  m('<msup>' + mi('x') + '</msup>'),
  m('<msub>' + mi('x') + mn('1') + '</msub>'),
  m('<msub><mrow>' + mi('x') + mi('y') + '</mrow>' + mn('1') + '</msub>'),
  m('<msubsup>' + mi('x') + mn('1') + mn('2') + '</msubsup>'),
  m('<msubsup><mrow>' + mi('x') + mi('y') + '</mrow>' + mn('1') + mn('2') + '</msubsup>'),
  m('<msubsup>' + mi('x') + mn('1') + '</msubsup>'),
  m('<munderover>' + mo('∑') + mi('i') + mi('n') + '</munderover>'),
  m('<munderover>' + mo('∑') + mi('i') + '</munderover>'),
  m('<mover>' + mi('x') + mo('^') + '</mover>'),
  m('<mover>' + mi('x') + mo('¯') + '</mover>'),
  m('<mover>' + mi('x') + mo('→') + '</mover>'),
  m('<mover>' + mi('x') + mo('⏞') + '</mover>'),
  m('<munder>' + mi('x') + mo('⏟') + '</munder>'),
  m('<munder>' + mi('x') + mo('_') + '</munder>'),
  m('<munder>' + mi('x') + '</munder>'),
  m('<mmultiscripts>' + mi('X') + mi('a') + mi('b') + '</mmultiscripts>'),
  m(
    '<mmultiscripts>' +
      mi('X') +
      '<none/>' +
      mi('b') +
      '<mprescripts/>' +
      mi('c') +
      '<none/></mmultiscripts>'
  ),
  m('<mmultiscripts>' + mi('Xy') + mi('a') + '</mmultiscripts>'),
  m('<mmultiscripts><mrow></mrow>' + mi('a') + mi('b') + '</mmultiscripts>'),
  m('<mmultiscripts/>'),
  m('<mmultiscripts>' + mi('X') + '<none/><none/><mprescripts/><none/><none/></mmultiscripts>'),
  m(
    '<mmultiscripts>' +
      mi('X') +
      mi('a') +
      mi('b') +
      mi('c') +
      '<mprescripts/>' +
      mi('d') +
      '</mmultiscripts>'
  ),
  // text
  m('<mtext>hello world</mtext>'),
  m('<mtext>a+b = c</mtext>'),
  m('<mtext>  </mtext>'),
  m('<mtext></mtext>'),
  m('<mtext>é→ü 日本</mtext>'),
  ...[
    'bold',
    'italic',
    'bold-italic',
    'double-struck',
    'monospace',
    'bold-fraktur',
    'fraktur',
    'normal',
    'sans-serif',
    ''
  ].map((v) => m(`<mtext mathvariant="${v}">ab cd</mtext>`)),
  m('<mtext>a<!-- c -->b</mtext>'),
  m('<mtext><![CDATA[x]]></mtext>'),
  // fences and tables
  m('<mfenced>' + mi('a') + mi('b') + '</mfenced>'),
  m('<mfenced open="[" close="]">' + mi('a') + mi('b') + mi('c') + '</mfenced>'),
  m('<mfenced open="{" close="}" separators=";">' + mi('a') + mi('b') + mi('c') + '</mfenced>'),
  m('<mfenced open="|" close="|" separators="">' + mi('a') + mi('b') + '</mfenced>'),
  m('<mfenced open="‖" close="‖">' + mi('a') + '</mfenced>'),
  m(
    '<mfenced open="⟨" close="⟩" separators=",;">' +
      mi('a') +
      mi('b') +
      mi('c') +
      mi('d') +
      '</mfenced>'
  ),
  m('<mfenced separators=", ;">' + mi('a') + mi('b') + mi('c') + '</mfenced>'),
  m('<mfenced open close>' + mi('a') + '</mfenced>'),
  m('<mfenced></mfenced>'),
  ...[
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
    ['|', '|'],
    ['‖', '‖'],
    ['||', '||'],
    ['<', '>'],
    ['', ''],
    ['(', ']']
  ].map(([o, c]) =>
    m(
      `<mfenced open="${o}" close="${c}"><mtable><mtr><mtd>${mi('a')}</mtd><mtd>${mi('b')}</mtd></mtr><mtr><mtd>${mi('c')}</mtd><mtd>${mi('d')}</mtd></mtr></mtable></mfenced>`
    )
  ),
  m(
    '<mtable><mtr><mtd>' +
      mi('a') +
      '</mtd><mtd>' +
      mi('b') +
      '</mtd></mtr><mtr><mtd>' +
      mi('c') +
      '</mtd></mtr></mtable>'
  ),
  m(
    '<mtable columnalign="right left"><mtr><mtd>' +
      mi('a') +
      '</mtd><mtd>' +
      mo('=') +
      mi('b') +
      '</mtd></mtr></mtable>'
  ),
  m(
    '<mtable><mtr columnalign="right"><mtd columnalign="left">' + mi('a') + '</mtd></mtr></mtable>'
  ),
  m('<mtable columnalign="right"><mtr><mtd>' + mi('a') + '</mtd></mtr></mtable>'),
  m('<mtable columnalign="  right   left "><mtr><mtd>' + mi('a') + '</mtd></mtr></mtable>'),
  m('<mtr><mtd>' + mi('a') + '</mtd><mtd>' + mi('b') + '</mtd></mtr>'),
  m(
    '<mtable><mtr><mtd><mtable><mtr><mtd>' + mi('a') + '</mtd></mtr></mtable></mtd></mtr></mtable>'
  ),
  m(
    '<mrow>' +
      mo('{') +
      '<mtable><mtr><mtd>' +
      mi('x') +
      '</mtd></mtr><mtr><mtd>' +
      mi('y') +
      '</mtd></mtr></mtable></mrow>'
  ),
  m(
    '<mrow>' +
      mo('{') +
      '<mtable><mtr><mtd>' +
      mi('x') +
      '</mtd></mtr></mtable>' +
      mo('') +
      '</mrow>'
  ),
  m(
    '<mrow>' +
      mo('{') +
      '<mtable><mtr><mtd>' +
      mi('x') +
      '</mtd></mtr></mtable>' +
      mo('}') +
      '</mrow>'
  ),
  m('<mrow>' + mo('(') + mi('x') + mo(')') + '</mrow>'),
  m(mo('(') + mi('x') + mo('+') + mi('y') + mo(')')),
  m(mo('[') + mi('x') + mo(')')),
  m(mo('(') + mo('[') + mi('x') + mo(']') + mo(')')),
  m(mo('(') + mi('x')),
  m(mi('x') + mo(')')),
  m(mo('|') + mi('x') + mo('|')),
  m(mo('|') + mi('x') + mo('|') + mo('+') + mo('|') + mi('y') + mo('|')),
  m(mo('|') + mi('x')),
  m(mo('‖') + mi('x') + mo('‖')),
  m(mo('∥') + mi('x') + mo('∥')),
  m(mo('|') + mi('x') + mo('‖')),
  m(mo('(') + mo('|') + mi('x') + mo('|') + mo(')')),
  m(mo('|') + mo('(') + mi('x') + mo('|')),
  m(mo('|') + '<msup>' + mo('|') + mn('2') + '</msup>'),
  m(mo('|') + mi('x') + '<msup>' + mo('|') + mn('2') + '</msup>'),
  m(mo('|') + mi('x') + '<msub><mrow>' + mo('|') + '</mrow>' + mn('2') + '</msub>'),
  m(mo('|') + mi('x') + '<msubsup>' + mo('|') + mn('1') + mn('2') + '</msubsup>'),
  m(mo('|') + mi('x') + '<msup>' + mo('‖') + mn('2') + '</msup>'),
  m(mo('|') + mi('x') + '<msup></msup>'),
  m(mo('(') + mi('x') + mo(')') + '<mfenced>' + mo('(') + mi('y') + mo(')') + '</mfenced>'),
  m(mo('{') + mi('x') + mo('}')),
  m(mo('(') + mo(')')),
  // other elements
  m('<maction>' + mi('a') + mi('b') + '</maction>'),
  m('<maction actiontype="toggle">' + mi('a') + mi('b') + '</maction>'),
  m('<maction actiontype="tooltip">' + mi('a') + mi('b') + '</maction>'),
  m('<maction actiontype="statusline"></maction>'),
  ...[
    'actuarial',
    'radical',
    'box',
    'roundedbox',
    'circle',
    'left',
    'right',
    'top',
    'bottom',
    'updiagonalstrike',
    'downdiagonalstrike',
    'updiagonalarrow',
    'verticalstrike',
    'horizontalstrike',
    'madruwb',
    'phasorangle',
    'longdiv',
    'other',
    ''
  ].map((n) => m(`<menclose notation="${n}">${mi('a')}${mi('b')}</menclose>`)),
  m('<menclose>' + mi('a') + '</menclose>'),
  m('<merror>' + mi('a') + '</merror>'),
  m('<mphantom>' + mi('a') + '</mphantom>'),
  m('<mphantom><mfrac>' + mi('a') + '</mfrac></mphantom>'),
  m('<mpadded>' + mi('a') + mi('b') + '</mpadded>'),
  m('<mspace/>'),
  m(mi('a') + '<mspace/>' + mi('b')),
  m(mi('a') + '<mspace linebreak="newline"/>' + mi('b')),
  m(mi('a') + '<mspace width="1em"></mspace>' + mi('b')),
  m('<mstyle displaystyle="true">' + mi('a') + '</mstyle>'),
  m(
    '<semantics><mrow>' +
      mi('x') +
      '</mrow><annotation encoding="application/x-tex">x</annotation></semantics>'
  ),
  m(
    '<semantics><mi>x</mi><annotation-xml encoding="MathML-Content"><ci>x</ci></annotation-xml></semantics>'
  ),
  m('<unknown>' + mi('a') + '<other/>text</unknown>'),
  m('<mi>a</mi>text<mi>b</mi>'),
  m('<mrow>text' + mi('a') + '</mrow>'),
  m('<mrow><!-- c -->' + mi('a') + '</mrow>'),
  m('<mi>a<!-- c -->b</mi>'),
  m('<mi><![CDATA[x]]></mi>'),
  m('<mrow><![CDATA[x]]>' + mi('a') + '</mrow>'),
  m('<mrow><?pi data?>' + mi('a') + '</mrow>'),
  m('<constructor>' + mi('a') + '</constructor>'),
  m('<hasOwnProperty>' + mi('a') + '</hasOwnProperty>'),
  m('<__proto__>' + mi('a') + '</__proto__>'),
  m('<toString/>'),
  // several math elements and nesting
  m(mi('a')) + m(mi('b')),
  m(mi('a')) + ' text ' + m(mi('b')),
  m(mi('a') + m(mi('b'))),
  m(m(mi('a'))),
  '<div>' + m(mi('a')) + '</div>',
  '<other>' + m(mi('a')) + '</other>' + m(mi('b')),
  '<mi>x</mi>',
  'plain text',
  '',
  ' ',
  '<math/>',
  '<math></math>',
  '<math> </math>',
  // xmldom recoveries
  '<math><mi>x</mi></mn></math>',
  '<math><mi>x</MI></math>',
  '<math><mi>x</MI></mi></math>',
  '<math><mi>x</Mi><mi>y</mi></math>',
  '<math><mi>x</mi>',
  '<math><mi>x',
  '<math><mi>x</mi></math></math>',
  '<math><mi>x</mi></math><mi>y</mi>',
  '<math><mi>x</mi></ math>',
  '<math><mi>x</mi></math',
  '<math><mi>x</mi></math\n>',
  '<math><mi>x</mi></math bogus>',
  '<math><mi>x</mi></math <',
  '<math><mi>x</mi><',
  '<math><mi>x</mi>< mi>y</mi></math>',
  '<math><mi>x</mi><1>y</1></math>',
  '<math><mi>x</mi><a b="1" b="2"/></math>',
  '<math><mi a=1>x</mi></math>',
  "<math><mi a='1'>x</mi></math>",
  '<math><mi a=1 b=2>x</mi></math>',
  '<math><mi a="1"b="2">x</mi></math>',
  '<math><mi a>x</mi></math>',
  '<math><mi a b>x</mi></math>',
  '<math><mi a = "1">x</mi></math>',
  '<math><mi a =>x</mi></math>',
  '<math><mi a="1>x</mi></math>',
  "<math><mi a='1>x</mi></math>",
  '<math><mi =1>x</mi></math>',
  '<math><mi 1a="1">x</mi></math>',
  '<math><mi a/>x</math>',
  '<math><mi/ >x</mi></math>',
  '<math><mi / >x</mi></math>',
  '<math><mi a=b/>x</mi></math>',
  '<math><mi a="b"/>x<mn>1</mn></math>',
  '<math><mi>x &amp; y &lt; &gt; &quot; &apos; &nbsp; &foo; &#65; &#x42; &#x1F600; &#xZZ; &#; &</mi></math>',
  '<math><mi a="&amp;&#65;&foo;\t\n">x</mi></math>',
  '<math><mo>&#8721;</mo><mo>&#x2211;</mo></math>',
  '<math><mo>&#x110000;</mo><mo>&#xD800;</mo><mo>&#99999999999;</mo></math>',
  '<math xmlns:m="http://www.w3.org/1998/Math/MathML"><m:mi>x</m:mi></math>',
  '<m:math xmlns:m="http://www.w3.org/1998/Math/MathML"><m:mi>x</m:mi></m:math>',
  '<math xmlns="http://www.w3.org/1999/xhtml"><script>a<b</script><mi>x</mi></math>',
  '<math xmlns="http://www.w3.org/1999/xhtml"><textarea>a&amp;b</textarea><mi>x</mi></math>',
  '<math xmlns="http://www.w3.org/1999/xhtml"><script>ab</script><mi>x</mi></math>',
  '<math xmlns="http://www.w3.org/1999/xhtml"><script>a<b<mi>x</mi></math>',
  '<math xmlns="http://www.w3.org/1999/xhtml"><p/><mi>x</mi></math>',
  '<?xml version="1.0"?><math><mi>x</mi></math>',
  '<?xml version="1.0"<math><mi>x</mi></math>',
  '<?pi?><math><mi>x</mi></math>',
  '<!DOCTYPE math><math><mi>x</mi></math>',
  '<!DOCTYPE math PUBLIC "-//W3C//DTD MathML 2.0//EN" "http://www.w3.org/Math/DTD/mathml2/mathml2.dtd"><math><mi>x</mi></math>',
  '<!DOCTYPE math SYSTEM "a.dtd"><math><mi>x</mi></math>',
  '<!DOCTYPE math [<!ENTITY a "b">]><math><mi>x</mi></math>',
  '<!DOCTYPE math',
  '<!DOCTYPE',
  '<!ELEMENT a><math><mi>x</mi></math>',
  '<!-- c --><math><mi>x</mi></math>',
  '<!-- c --',
  '<!-- c',
  '<!- c --><math><mi>x</mi></math>',
  '<![CDATA[x]]><math><mi>x</mi></math>',
  '<![CDATA[x',
  '<![CDATA[]]><math><mi>x</mi></math>',
  '<math><![CDATA[<mi>x</mi>]]></math>',
  '<math><mi>x</mi></math>trailing',
  'leading<math><mi>x</mi></math>',
  '<math><mi>x</mi></math>\u00a0',
  '<math><mi>\u0080x</mi></math>',
  '<math\u0080><mi>x</mi></math>',
  '<math\t><mi\n>x</mi></math>',
  '<math><mi>x</mi>\u2028<mn>1</mn></math>',
  '<math><mi>日本</mi><é>x</é></math>',
  '<math><😀>x</😀></math>',
  '<math><a:b:c>x</a:b:c></math>',
  '<math><a:>x</a:></math>',
  '<math><:a>x</:a></math>',
  '<math><mi>x</mi></math><math><mi>y</mi>',
  '<math><mi>x</mi><math><mi>y</mi></math></math>'
]

const PIECES = [
  '<math>',
  '</math>',
  '<math display="block">',
  '<mrow>',
  '</mrow>',
  '<mi>',
  '</mi>',
  '<mn>',
  '</mn>',
  '<mo>',
  '</mo>',
  '<mfrac>',
  '</mfrac>',
  '<msup>',
  '</msup>',
  '<msub>',
  '</msub>',
  '<msubsup>',
  '</msubsup>',
  '<msqrt>',
  '</msqrt>',
  '<mroot>',
  '</mroot>',
  '<mfenced open="(" close=")">',
  '<mfenced>',
  '</mfenced>',
  '<mtable>',
  '</mtable>',
  '<mtr>',
  '</mtr>',
  '<mtd>',
  '</mtd>',
  '<mtable columnalign="right left">',
  '<mover>',
  '</mover>',
  '<munder>',
  '</munder>',
  '<munderover>',
  '</munderover>',
  '<mtext>',
  '</mtext>',
  '<mspace/>',
  '<mspace linebreak="newline"/>',
  '<mphantom>',
  '</mphantom>',
  '<menclose notation="box">',
  '</menclose>',
  '<mmultiscripts>',
  '</mmultiscripts>',
  '<mprescripts/>',
  '<none/>',
  '<semantics>',
  '</semantics>',
  '<annotation encoding="x">',
  '</annotation>',
  '<mpadded>',
  '</mpadded>',
  '<mi mathvariant="bold">',
  '<mfrac linethickness="0">',
  '<mfrac bevelled="true">',
  'x',
  'y',
  '2',
  '+',
  '=',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '|',
  '||',
  '‖',
  '∑',
  '∫',
  '→',
  'α',
  'é',
  '𝐀',
  ' ',
  '\n',
  '&amp;',
  '&lt;',
  '&#65;',
  '&nbsp;',
  '&',
  '<',
  '>',
  '/',
  '"',
  "'",
  '=',
  '<!-- c -->',
  '<![CDATA[z]]>',
  '<?p?>',
  '<a b>',
  '<a b=1>',
  '<a b="1">',
  '</a>',
  '<a/>',
  'mml:',
  '<mml:mi>',
  '</mml:mi>'
]

const LEAVES = [
  () => mi('x'),
  () => mi('y', ' mathvariant="bold"'),
  () => mi('α'),
  () => mi('é'),
  () => mi('𝐀'),
  () => mn('2'),
  () => mn('3.5'),
  () => mn('½'),
  () => mo('+'),
  () => mo('='),
  () => mo('∑'),
  () => mo('→'),
  () => mo('('),
  () => mo(')'),
  () => mo('['),
  () => mo(']'),
  () => mo('{'),
  () => mo('}'),
  () => mo('|'),
  () => mo('‖'),
  () => mo('⁡'),
  () => '<mtext>a b+c</mtext>',
  () => '<mspace/>',
  () => '<mspace linebreak="newline"/>',
  () => '<none/>',
  () => '<mi>sin</mi>',
  () => '<mo>&amp;</mo>',
  () => '<mi/>',
  () => '<mrow/>'
]

/** A well-formed MathML tree whose arities mostly match what each converter requires. */
function randomTree(random, depth) {
  const pick = (list) => list[Math.floor(random() * list.length)]
  const sub = (n) => Array.from({ length: n }, () => randomTree(random, depth - 1)).join('')
  if (depth <= 0 || random() < 0.25) return pick(LEAVES)()
  const tag = pick([
    'mrow',
    'mrow',
    'mfrac',
    'msup',
    'msub',
    'msubsup',
    'msqrt',
    'mroot',
    'mfenced',
    'mtable',
    'mover',
    'munder',
    'munderover',
    'mmultiscripts',
    'menclose',
    'mphantom',
    'mstyle',
    'semantics',
    'maction',
    'mpadded',
    'merror',
    'mtr',
    'mtd'
  ])
  const arity = {
    mfrac: 2,
    msup: 2,
    msub: 2,
    msubsup: 3,
    mroot: 2,
    mover: 2,
    munder: 2,
    munderover: 3
  }
  const wrong = random() < 0.04
  const count = (arity[tag] ?? 1 + Math.floor(random() * 4)) + (wrong ? 1 : 0)
  const attrs =
    {
      mfrac: pick([
        '',
        '',
        ' linethickness="0"',
        ' linethickness="2px"',
        ' bevelled="true"',
        ' linethickness="thick"'
      ]),
      mfenced: pick([
        '',
        ' open="[" close="]"',
        ' open="{" close="}" separators=";"',
        ' open="|" close="|"',
        ' separators=""'
      ]),
      menclose: pick(['', ' notation="box"', ' notation="left"', ' notation="actuarial"']),
      mtable: pick(['', ' columnalign="right left"', ' columnalign="center"']),
      maction: pick(['', ' actiontype="toggle"', ' actiontype="tooltip"'])
    }[tag] ?? ''
  if (tag === 'mtable') {
    const rows = 1 + Math.floor(random() * 3)
    const row = () =>
      '<mtr>' +
      Array.from({ length: 1 + Math.floor(random() * 3) }, () => `<mtd>${sub(1)}</mtd>`).join('') +
      '</mtr>'
    return `<mtable${attrs}>${Array.from({ length: rows }, row).join('')}</mtable>`
  }
  return `<${tag}${attrs}>${sub(count)}</${tag}>`
}

export function mathmlFuzzVectors(count, seed = 0x3543a7) {
  const random = rng(seed)
  return Array.from({ length: count }, (_, n) => {
    if (n % 2 === 0) {
      const body = Array.from({ length: 1 + Math.floor(random() * 4) }, () =>
        randomTree(random, 4)
      ).join('')
      return mathmlVector(`<math>${body}</math>`)
    }
    const length = 2 + Math.floor(random() * 40)
    let soup = ''
    for (let i = 0; i < length; i++) soup += PIECES[Math.floor(random() * PIECES.length)]
    return mathmlVector(random() < 0.7 ? `<math>${soup}</math>` : soup)
  })
}
