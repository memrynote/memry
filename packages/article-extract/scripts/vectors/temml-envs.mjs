// Vectors for the temml parts that stage 4c-2 ported: environments (array.js, cd.js,
// borderTree.js), `\bordermatrix`, enclose.js (`\cancel`, `\boxed`, `\sout`, boxes), the
// untrusted `\class`/`\includegraphics` family and the `\hline` catcher. Same call and same
// vector shape as temml.mjs. The fuzz builds whole environments from a cell vocabulary, since
// the flat token soup of `temmlFuzzVectors` almost never closes a `\begin`.
import { rng } from './dom.mjs'
import { temmlVector } from './temml.mjs'

const bothModes = (inputs) =>
  inputs.flatMap((input) => [
    [input, false],
    [input, true]
  ])

const A = '\\begin{array}'
const E = '\\end{array}'
const m = (env, rows, arg = '') => `\\begin{${env}}${arg}${rows}\\end{${env}}`

export const temmlEnvCases = bothModes([
  // array and its column specs
  `${A}{cc}a&b\\\\c&d${E}`,
  `${A}{cc}a&b\\\\c${E}`,
  `${A}{c}a\\\\b\\\\c${E}`,
  `${A}{lcr}a&b&c${E}`,
  `${A}{|c|c|}a&b${E}`,
  `${A}{|c|c|}\\hline a&b\\\\\\hline c&d\\\\\\hline${E}`,
  `${A}{c:c}a&b\\\\\\hdashline c&d${E}`,
  `${A}{||c||}a${E}`,
  `${A}{c||c}a&b${E}`,
  `${A}{c|}a${E}`,
  `${A}{|c}a${E}`,
  `${A}{|}a${E}`,
  `${A}{||}a${E}`,
  `${A}{}a${E}`,
  `${A}{x}a${E}`,
  `${A}c a&b${E}`,
  `${A}{c}a&b${E}`,
  `${A}{cc}\\hline\\hline a&b\\\\\\hline\\hline${E}`,
  `${A}{cc}a&b\\\\[3pt]c&d${E}`,
  `${A}{cc}a&b\\\\[1em]c&d\\\\[2ex]e&f${E}`,
  `${A}{cc}a&b\\cr c&d${E}`,
  `${A}{cc}a&b\\\\ \\relax\\hline c&d${E}`,
  `${A}{cc}a&b\\\\${E}`,
  `${A}{cc}a&b\\\\\\\\${E}`,
  `${A}{cc}${E}`,
  `${A}{c}${E}`,
  `${A}{cc}\\hline${E}`,
  `\\begin{darray}{cc}a&b\\\\c&d\\end{darray}`,
  `${A}{cc}\\frac{1}{2}&\\sqrt{3}\\\\x^2&y_1${E}`,
  `${A}{cc}\\hphantom{a}&\\hphantom{b}\\\\c&d${E}`,
  `${A}{cc}\\hphantom{a}&\\hphantom{b}${E}`,
  `\\renewcommand{\\arraystretch}{1.5}${A}{cc}a&b\\\\c&d${E}`,
  `\\def\\arraystretch{2}${A}{c}a\\\\b${E}`,
  `\\def\\arraystretch{x}${A}{c}a\\\\b${E}`,
  `\\def\\arraystretch{}${A}{c}a\\\\b${E}`,
  `\\def\\arraystretch{0}${A}{c}a\\\\b${E}`,
  `\\def\\arraycolsep{3pt}${A}{cc}a&b${E}`,
  `\\def\\arraycolsep{2mm}${A}{cc}a&b\\\\c${E}`,
  `\\def\\arraycolsep{x}${A}{cc}a&b${E}`,
  `\\def\\arraycolsep{1em}\\begin{pmatrix}a&b\\\\c${E.replace('array', 'pmatrix')}`,
  `\\def\\arraycolsep{1em}\\begin{matrix}a&b\\\\c&d\\end{matrix}`,
  `${A}{cc}a&b${E}${A}{cc}c${E}`,
  `${A}{c}${A}{c}a\\\\b${E}\\\\c${E}`,
  `${A}{cc}a&b&c${E}`,
  `${A}{cc}a&b\\\\c&d&e${E}`,
  `${A}{c}a\\end{matrix}`,
  `${A}{c}a`,
  `${A}{c}a&`,
  `${A}{c}a\\\\`,
  '\\begin{nosuch}a\\end{nosuch}',
  '\\begin{array',
  '\\begin{}a\\end{}',
  '\\begin x',
  '\\begin{a b}x\\end{a b}',
  '\\end{array}',
  '\\hline',
  '\\hdashline',
  'x\\hline y',
  '\\text{\\hline}',
  // matrices
  m('matrix', 'a&b\\\\c&d'),
  m('pmatrix', 'a&b\\\\c&d'),
  m('bmatrix', 'a&b\\\\c&d'),
  m('Bmatrix', 'a&b\\\\c&d'),
  m('vmatrix', 'a&b\\\\c&d'),
  m('Vmatrix', 'a&b\\\\c&d'),
  m('matrix', 'a&b\\\\c'),
  m('pmatrix', 'a\\\\b\\\\c'),
  m('pmatrix', ''),
  m('pmatrix', '\\\\'),
  m('pmatrix', 'a&b\\\\'),
  m('pmatrix', '\\hline a&b\\\\\\hline c&d'),
  m('pmatrix', 'x^2&\\frac{a}{b}\\\\\\vdots&\\ddots'),
  m('pmatrix*', 'a&b\\\\c&d'),
  m('pmatrix*', 'a&b\\\\c&d', '[l]'),
  m('bmatrix*', 'a&b\\\\c&d', '[r]'),
  m('Bmatrix*', 'a&b\\\\c&d', '[ c ]'),
  m('vmatrix*', 'a&b\\\\c&d', '[x]'),
  m('vmatrix*', 'a&b\\\\c&d', '[l'),
  m('Vmatrix*', 'a&b\\\\c&d', '[l'),
  m('matrix*', 'a&b', '[lr]'),
  m('smallmatrix', 'a&b\\\\c&d'),
  m('smallmatrix', 'a&b\\\\c'),
  `\\left(${m('smallmatrix', 'a&b\\\\c&d')}\\right)`,
  m('subarray', 'a\\\\b', '{c}'),
  m('subarray', 'a\\\\b', '{l}'),
  m('subarray', 'a\\\\b', '{r}'),
  m('subarray', 'a&b', '{c}'),
  m('subarray', 'a\\\\b', '{cc}'),
  m('subarray', 'a', ''),
  '\\sum_{\\substack{i<n\\\\j<m}}x',
  '\\sum_{\\substack{i<n}}x',
  // cases
  m('cases', 'a&b\\\\c&d'),
  m('cases', 'x&\\text{if }x>0\\\\-x&\\text{otherwise}'),
  m('dcases', '\\frac{1}{2}&a\\\\b&c'),
  m('rcases', 'a&b\\\\c&d'),
  m('drcases', 'a&b\\\\c&d'),
  m('cases', ''),
  m('cases', 'a'),
  // aligned family
  m('align', 'a&=b\\\\c&=d'),
  m('align', 'a&=b\\tag{1}\\\\c&=d'),
  m('align', 'a&=b\\tag{1}\\\\c&=d\\tag{2}'),
  m('align', 'a&=b\\nonumber\\\\c&=d'),
  m('align', 'a&=b\\notag\\\\c&=d\\label{x}'),
  m('align', 'a&=b\\label{x}\\\\c&=d\\label{y}'),
  m('align', 'a&=b\\label{x}\\label{y}'),
  m('align', 'a&=b\\tag*{(*)}'),
  m('align', 'a&=b&c&=d\\\\e&=f&g&=h'),
  m('align', 'a&=b&c'),
  m('align*', 'a&=b\\\\c&=d'),
  m('align*', 'a&=b\\tag{x}\\\\c&=d'),
  m('aligned', 'a&=b\\\\c&=d'),
  m('aligned', 'a&=b&c&=d'),
  m('aligned', 'a'),
  m('aligned', 'a&=b\\tag{1}'),
  m('split', 'a&=b\\\\&=c'),
  m('split', 'a&=b&c'),
  m('alignat', 'a&=b&c&=d\\\\e&=f&g&=h', '{2}'),
  m('alignat', 'a&=b\\\\c&=d', '{2}'),
  m('alignat', 'a&=b&c&=d&e&=f', '{2}'),
  m('alignat', 'a&=b', '{x}'),
  m('alignat', 'a&=b', '{ 1 }'),
  m('alignat', 'a&=b', '{1.5}'),
  m('alignat', 'a&=b', '{}'),
  m('alignat', 'a&=b', '2'),
  m('alignat*', 'a&=b&c&=d', '{2}'),
  m('alignedat', 'a&=b&c&=d', '{2}'),
  m('alignedat', 'a&=b&c&=d&e', '{2}'),
  m('gather', 'a\\\\b'),
  m('gather', 'a\\tag{1}\\\\b'),
  m('gather*', 'a\\\\b'),
  m('gathered', 'a\\\\b'),
  m('gathered', 'a&b'),
  m('equation', 'a=b'),
  m('equation', 'a=b\\tag{1}'),
  m('equation', 'a=b\\\\c'),
  m('equation', 'a&b'),
  m('equation', ''),
  m('equation*', 'a=b'),
  m('multline', 'a\\\\b\\\\c'),
  m('multline', 'a\\\\b'),
  m('multline', 'a'),
  m('multline', 'a\\\\b\\tag{x}'),
  m('multline*', 'a\\\\b\\\\c'),
  m('multline', 'a&b'),
  // CD
  m('CD', 'A @>>> B @>f>> C\\\\@VVV @AAA @| \\\\D @= E @<<< F'),
  m('CD', 'A @>a>b> B\\\\@VcVdV @. \\\\C @<x<y< D'),
  m('CD', 'A @>>> B'),
  m('CD', 'A @> B'),
  m('CD', 'A @>>'),
  m('CD', 'A @'),
  m('CD', 'A @x B'),
  m('CD', ''),
  m('CD', 'A @VVV B\\\\ C'),
  m('CD', 'A @>>> @>>> B'),
  m('CD', 'A @>@>>>>>'),
  m('CD', '@>>> @<<<'),
  m('CD', 'A @== B @|| C'),
  m('CD', 'A @>>>B'),
  m('CD', 'A @> a @ > > B'),
  // bordermatrix
  '\\bordermatrix{&a&b\\\\c&1&2\\\\d&3&4}',
  '\\bordermatrix{&a&b\\\\c&1&2}',
  '\\bordermatrix{&a\\\\c&1}',
  '\\bordermatrix{a&b}',
  '\\bordermatrix{a}',
  '\\bordermatrix{}',
  '\\bordermatrix[\\{\\}]{&a&b\\\\c&1&2\\\\d&3&4}',
  '\\bordermatrix[[]]{&a&b\\\\c&1&2\\\\d&3&4}',
  '\\bordermatrix[{}]{&a&b\\\\c&1&2}',
  '\\bordermatrix{&a&b\\\\c&1&2\\\\d&3}',
  '\\bordermatrix{&a&b\\\\c&1&2',
  '\\bordermatrix x',
  '\\matrix{a&b\\\\c&d}',
  '\\matrix{a}',
  '\\matrix[x]{a}',
  '\\matrix',
  // enclose
  '\\cancel{x}',
  '\\cancel{xy}',
  '\\cancel{x+y}',
  '\\bcancel{x}',
  '\\xcancel{x}',
  '\\sout{x}',
  '\\sout{xy}',
  '\\overline{x}',
  '\\overline{xy}',
  '\\underline{x}',
  '\\underline{xy}',
  '\\boxed{x}',
  '\\boxed{x=y}',
  '\\fbox{x}',
  '\\fbox{xy}',
  '\\fbox x',
  '\\colorbox{red}{x}',
  '\\colorbox{#ff0000}{x}',
  '\\colorbox{ff0000}{x}',
  '\\colorbox[HTML]{FF0000}{x}',
  '\\colorbox[rgb]{1,0,0}{x}',
  '\\colorbox[x]{1,0,0}{x}',
  '\\colorbox{not a color!}{x}',
  '\\colorbox{red}',
  '\\fcolorbox{red}{blue}{x}',
  '\\fcolorbox{#00f}{#f00}{x}',
  '\\fcolorbox[HTML]{FF0000}{00FF00}{x}',
  '\\fcolorbox[rgb]{1,0,0}{x}',
  '\\fcolorbox{red}{x}',
  '\\longdiv{x}',
  '\\phase{x}',
  '\\angl{x}',
  '\\angln',
  '\\textcircled{a}',
  '\\textcircled{ab}',
  '\\text{\\textcircled{a}}',
  '\\text{\\sout{a}}',
  '\\text{\\underline{a}}',
  '\\text{\\fbox{a}}',
  '\\text{\\colorbox{red}{a}}',
  '\\text{\\cancel{a}}',
  '\\text{\\overline{a}}',
  '\\cancel{\\frac{a}{b}}',
  '\\cancel{\\cancel{x}}',
  '\\cancel',
  '\\cancel{',
  'a+\\cancel{b}+c',
  'x^{\\cancel{2}}',
  '\\left(\\cancel{x}\\right)',
  '\\cancel x',
  '\\overline{\\overline{x}}',
  '\\color{red}\\cancel{x}',
  '\\textcolor{red}{\\boxed{x}}',
  '\\mathbf{\\boxed{x}}',
  '\\boxed{\\begin{array}{c}a\\\\b\\end{array}}',
  `\\cancel{${m('pmatrix', 'a&b\\\\c&d')}}`,
  // untrusted functions
  '\\class{foo}{x}',
  '\\id{foo}{x}',
  '\\style{color:red}{x}',
  '\\data{a=b}{x}',
  '\\data{ab}{x}',
  '\\includegraphics{a.png}',
  '\\includegraphics[width=1em]{a.png}',
  '\\includegraphics[height=2px]{a.png}',
  '\\includegraphics[x=1]{a.png}',
  '\\text{\\class{a}{b}}',
  '\\newcommand{\\class}{x}',
  '\\newcommand{\\cancel}{x}\\cancel',
  '\\renewcommand{\\cancel}[1]{#1}\\cancel{x}',
  '\\providecommand{\\boxed}{x}\\boxed',
  '\\let\\foo\\cancel\\foo{x}',
  '\\def\\x{\\begin{pmatrix}}\\x a\\end{pmatrix}',
  '\\newcommand{\\mat}[1]{\\begin{pmatrix}#1\\end{pmatrix}}\\mat{a&b}',
  '\\newcommand{\\mat}[1]{\\begin{pmatrix}#1\\end{pmatrix}}\\mat{a&b\\\\c&d}',
  '\\hat{\\begin{pmatrix}a\\end{pmatrix}}',
  'x_{\\begin{pmatrix}a\\end{pmatrix}}',
  '\\frac{\\begin{pmatrix}a\\end{pmatrix}}{2}',
  '\\sqrt{\\begin{array}{c}a\\\\b\\end{array}}',
  '\\text{\\begin{array}{c}a\\end{array}}',
  '\\mathbf{\\begin{pmatrix}a&b\\end{pmatrix}}',
  '\\color{red}\\begin{pmatrix}a&b\\end{pmatrix}',
  '\\left[\\begin{array}{cc}a&b\\end{array}\\right]',
  '\\begin{pmatrix}\\begin{pmatrix}a\\end{pmatrix}&b\\end{pmatrix}',
  '\\begin{pmatrix}a&\\begin{array}{c}b\\\\c\\end{array}\\end{pmatrix}',
  '\\begin{pmatrix}a\\\\\\displaystyle\\sum_i b\\end{pmatrix}',
  '\\begin{pmatrix}\\color{red}a&b\\end{pmatrix}',
  '\\begin{pmatrix}a&b\\end{pmatrix}^2',
  '\\begin{pmatrix}a&b\\end{pmatrix}_1^2',
  '\\mathop{\\begin{pmatrix}a\\end{pmatrix}}\\limits_1',
  'x=\\begin{cases}1&a\\\\2&b\\end{cases}+y',
  '\\begin{pmatrix}a&b\\end{pmatrix}\\begin{pmatrix}c&d\\\\e\\end{pmatrix}',
  '\\begin{array}{cc}a&b\\end{array}\\begin{array}{cc}c\\\\d&e\\end{array}',
  '\\begin{matrix}a\\\\b&c\\end{matrix}\\begin{matrix}d\\\\e&f\\end{matrix}',
  '\\begin{pmatrix}a\\\\b&c\\end{pmatrix}',
  '\\begin{pmatrix}a&b&c\\\\d\\\\e&f\\end{pmatrix}',
  '\\begin{pmatrix}\\begin{matrix}a&b\\\\c\\end{matrix}&d\\\\e\\end{pmatrix}',
  '\\begin{array}{cc}\\begin{array}{ccc}a&b\\\\c\\end{array}&\\begin{array}{cc}x\\end{array}\\\\e\\end{array}',
  '\\begin{matrix}a\\\\b&c\\end{matrix}^{\\begin{matrix}a\\\\b&c\\end{matrix}}'
])

const SPEC_ARRAY = [
  '{c}',
  '{cc}',
  '{lcr}',
  '{|c|}',
  '{c|c}',
  '{l:r}',
  '{||c}',
  '{c||}',
  '{}',
  '{x}',
  '{|}',
  '{c|c|c}',
  '{r@{}l}'
]
const CELLS = [
  'a',
  'b',
  'x^2',
  '\\frac{1}{2}',
  '\\alpha',
  '',
  '',
  '',
  '\\hline',
  '\\hdashline',
  '\\tag{1}',
  '\\tag*{x}',
  '\\label{a}',
  '\\nonumber',
  '\\notag',
  '\\text{hi}',
  '\\hphantom{x}',
  '\\cancel{x}',
  '\\boxed{y}',
  '=',
  '+',
  '\\displaystyle\\sum_i',
  '\\left(x\\right)',
  '1',
  '22',
  '\\vdots',
  '\\relax'
]
const CD_CELLS = [
  'A',
  'B',
  '@>>>',
  '@<<<',
  '@AAA',
  '@VVV',
  '@=',
  '@|',
  '@.',
  '@>a>b>',
  '@VfVgV',
  '@<x<y<',
  '@',
  '@>',
  ''
]

const pick = (random, list) => list[Math.floor(random() * list.length)]

const CLEAN_CELLS = [
  'a',
  'b',
  'x^2',
  '\\frac{1}{2}',
  '\\alpha',
  '',
  '1',
  '22',
  '\\hphantom{x}',
  '=',
  '+',
  '\\left(x\\right)'
]
const EXTRAS = [
  '\\hline',
  '\\hdashline',
  '\\tag{1}',
  '\\tag*{x}',
  '\\label{a}',
  '\\nonumber',
  '\\notag'
]

// A dirty body takes any cell any number of times and may break the grid; a clean one is a
// rectangular grid of plain cells with an occasional row decoration, which is what reaches the
// builder.
function body(random, cells, fixedCols) {
  const clean = fixedCols !== null && random() < 0.7
  const rows = 1 + Math.floor(random() * 4)
  let out = ''
  for (let i = 0; i < rows; i++) {
    const cols = clean ? fixedCols : 1 + Math.floor(random() * 4)
    const row = []
    for (let j = 0; j < cols; j++) row.push(pick(random, clean ? CLEAN_CELLS : cells))
    if (clean && random() < 0.15) row[row.length - 1] += pick(random, EXTRAS)
    out += row.join(!clean && random() < 0.05 ? '&&' : '&')
    if (i < rows - 1 || random() < 0.2)
      out += random() < 0.15 ? '\\cr ' : random() < 0.2 ? '\\\\[2pt]' : '\\\\'
  }
  return out
}

export function temmlEnvFuzzVectors(count, seed = 0x3543c5) {
  const random = rng(seed)
  const envs = [
    'array',
    'darray',
    'matrix',
    'pmatrix',
    'bmatrix',
    'Bmatrix',
    'vmatrix',
    'Vmatrix',
    'matrix*',
    'pmatrix*',
    'smallmatrix',
    'subarray',
    'cases',
    'dcases',
    'rcases',
    'drcases',
    'align',
    'align*',
    'aligned',
    'split',
    'alignat',
    'alignat*',
    'alignedat',
    'gathered',
    'gather',
    'gather*',
    'equation',
    'equation*',
    'multline',
    'multline*',
    'CD'
  ]
  return Array.from({ length: count }, () => {
    const kind = random()
    let latex
    if (kind < 0.1) {
      const width = 2 + Math.floor(random() * 2)
      const rows = 2 + Math.floor(random() * 2)
      const grid = Array.from({ length: rows }, (_row, i) =>
        Array.from({ length: width }, (_cell, j) =>
          random() < 0.15
            ? ''
            : i === 0 && j === 0
              ? ''
              : pick(random, ['a', 'b', '1', 'x^2', '\\hphantom{x}'])
        ).join('&')
      )
      const inner = random() < 0.8 ? grid.join('\\\\') : body(random, ['', 'a', 'b', '1'], null)
      latex = `\\bordermatrix${random() < 0.3 ? '[\\{\\}]' : ''}{${inner}}`
    } else if (kind < 0.2) {
      const names = [
        '\\cancel',
        '\\bcancel',
        '\\xcancel',
        '\\sout',
        '\\overline',
        '\\underline',
        '\\boxed',
        '\\fbox',
        '\\angl',
        '\\longdiv',
        '\\phase',
        '\\textcircled',
        '\\colorbox{red}',
        '\\fcolorbox{red}{blue}'
      ]
      latex =
        pick(random, names) +
        pick(random, ['{x}', '{xy}', '{\\frac{a}{b}}', '{', ' x', '{\\alpha}', '{x^2}'])
    } else {
      const env = pick(random, envs)
      let arg = ''
      if (env === 'array' || env === 'darray') arg = pick(random, SPEC_ARRAY)
      else if (env.startsWith('alignat') || env === 'alignedat')
        arg = pick(random, ['{2}', '{1}', '{3}', '{x}', '{}'])
      else if (env === 'subarray') arg = pick(random, ['{c}', '{l}', '{cc}', '{r}'])
      else if (env.endsWith('*') && env.includes('matrix') && random() < 0.5)
        arg = pick(random, ['[l]', '[c]', '[r]', '[x]'])
      let fixedCols = 1 + Math.floor(random() * 3)
      if (env === 'array' || env === 'darray') fixedCols = arg.replace(/[^lcr]/g, '').length || 1
      else if (
        env === 'equation' ||
        env === 'equation*' ||
        env === 'multline' ||
        env === 'multline*' ||
        env === 'subarray'
      )
        fixedCols = 1
      else if (env.startsWith('alignat') || env === 'alignedat')
        fixedCols = 2 * (Number(arg.slice(1, -1)) || 1)
      else if (env === 'CD') fixedCols = null
      const inner = body(random, env === 'CD' ? CD_CELLS : CELLS, fixedCols)
      const end = random() < 0.04 ? pick(random, envs) : env
      latex = `\\begin{${env}}${arg}${inner}\\end{${end}}`
      const prefix = random()
      if (prefix < 0.08)
        latex = `\\renewcommand{\\arraystretch}{${pick(random, ['1.5', '2', '1', 'x', '0.5'])}}${latex}`
      else if (prefix < 0.14)
        latex = `\\def\\arraycolsep{${pick(random, ['3pt', '2mm', '1em', 'x', '0pt'])}}${latex}`
      else if (prefix < 0.2) latex = `a+${latex}+b`
      else if (prefix < 0.24) latex = `\\left(${latex}\\right)`
    }
    return temmlVector([latex, random() < 0.85])
  })
}
