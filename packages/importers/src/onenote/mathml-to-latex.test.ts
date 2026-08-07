import { describe, it, expect } from 'vitest'
import { mathmlToLatex } from './mathml-to-latex.ts'

describe('mathmlToLatex', () => {
  it('converts fractions', () => {
    expect(mathmlToLatex('<math><mfrac><mn>1</mn><mn>2</mn></mfrac></math>')).toBe('\\frac{1}{2}')
  })

  it('converts superscripts and subscripts', () => {
    expect(mathmlToLatex('<math><msup><mi>x</mi><mn>2</mn></msup></math>')).toBe('{x}^{2}')
    expect(mathmlToLatex('<math><msub><mi>a</mi><mi>i</mi></msub></math>')).toBe('{a}_{i}')
    expect(mathmlToLatex('<math><msubsup><mi>x</mi><mn>0</mn><mn>2</mn></msubsup></math>')).toBe(
      '{x}_{0}^{2}'
    )
  })

  it('converts roots', () => {
    expect(mathmlToLatex('<math><msqrt><mi>x</mi></msqrt></math>')).toBe('\\sqrt{x}')
    expect(mathmlToLatex('<math><mroot><mi>x</mi><mn>3</mn></mroot></math>')).toBe('\\sqrt[3]{x}')
  })

  it('maps unicode operators and greek letters', () => {
    expect(mathmlToLatex('<math><mi>α</mi><mo>×</mo><mi>β</mi><mo>≤</mo><mi>π</mi></math>')).toBe(
      '\\alpha \\times \\beta \\le \\pi'
    )
  })

  it('renders known function names with a backslash', () => {
    expect(mathmlToLatex('<math><mi>sin</mi><mi>x</mi></math>')).toBe('\\sin x')
  })

  it('handles the namespaced quadratic formula OneNote emits', () => {
    const mathml = `<math xmlns="http://www.w3.org/1998/Math/MathML" display="block">
      <mi>x</mi><mo>=</mo>
      <mfrac>
        <mrow><mo>−</mo><mi>b</mi><mo>±</mo><msqrt><mrow><msup><mi>b</mi><mn>2</mn></msup><mo>−</mo><mn>4</mn><mi>a</mi><mi>c</mi></mrow></msqrt></mrow>
        <mrow><mn>2</mn><mi>a</mi></mrow>
      </mfrac>
    </math>`
    expect(mathmlToLatex(mathml)).toBe('x=\\frac{-b\\pm \\sqrt{{b}^{2}-4ac}}{2a}')
  })

  it('converts fences, tables and text', () => {
    expect(
      mathmlToLatex('<math><mfenced open="[" close="]"><mi>a</mi><mi>b</mi></mfenced></math>')
    ).toBe('\\left[a,b\\right]')
    expect(
      mathmlToLatex(
        '<math><mtable><mtr><mtd><mn>1</mn></mtd><mtd><mn>2</mn></mtd></mtr><mtr><mtd><mn>3</mn></mtd><mtd><mn>4</mn></mtd></mtr></mtable></math>'
      )
    ).toBe('\\begin{matrix}1 & 2 \\\\ 3 & 4\\end{matrix}')
    expect(mathmlToLatex('<math><mtext>speed %</mtext></math>')).toBe('\\text{speed \\%}')
  })

  it('converts accents', () => {
    expect(mathmlToLatex('<math><mover><mi>v</mi><mo>→</mo></mover></math>')).toBe('\\vec{v}')
  })

  it('skips semantics annotations', () => {
    const mathml =
      '<math><semantics><mrow><mi>x</mi></mrow><annotation encoding="TeX">ignored</annotation></semantics></math>'
    expect(mathmlToLatex(mathml)).toBe('x')
  })

  it('degrades unknown elements to their text content', () => {
    expect(mathmlToLatex('<math><mweird><mi>y</mi></mweird></math>')).toBe('y')
  })

  it('returns null for unparseable or empty input', () => {
    expect(mathmlToLatex('<math><mi>x</math>')).toBeNull()
    expect(mathmlToLatex('<math></math>')).toBeNull()
  })
})
