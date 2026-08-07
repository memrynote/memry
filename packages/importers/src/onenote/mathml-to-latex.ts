/**
 * Convert the MathML that OneNote emits for equations into LaTeX.
 *
 * A deliberately small, dependency-free converter (built on the workspace's
 * existing `fast-xml-parser`) covering the presentation-MathML subset OneNote
 * actually produces: tokens, rows, fractions, scripts, roots, fences, accents
 * and simple tables. Unknown elements degrade to their text content, so a
 * partially understood formula still reads sensibly rather than vanishing.
 *
 * @module onenote/mathml-to-latex
 */

import { XMLParser, XMLValidator } from 'fast-xml-parser'

/** Unicode operators/symbols → LaTeX commands. */
const CHAR_MAP: Record<string, string> = {
  '×': '\\times ',
  '÷': '\\div ',
  '±': '\\pm ',
  '∓': '\\mp ',
  '·': '\\cdot ',
  '⋅': '\\cdot ',
  '≤': '\\le ',
  '≥': '\\ge ',
  '≠': '\\neq ',
  '≈': '\\approx ',
  '≡': '\\equiv ',
  '∝': '\\propto ',
  '∞': '\\infty ',
  '−': '-',
  '→': '\\to ',
  '⇒': '\\Rightarrow ',
  '⇔': '\\Leftrightarrow ',
  '∈': '\\in ',
  '∉': '\\notin ',
  '⊂': '\\subset ',
  '⊆': '\\subseteq ',
  '∪': '\\cup ',
  '∩': '\\cap ',
  '∀': '\\forall ',
  '∃': '\\exists ',
  '¬': '\\neg ',
  '∧': '\\land ',
  '∨': '\\lor ',
  '∑': '\\sum ',
  '∏': '\\prod ',
  '∫': '\\int ',
  '∂': '\\partial ',
  '∇': '\\nabla ',
  '√': '\\sqrt ',
  '°': '^{\\circ}',
  α: '\\alpha ',
  β: '\\beta ',
  γ: '\\gamma ',
  δ: '\\delta ',
  ε: '\\varepsilon ',
  ζ: '\\zeta ',
  η: '\\eta ',
  θ: '\\theta ',
  λ: '\\lambda ',
  μ: '\\mu ',
  ν: '\\nu ',
  ξ: '\\xi ',
  π: '\\pi ',
  ρ: '\\rho ',
  σ: '\\sigma ',
  τ: '\\tau ',
  φ: '\\varphi ',
  χ: '\\chi ',
  ψ: '\\psi ',
  ω: '\\omega ',
  Γ: '\\Gamma ',
  Δ: '\\Delta ',
  Θ: '\\Theta ',
  Λ: '\\Lambda ',
  Ξ: '\\Xi ',
  Π: '\\Pi ',
  Σ: '\\Sigma ',
  Φ: '\\Phi ',
  Ψ: '\\Psi ',
  Ω: '\\Omega '
}

/** Multi-letter identifiers rendered as LaTeX function names. */
const FUNCTION_NAMES = new Set([
  'sin',
  'cos',
  'tan',
  'cot',
  'sec',
  'csc',
  'sinh',
  'cosh',
  'tanh',
  'log',
  'ln',
  'exp',
  'lim',
  'min',
  'max',
  'det',
  'mod'
])

/** Accent characters used by `<mover>` / `<munder>`. */
const OVER_ACCENTS: Record<string, string> = {
  '‾': '\\overline',
  '¯': '\\overline',
  '―': '\\overline',
  '^': '\\hat',
  '~': '\\tilde',
  '˙': '\\dot',
  '→': '\\vec',
  '⃗': '\\vec'
}

function mapText(text: string): string {
  let out = ''
  for (const char of text) {
    out += CHAR_MAP[char] ?? char
  }
  return out
}

type OrderedNode = Record<string, unknown>

function nodeTag(node: OrderedNode): string | null {
  for (const key of Object.keys(node)) {
    if (key !== ':@') return key
  }
  return null
}

function nodeChildren(node: OrderedNode, tag: string): OrderedNode[] {
  const children = node[tag]
  if (!Array.isArray(children)) return []
  // Pretty-printed MathML interleaves whitespace text nodes between element
  // children; they would shift positional operands (mfrac, msup, …).
  return (children as OrderedNode[]).filter((child) => {
    const childTag = nodeTag(child)
    return !(childTag === '#text' && String(child[childTag]).trim() === '')
  })
}

function nodeAttrs(node: OrderedNode): Record<string, string> {
  const attrs = node[':@']
  if (attrs === null || typeof attrs !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(attrs as Record<string, unknown>)) {
    if (key.startsWith('@_')) out[key.slice(2)] = String(value)
  }
  return out
}

function textContent(nodes: OrderedNode[]): string {
  let out = ''
  for (const node of nodes) {
    const tag = nodeTag(node)
    if (tag === null) continue
    if (tag === '#text') out += String(node[tag])
    else out += textContent(nodeChildren(node, tag))
  }
  return out
}

/** Wrap a rendered operand in braces unless it is already a single token. */
function braced(value: string): string {
  const trimmed = value.trim()
  return `{${trimmed}}`
}

function convertList(nodes: OrderedNode[]): string {
  return nodes.map(convertNode).join('')
}

function convertNode(node: OrderedNode): string {
  const tag = nodeTag(node)
  if (tag === null) return ''
  if (tag === '#text') return mapText(String(node[tag]))

  const children = nodeChildren(node, tag)
  switch (tag) {
    case 'mi': {
      const text = textContent(children).trim()
      if (FUNCTION_NAMES.has(text)) return `\\${text} `
      return mapText(text)
    }
    case 'mn':
    case 'ms':
      return mapText(textContent(children).trim())
    case 'mo':
      return mapText(textContent(children).trim())
    case 'mtext': {
      const text = textContent(children).replace(/[%#&]/g, (m) => `\\${m}`)
      const trimmed = text.trim()
      return trimmed.length > 0 ? `\\text{${trimmed}}` : ' '
    }
    case 'mspace':
      return ' '
    case 'mfrac': {
      const [num, den] = children.map(convertNode)
      return `\\frac${braced(num ?? '')}${braced(den ?? '')}`
    }
    case 'msup': {
      const [base, sup] = children.map(convertNode)
      return `${braced(base ?? '')}^${braced(sup ?? '')}`
    }
    case 'msub': {
      const [base, sub] = children.map(convertNode)
      return `${braced(base ?? '')}_${braced(sub ?? '')}`
    }
    case 'msubsup': {
      const [base, sub, sup] = children.map(convertNode)
      return `${braced(base ?? '')}_${braced(sub ?? '')}^${braced(sup ?? '')}`
    }
    case 'munderover': {
      const [base, under, over] = children.map(convertNode)
      return `${(base ?? '').trim()}_${braced(under ?? '')}^${braced(over ?? '')}`
    }
    case 'msqrt':
      return `\\sqrt${braced(convertList(children))}`
    case 'mroot': {
      const [base, index] = children.map(convertNode)
      return `\\sqrt[${(index ?? '').trim()}]${braced(base ?? '')}`
    }
    case 'mfenced': {
      const attrs = nodeAttrs(node)
      const open = attrs.open ?? '('
      const close = attrs.close ?? ')'
      const separator = (attrs.separators ?? ',').trim().charAt(0) || ','
      const parts = children.map(convertNode)
      return `\\left${open === '{' ? '\\{' : open}${parts.join(separator)}\\right${close === '}' ? '\\}' : close}`
    }
    case 'mover': {
      const [base, over] = children
      const overText = over ? textContent([over]).trim() : ''
      const accent = OVER_ACCENTS[overText]
      const baseLatex = base ? convertNode(base) : ''
      if (accent) return `${accent}${braced(baseLatex)}`
      return `\\overset${braced(over ? convertNode(over) : '')}${braced(baseLatex)}`
    }
    case 'munder': {
      const [base, under] = children
      const underText = under ? textContent([under]).trim() : ''
      const baseLatex = base ? convertNode(base) : ''
      if (underText === '_') return `\\underline${braced(baseLatex)}`
      return `\\underset${braced(under ? convertNode(under) : '')}${braced(baseLatex)}`
    }
    case 'mtable': {
      const rows = children
        .filter((child) => nodeTag(child) === 'mtr')
        .map((row) =>
          nodeChildren(row, 'mtr')
            .filter((cell) => nodeTag(cell) === 'mtd')
            .map((cell) => convertList(nodeChildren(cell, 'mtd')).trim())
            .join(' & ')
        )
      return `\\begin{matrix}${rows.join(' \\\\ ')}\\end{matrix}`
    }
    case 'semantics':
      // Presentation MathML first; strip parallel <annotation> encodings.
      return convertList(
        children.filter((child) => {
          const childTag = nodeTag(child)
          return childTag !== 'annotation' && childTag !== 'annotation-xml'
        })
      )
    case 'annotation':
    case 'annotation-xml':
      return ''
    default:
      // math, mrow, mstyle, mpadded, merror, mphantom, unknown wrappers.
      return convertList(children)
  }
}

/**
 * Convert a MathML fragment (the `<math>` element's outer XML) to LaTeX.
 *
 * @returns The LaTeX source (no surrounding `$`), or null when the input could
 *   not be parsed or produced no output.
 */
export function mathmlToLatex(mathml: string): string | null {
  if (XMLValidator.validate(mathml) !== true) return null

  let parsed: unknown
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      removeNSPrefix: true,
      preserveOrder: true,
      parseTagValue: false,
      parseAttributeValue: false
    })
    parsed = parser.parse(mathml)
  } catch {
    return null
  }

  if (!Array.isArray(parsed)) return null
  const latex = convertList(parsed as OrderedNode[])
    .replace(/\s+/g, ' ')
    .trim()
  return latex.length > 0 ? latex : null
}
