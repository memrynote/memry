import { describe, it, expect } from 'vitest'
import { inkmlToSvg } from './inkml-to-svg.ts'

const INK = `<?xml version="1.0" encoding="UTF-8"?>
<inkml:ink xmlns:inkml="http://www.w3.org/2003/InkML">
  <inkml:definitions>
    <inkml:brush xml:id="br1">
      <inkml:brushProperty name="color" value="#FF0000"/>
      <inkml:brushProperty name="width" value="100"/>
      <inkml:brushProperty name="height" value="100"/>
      <inkml:brushProperty name="transparency" value="0.5"/>
    </inkml:brush>
  </inkml:definitions>
  <inkml:trace brushRef="#br1">100 200, 300 400, 500 600</inkml:trace>
</inkml:ink>`

describe('inkmlToSvg', () => {
  it('renders traces as SVG paths with brush color, width and opacity', () => {
    const svg = inkmlToSvg(INK)
    expect(svg).not.toBeNull()
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"')
    expect(svg).toContain('stroke="#FF0000"')
    expect(svg).toContain('stroke-width="100"')
    expect(svg).toContain('opacity="0.50"')
    // First point offset by padding (10): 100-100+10, 200-200+10.
    expect(svg).toContain('M 10 10')
    expect(svg).toContain('L 210 210')
  })

  it('renders a single-point trace as a dot', () => {
    const svg = inkmlToSvg('<ink xmlns="http://www.w3.org/2003/InkML"><trace>5 5</trace></ink>')
    expect(svg).toContain('<circle')
  })

  it('falls back to the default brush for unknown brush refs', () => {
    const svg = inkmlToSvg('<ink><trace brushRef="#missing">0 0, 10 10</trace></ink>')
    expect(svg).toContain('stroke="#000000"')
  })

  it('scales fractional coordinates for precision', () => {
    const svg = inkmlToSvg('<ink><trace>0.5 0.5, 1 1</trace></ink>')
    // 0.5 → 5000; bbox min is 1 (integer point) … so both points offset from min.
    expect(svg).toContain('<path')
  })

  it('ignores trailing MIME boundary junk after the closing tag', () => {
    const svg = inkmlToSvg(`${INK}\n--MultipartBoundary--`)
    expect(svg).toContain('<path')
  })

  it('returns null for empty, traceless or malformed input', () => {
    expect(inkmlToSvg('')).toBeNull()
    expect(inkmlToSvg('   ')).toBeNull()
    expect(inkmlToSvg('<ink></ink>')).toBeNull()
    expect(inkmlToSvg('<ink><trace></trace></ink>')).toBeNull()
    expect(inkmlToSvg('not xml <<<')).toBeNull()
  })
})

describe('inkmlToSvg robustness', () => {
  it('normalizes byte-scale transparency so highlighter strokes stay visible', () => {
    const svg = inkmlToSvg(
      '<ink xmlns="http://www.w3.org/2003/InkML"><definitions><brush xml:id="b">' +
        '<brushProperty name="transparency" value="160"/></brush></definitions>' +
        '<trace brushRef="#b">0 0, 10 10</trace></ink>'
    )
    expect(svg).toContain('opacity="0.37"')
    expect(svg).not.toContain('opacity="-')
  })

  it('escapes a brush colour that would break out of the attribute', () => {
    const svg = inkmlToSvg(
      '<ink><definitions><brush xml:id="b">' +
        '<brushProperty name="color" value="#000&quot; onload=&quot;alert(1)"/></brush></definitions>' +
        '<trace brushRef="#b">0 0, 5 5</trace></ink>'
    )
    expect(svg).not.toContain('onload="')
    expect(svg).not.toMatch(/stroke="[^"]*"[^/>]*onload/)
  })

  it('drops unparseable coordinates instead of emitting NaN geometry', () => {
    const svg = inkmlToSvg("<ink><trace>0 0, 'x y, 10 10</trace></ink>")
    expect(svg).not.toContain('NaN')
  })

  it('falls back to a sane width when the brush declares a non-numeric one', () => {
    const svg = inkmlToSvg(
      '<ink><definitions><brush xml:id="b"><brushProperty name="width" value="thick"/></brush>' +
        '</definitions><trace brushRef="#b">0 0, 5 5</trace></ink>'
    )
    expect(svg).toContain('stroke-width="70"')
  })
})
