import { describe, it, expect } from 'vitest'
import {
  BLOCK_COLORS_LINE_REGEX,
  TABLE_CELL_COLORS_LINE_REGEX,
  hasNonDefaultColors,
  serializeBlockColorsMarker,
  parseBlockColorsMarker,
  extractTableCellColors,
  serializeTableCellColorsMarker,
  parseTableCellColorsMarker,
  applyTableCellColors
} from './block-colors'

describe('hasNonDefaultColors', () => {
  it('returns false for missing or default colors', () => {
    expect(hasNonDefaultColors({})).toBe(false)
    expect(hasNonDefaultColors({ textColor: 'default', backgroundColor: 'default' })).toBe(false)
  })

  it('returns true when either color is non-default', () => {
    expect(hasNonDefaultColors({ textColor: 'red' })).toBe(true)
    expect(hasNonDefaultColors({ backgroundColor: 'blue', textColor: 'default' })).toBe(true)
  })
})

describe('serializeBlockColorsMarker', () => {
  it('emits only non-default keys', () => {
    expect(serializeBlockColorsMarker({ textColor: 'red', backgroundColor: 'default' })).toBe(
      '<!-- colors:{"textColor":"red"} -->'
    )
    expect(serializeBlockColorsMarker({ textColor: 'red', backgroundColor: 'blue' })).toBe(
      '<!-- colors:{"textColor":"red","backgroundColor":"blue"} -->'
    )
  })
})

describe('parseBlockColorsMarker', () => {
  it('parses a serialized marker back to colors', () => {
    const marker = serializeBlockColorsMarker({ textColor: 'red', backgroundColor: 'blue' })
    expect(parseBlockColorsMarker(marker)).toEqual({ textColor: 'red', backgroundColor: 'blue' })
  })

  it('returns null for non-marker lines and malformed JSON', () => {
    expect(parseBlockColorsMarker('plain text')).toBeNull()
    expect(parseBlockColorsMarker('<!-- file:{"url":"x"} -->')).toBeNull()
    expect(parseBlockColorsMarker('<!-- colors:{broken} -->')).toBeNull()
  })
})

describe('BLOCK_COLORS_LINE_REGEX', () => {
  it('matches a full marker line only', () => {
    expect(BLOCK_COLORS_LINE_REGEX.test('<!-- colors:{"textColor":"red"} -->')).toBe(true)
    expect(BLOCK_COLORS_LINE_REGEX.test('text <!-- colors:{"textColor":"red"} -->')).toBe(false)
  })
})

/** A table's content in the shape BlockNote parses markdown into. */
const tableContent = (colors: Array<Array<Record<string, string>>>) => ({
  type: 'tableContent',
  columnWidths: [null, null],
  headerRows: 1,
  rows: colors.map((row) => ({
    cells: row.map((cellColors) => ({
      type: 'tableCell',
      content: [],
      props: { colspan: 1, rowspan: 1, textAlignment: 'left', ...cellColors }
    }))
  }))
})

describe('extractTableCellColors', () => {
  it('returns null when nothing in the table is colored', () => {
    const content = tableContent([
      [{ textColor: 'default', backgroundColor: 'default' }, {}],
      [{}, {}]
    ])

    expect(extractTableCellColors(content)).toBeNull()
  })

  it('returns null for a block that is not a table', () => {
    expect(extractTableCellColors([{ type: 'text', text: 'x', styles: {} }])).toBeNull()
    expect(extractTableCellColors(undefined)).toBeNull()
  })

  it('keys the colored cells by row and cell index, non-default keys only', () => {
    const content = tableContent([
      [{}, {}],
      [{ backgroundColor: 'red', textColor: 'default' }, { textColor: 'blue' }]
    ])

    expect(extractTableCellColors(content)).toEqual({
      '1:0': { backgroundColor: 'red' },
      '1:1': { textColor: 'blue' }
    })
  })

  it('ignores a cell handed back as a bare inline-content array', () => {
    const content = { type: 'tableContent', rows: [{ cells: [[{ type: 'text', text: 'x' }]] }] }

    expect(extractTableCellColors(content)).toBeNull()
  })
})

describe('serializeTableCellColorsMarker / parseTableCellColorsMarker', () => {
  it('round-trips a cell color map', () => {
    const colors = { '1:0': { textColor: 'blue', backgroundColor: 'red' } }
    const marker = serializeTableCellColorsMarker(colors)

    expect(marker).toBe(
      '<!-- table-colors:{"1:0":{"textColor":"blue","backgroundColor":"red"}} -->'
    )
    expect(parseTableCellColorsMarker(marker)).toEqual(colors)
  })

  it('returns null for non-marker lines, malformed JSON and non-object payloads', () => {
    expect(parseTableCellColorsMarker('| a | b |')).toBeNull()
    expect(parseTableCellColorsMarker('<!-- colors:{"textColor":"red"} -->')).toBeNull()
    expect(parseTableCellColorsMarker('<!-- table-colors:{broken} -->')).toBeNull()
  })
})

describe('applyTableCellColors', () => {
  it('puts the colors back on the cells the keys name', () => {
    const content = tableContent([
      [{}, {}],
      [{}, {}]
    ])

    applyTableCellColors(content, { '1:1': { backgroundColor: 'red' } })

    expect(content.rows[1].cells[1].props).toMatchObject({
      backgroundColor: 'red',
      // the props the cell already carried are kept
      colspan: 1,
      textAlignment: 'left'
    })
    expect(content.rows[0].cells[0].props).not.toHaveProperty('backgroundColor')
  })

  it('skips keys naming a cell the table no longer has', () => {
    const content = tableContent([[{}, {}]])

    expect(() =>
      applyTableCellColors(content, {
        '9:9': { backgroundColor: 'red' },
        nonsense: { textColor: 'blue' }
      })
    ).not.toThrow()
    expect(extractTableCellColors(content)).toBeNull()
  })
})

describe('TABLE_CELL_COLORS_LINE_REGEX', () => {
  it('matches a full marker line only', () => {
    expect(TABLE_CELL_COLORS_LINE_REGEX.test('<!-- table-colors:{"0:0":{}} -->')).toBe(true)
    expect(TABLE_CELL_COLORS_LINE_REGEX.test('x <!-- table-colors:{"0:0":{}} -->')).toBe(false)
  })
})
