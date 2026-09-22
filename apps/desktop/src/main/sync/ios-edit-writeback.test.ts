/**
 * R01 and R02 — what desktop writes to the vault file after an iOS edit.
 *
 * **These do not need a phone, and that is the point.** An iOS edit is a CRDT
 * update, and `block-edit.json` already pins the document each operation must
 * leave behind: those expectations are produced by the Rust writer and held to
 * BlockNote's own output by `crates/memry-core/tests/block_edit_vectors.rs`.
 * So the document desktop would receive from a phone is already committed, and
 * what remains to check is the half that lives here — what desktop's
 * write-back turns it into.
 *
 * Running the real `yDocToMarkdown` rather than a stand-in is what makes this
 * worth anything: FR-041 is a claim about the bytes in the user's file, and
 * only the function that writes those bytes can answer it.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import { yDocToMarkdown } from './blocknote-converter'

const CLASS_PATH = join(__dirname, '../../../../../packages/contracts/test-vectors/block-edit.json')

interface EditCase {
  name: string
  pins: string
  baseUpdateHex: string
  expectedUpdateHex: string
  op: { kind: string; blockId?: string }
  pending?: { task: string; reason: string }
}

function vectors(): EditCase[] {
  const parsed = JSON.parse(readFileSync(CLASS_PATH, 'utf8')) as { cases: EditCase[] }
  return parsed.cases
}

function docOf(hex: string): Y.Doc {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, Uint8Array.from(Buffer.from(hex, 'hex')))
  return doc
}

/**
 * A file's content lines.
 *
 * **Blank lines are dropped on purpose.** They separate blocks, so their count
 * legitimately changes when a block is added or removed — and because they are
 * all identical, keeping them makes any set comparison meaningless. What
 * FR-041 is about is the content lines: whether a note the user barely touched
 * comes back re-wrapped and re-spelled.
 */
function contentLines(file: string): string[] {
  return file.split('\n').filter((line) => line.trim() !== '')
}

/** The content lines that differ between two files, in order. */
function changedLines(before: string, after: string): { removed: string[]; added: string[] } {
  const beforeLines = contentLines(before)
  const afterLines = contentLines(after)
  const removed = beforeLines.filter((line) => !afterLines.includes(line))
  const added = afterLines.filter((line) => !beforeLines.includes(line))
  return { removed, added }
}

/**
 * The lines both files share, in the order each file has them.
 *
 * Equal orders mean the untouched blocks were not moved or re-spelled, which
 * is the half of FR-041 a line count cannot see.
 */
function survivingOrder(before: string, after: string): { before: string[]; after: string[] } {
  const beforeLines = contentLines(before)
  const afterLines = contentLines(after)
  return {
    before: beforeLines.filter((line) => afterLines.includes(line)),
    after: afterLines.filter((line) => beforeLines.includes(line))
  }
}

describe('R01 an iOS edit changes only the region it edited', () => {
  it('has a class to work from', () => {
    expect(vectors().length).toBeGreaterThan(0)
  })

  /**
   * FR-041, asserted where it is actually true or false: in the file.
   *
   * A writer that rebuilt the body rather than editing it in place would pass
   * every CRDT check and still rewrite the whole file — re-wrapping lines,
   * re-spelling emphasis, reordering attributes — and the user would see it as
   * a diff across a note they barely touched.
   */
  it.each(vectors().filter((entry) => !entry.pending))(
    'only the edited region moves: $name',
    async (entry) => {
      const before = await yDocToMarkdown(docOf(entry.baseUpdateHex))
      const after = await yDocToMarkdown(docOf(entry.expectedUpdateHex))

      // A document the converter cannot serialize is not a pass. It means the
      // operation produced something desktop would refuse to write, which is
      // exactly what this test exists to catch.
      expect(before, `${entry.name}: the base did not serialize`).not.toBeNull()
      expect(after, `${entry.name}: the result did not serialize`).not.toBeNull()

      const { removed, added } = changedLines(before as string, after as string)

      // At most one line arrives, for every operation: none of them writes a
      // second block.
      expect(
        added.length,
        `${entry.name} added ${added.length} lines: ${JSON.stringify(added)}`
      ).toBeLessThanOrEqual(1)

      // **A delete may take more than one line, and that is correct**: a block
      // owns the blocks nested under it, so deleting a list item removes its
      // children too. The first version of this test asserted one line and
      // failed on exactly that case — the assertion was wrong about the
      // operation, not the writer. Every other operation touches one block.
      if (entry.op.kind !== 'delete') {
        expect(
          removed.length,
          `${entry.name} removed ${removed.length} lines: ${JSON.stringify(removed)}`
        ).toBeLessThanOrEqual(1)
      }

      // The half a line count cannot see: whatever survived must have
      // survived **in place**. A writer that rebuilt the body would pass every
      // CRDT check, re-wrap and re-spell every untouched line, and hand the
      // user a diff across a note they barely touched.
      const surviving = survivingOrder(before as string, after as string)
      expect(surviving.after, `${entry.name} moved or re-spelled lines it did not edit`).toEqual(
        surviving.before
      )
    }
  )

  /**
   * The inverse, and the reason the test above is not vacuous: an operation
   * that changed nothing in the file would satisfy "only the edited region
   * moved" trivially.
   */
  it('a text edit really does reach the file', async () => {
    const entry = vectors().find(
      (candidate) => candidate.op.kind === 'setText' && !candidate.pending
    )
    expect(entry, 'the class must carry a setText case').toBeDefined()

    const before = await yDocToMarkdown(docOf((entry as EditCase).baseUpdateHex))
    const after = await yDocToMarkdown(docOf((entry as EditCase).expectedUpdateHex))
    expect(after).not.toEqual(before)
  })
})

describe('R02 a table edit is written as desktop would write it', () => {
  function tableCase(kind: string): EditCase {
    const found = vectors().find((entry) => entry.op.kind === kind && !entry.pending)
    if (!found) throw new Error(`the class carries no ${kind} case`)
    return found
  }

  /**
   * **The markers are the whole of R02.**
   *
   * A table's column widths and cell colours cannot be written in markdown
   * table syntax, so desktop keeps them in `<!-- table-layout: -->` and
   * `<!-- table-colors: -->` comments beside the table. An iOS edit that
   * produced a document desktop regenerated different markers from would
   * silently drop the user's column widths or colours on the next write-back.
   */
  it('regenerates the column widths from the document iOS leaves behind', async () => {
    const entry = tableCase('setCellText')
    const before = await yDocToMarkdown(docOf(entry.baseUpdateHex))
    const after = await yDocToMarkdown(docOf(entry.expectedUpdateHex))

    expect(before, 'the base did not serialize').not.toBeNull()
    expect(after, 'the edited table did not serialize').not.toBeNull()

    const layout = /<!--\s*table-layout:.*?-->/
    expect(before as string, 'the base table must carry a layout marker').toMatch(layout)

    // Editing a cell's text must not disturb the widths: they belong to the
    // columns, not to what is written in them.
    expect((after as string).match(layout)?.[0]).toEqual((before as string).match(layout)?.[0])

    // And the edit really landed, or the comparison above proves nothing.
    expect(after).toContain('42')
  })

  /**
   * A cell colour has to reach the `table-colors` marker, because that is the
   * only place markdown can carry it.
   */
  it('regenerates the cell colours from the document iOS leaves behind', async () => {
    const entry = tableCase('setCellProp')
    const before = await yDocToMarkdown(docOf(entry.baseUpdateHex))
    const after = await yDocToMarkdown(docOf(entry.expectedUpdateHex))

    expect(before, 'the base did not serialize').not.toBeNull()
    expect(after, 'the coloured table did not serialize').not.toBeNull()

    const colors = /<!--\s*table-colors:.*?-->/
    // The base has no colours, so it carries no marker to regenerate.
    expect(before as string).not.toMatch(colors)
    // The edit gives one cell a colour, so the marker has to appear.
    expect(
      after as string,
      'a coloured cell must reach the table-colors marker, or the colour is ' +
        'lost on the next write-back'
    ).toMatch(colors)
    expect(after as string).toContain('yellow')
  })

  /**
   * The bytes desktop writes for an iOS table edit must be the bytes desktop
   * would have written itself. Serialising the same document twice is the
   * closest a test can get to that without a second machine, and it catches
   * the failure that matters: a marker that depends on anything other than
   * the document.
   */
  it('writes the same bytes twice for the same document', async () => {
    const entry = tableCase('setCellProp')
    const once = await yDocToMarkdown(docOf(entry.expectedUpdateHex))
    const twice = await yDocToMarkdown(docOf(entry.expectedUpdateHex))
    expect(twice).toEqual(once)
  })
})
