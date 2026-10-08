import { describe, expect, it } from 'vitest'
import {
  columnRegionIdFor,
  columnSettingsFor,
  columnWidthsFromSettings,
  serializeColumnRegion,
  splitMarkdownByColumnRegions
} from './columns'

const settings = (...lines: string[]): string => ['```column-settings', ...lines, '```'].join('\n')

describe('splitMarkdownByColumnRegions', () => {
  it('reads the plugin README example, settings and all', () => {
    const markdown = [
      'Text displayed above.',
      '',
      '--- start-multi-column: ExampleRegion1',
      '```column-settings',
      'number of columns: 2',
      'largest column: left',
      '```',
      '',
      'Text displayed in column 1.',
      '',
      '--- end-column ---',
      '',
      'Text displayed in column 2.',
      '',
      '--- end-multi-column',
      '',
      'Text displayed below.'
    ].join('\n')

    expect(splitMarkdownByColumnRegions(markdown)).toEqual([
      { kind: 'markdown', text: 'Text displayed above.' },
      {
        kind: 'columns',
        regionId: 'ExampleRegion1',
        settings: settings('number of columns: 2', 'largest column: left'),
        columns: ['Text displayed in column 1.', 'Text displayed in column 2.']
      },
      { kind: 'markdown', text: 'Text displayed below.' }
    ])
  })

  it.each([
    ['--- multi-column-start: r', '--- column-break ---', '--- multi-column-end'],
    ['=== start-multi-column: r', '=== break-column ===', '=== end-multi-column'],
    ['--- start-multi-column: r', '--- column-end ---', '--- end-multi-column']
  ])('accepts the %s spelling', (start, columnBreak, end) => {
    const [segment] = splitMarkdownByColumnRegions([start, 'A', columnBreak, 'B', end].join('\n'))
    expect(segment).toMatchObject({ kind: 'columns', regionId: 'r', columns: ['A', 'B'] })
  })

  it('keeps blank lines, fences and markers inside a fence within a column', () => {
    const body = ['One', '', 'Two', '', '```', '--- end-column ---', '```'].join('\n')
    const [segment] = splitMarkdownByColumnRegions(
      ['--- start-multi-column: r', body, '--- end-column ---', 'B', '--- end-multi-column'].join(
        '\n'
      )
    )
    expect(segment).toMatchObject({ columns: [body, 'B'] })
  })

  it('reads a Pandoc fenced-div region', () => {
    const markdown = [
      '::::: {.columns id=p1 columngap=3em}',
      'Left',
      '',
      '::: columnbreak',
      ':::',
      '',
      '::: note',
      'Right',
      ':::',
      ':::::'
    ].join('\n')
    expect(splitMarkdownByColumnRegions(markdown)).toEqual([
      {
        kind: 'columns',
        regionId: 'p1',
        settings: settings('Column Spacing: 3em'),
        columns: ['Left', '::: note\nRight\n:::']
      }
    ])
  })

  it.each([
    ['unterminated', '--- start-multi-column: r\nA\n--- end-column ---\nB'],
    ['single column', '--- start-multi-column: r\nOnly\n--- end-multi-column'],
    [
      'inside a code fence',
      '```\n--- start-multi-column: r\nA\n--- end-column ---\nB\n--- end-multi-column\n```'
    ],
    ['not a columns div', '::: warning\nA\n:::']
  ])('declines a region that is %s', (_name, markdown) => {
    expect(splitMarkdownByColumnRegions(markdown)).toEqual([{ kind: 'markdown', text: markdown }])
  })

  it('carries the blank lines beyond one separator at a region edge as gaps', () => {
    const region = '--- start-multi-column: r\nA\n--- end-column ---\nB\n--- end-multi-column'
    expect(
      splitMarkdownByColumnRegions(`Above\n\n\n\n${region}\n\n\nBelow`).map((s) => s.kind)
    ).toEqual(['markdown', 'gap', 'columns', 'gap', 'markdown'])
  })
})

describe('column widths', () => {
  it('reads a percentage list as widths with mean 1', () => {
    expect(columnWidthsFromSettings(settings('Column Size: [25%, 75%]'), 2)).toEqual([0.5, 1.5])
  })

  it('falls back to equal widths for a list that does not match the column count', () => {
    expect(columnWidthsFromSettings(settings('Column Size: [25%, 75%]'), 3)).toEqual([1, 1, 1])
  })

  it('writes the stored settings back verbatim while they still describe the columns', () => {
    const stored = settings('number of columns: 2', 'largest column: left', 'Border: off')
    expect(columnSettingsFor(stored, columnWidthsFromSettings(stored, 2))).toBe(stored)
  })

  it('rewrites only count and size after a resize, keeping every other line', () => {
    const stored = settings('number of columns: 2', 'Border: off', 'Alignment: [Left, Center]')
    expect(columnSettingsFor(stored, [0.5, 1.5])).toBe(
      settings(
        'Number of Columns: 2',
        'Column Size: [25%, 75%]',
        'Border: off',
        'Alignment: [Left, Center]'
      )
    )
  })

  it('is stable across a write and a read of rounded percentages', () => {
    const written = columnSettingsFor('', [1, 2])
    expect(written).toBe(settings('Number of Columns: 2', 'Column Size: [33.3%, 66.7%]'))
    expect(columnSettingsFor(written, columnWidthsFromSettings(written, 2))).toBe(written)
  })
})

describe('serializeColumnRegion', () => {
  it('writes MCM syntax that splits back into the same region', () => {
    const stored = settings('Number of Columns: 3')
    const markdown = serializeColumnRegion('r1', stored, ['A\n\nA2', '', 'C'])
    expect(markdown).toBe(
      [
        '--- start-multi-column: r1',
        stored,
        '',
        'A',
        '',
        'A2',
        '',
        '--- end-column ---',
        '',
        '--- end-column ---',
        '',
        'C',
        '',
        '--- end-multi-column'
      ].join('\n')
    )
    expect(splitMarkdownByColumnRegions(markdown)).toEqual([
      { kind: 'columns', regionId: 'r1', settings: stored, columns: ['A\n\nA2', '', 'C'] }
    ])
  })

  it('derives an id from the block id only when the file gave none', () => {
    expect(columnRegionIdFor('kept', 'abc')).toBe('kept')
    expect(columnRegionIdFor('', '1f2e-3d4c-5b6a')).toBe('1f2e3d')
  })
})
