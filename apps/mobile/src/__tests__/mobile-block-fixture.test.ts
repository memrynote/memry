import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  BOOKMARK_LINE_REGEX,
  EMBED_LINE_REGEX,
  FILE_BLOCK_LINE_REGEX,
  TOGGLE_CLOSE_LINE,
  TOGGLE_OPEN_LINE,
  TOGGLE_OPEN_LINE_EXPANDED,
  parseFileBlockMarker,
  readCalloutRun
} from '@memry/editor-schema/blocks'
import { MENTION_TOKEN_REGEX, parseLinkMentionToken } from '@memry/editor-schema/inline'
import { parseTableCellColorsMarker } from '@memry/shared/block-colors'
import { parseTableLayoutMarker } from '@memry/shared/block-markers'
import { DATE_MENTION_TOKEN_REGEX, parseDateMentionToken } from '@memry/shared/date-mention'
import { scanTaskCheckboxStates } from '@memry/shared/task-block'

/**
 * The fixture claims to cover all eleven custom types. This is what keeps that
 * claim true: it reads the bytes back through the same parsers the vault uses,
 * so a marker edited into a shape nothing recognises fails here rather than
 * quietly turning the fixture into eleven paragraphs of plain text.
 *
 * Named one assertion per type, so a failure says which type went missing.
 */

const markdown = readFileSync(
  fileURLToPath(new URL('../../fixtures/block-coverage.md', import.meta.url)),
  'utf8'
)
const lines = markdown.split('\n')

/** Table rows and header, i.e. every line that can hold a cell. */
const cellLines = lines.filter((line) => line.startsWith('| '))

/**
 * `hashTag` has no exported regex to lean on: its on-disk form is decided by
 * `hashTagSerialization.toExternalHTML`, which builds a DOM node and so cannot
 * run here. `#${tag}` is what it writes.
 */
const HASH_TAG_IN_TEXT = /(?:^|\s)#[A-Za-z0-9_-]+(?=\s|$)/

describe('mobile block coverage fixture', () => {
  it('carries callouts of two types that readCalloutRun parses back', () => {
    const types = lines.flatMap((_, index) => {
      const run = readCalloutRun(lines, index, index === 0 || lines[index - 1] === '')
      return run ? [run.type] : []
    })

    expect(new Set(types)).toEqual(new Set(['info', 'warning']))
  })

  it('carries a top-level task block and a nested one', () => {
    const states = scanTaskCheckboxStates(markdown)
    expect([...states.values()].sort()).toEqual([false, true])

    const taskLines = lines.filter((line) => line.includes('{task:'))
    // `serializeTaskBlock` indents by two spaces when `parentTaskId` is set,
    // which is the only way the on-disk line expresses nesting.
    expect(taskLines.filter((line) => line.startsWith('- ['))).toHaveLength(1)
    expect(taskLines.filter((line) => line.startsWith('  - ['))).toHaveLength(1)
  })

  it('carries a file marker with a real size', () => {
    const markers = lines.filter((line) => FILE_BLOCK_LINE_REGEX.test(line))
    expect(markers).toHaveLength(1)
    expect(parseFileBlockMarker(markers[0])?.size).toBeGreaterThan(0)
  })

  it('carries a youtube embed marker', () => {
    expect(lines.filter((line) => EMBED_LINE_REGEX.test(line))).toHaveLength(1)
  })

  it('carries a bookmark marker', () => {
    expect(lines.filter((line) => BOOKMARK_LINE_REGEX.test(line))).toHaveLength(1)
  })

  it('carries a collapsed and an expanded toggle', () => {
    expect(lines.filter((line) => line === TOGGLE_OPEN_LINE)).toHaveLength(1)
    expect(lines.filter((line) => line === TOGGLE_OPEN_LINE_EXPANDED)).toHaveLength(1)
    expect(lines.filter((line) => line === TOGGLE_CLOSE_LINE)).toHaveLength(2)
  })

  it('carries a hash tag in body text, and the frontmatter tag that promotes it', () => {
    const tagged = lines.filter((line) => !line.startsWith('#') && HASH_TAG_IN_TEXT.test(line))
    expect(tagged).not.toHaveLength(0)

    // Measured, not assumed: `normalizeHashTags` returns the blocks untouched
    // when the note's tag list is empty, so `#work` in the body is literal text
    // until the frontmatter declares it. Drop the `tags:` key and this fixture
    // silently stops exercising the `hashTag` renderer at all.
    expect(markdown.startsWith('---\n')).toBe(true)
    const frontmatter = markdown.slice(4, markdown.indexOf('\n---\n', 4))
    expect(frontmatter).toMatch(/^tags:\n(?:\s+-\s+\S+\n?)+$/)
    for (const line of tagged) {
      const tag = HASH_TAG_IN_TEXT.exec(line)?.[0].trim().slice(1)
      expect(frontmatter).toContain(`- ${tag}`)
    }
  })

  it('carries a date mention with a reminder and one without', () => {
    const reminders = [...markdown.matchAll(DATE_MENTION_TOKEN_REGEX)].map(
      (match) => parseDateMentionToken(match[1])?.remind
    )

    expect(reminders).toContain('none')
    expect(reminders.filter((remind) => remind && remind !== 'none')).not.toHaveLength(0)
  })

  it('carries an inline image inside a table cell', () => {
    expect(cellLines.filter((line) => /!\[[^\]]*\]\([^)]+\)/.test(line))).not.toHaveLength(0)
  })

  it('carries a ticked and an unticked inline checkbox inside table cells', () => {
    expect(cellLines.filter((line) => line.includes('| [x] '))).not.toHaveLength(0)
    expect(cellLines.filter((line) => line.includes('| [ ] '))).not.toHaveLength(0)
  })

  it('carries a link mention token that decodes back to its url', () => {
    const payloads = [...markdown.matchAll(MENTION_TOKEN_REGEX)].map((match) => match[1])
    expect(payloads).toHaveLength(1)
    expect(parseLinkMentionToken(payloads[0])).toMatch(/^https:\/\//)
  })

  it('carries the table column-width and cell-colour markers', () => {
    const layouts = lines.flatMap((line) => {
      const layout = parseTableLayoutMarker(line)
      return layout ? [layout] : []
    })
    const colours = lines.flatMap((line) => {
      const cellColours = parseTableCellColorsMarker(line)
      return cellColours ? [cellColours] : []
    })

    expect(layouts).toHaveLength(1)
    expect(layouts[0].columnWidths.filter((width) => width !== null)).not.toHaveLength(0)
    expect(colours).toHaveLength(1)
    expect(Object.keys(colours[0])).not.toHaveLength(0)
  })
})
