// PDF export through the print window (Step 34, #3551): each page size Electron's `printToPDF`
// offered gives pages of that size, a note longer than a page gives several, and a missing note
// answers `not_found` without a file. Pixel fidelity against the Electron baselines is stage D.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createNote, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

/** `ExportNoteInput` of `commands/export.rs`. */
interface ExportInput {
  noteId: string
  includeMetadata?: boolean
  pageSize?: 'A4' | 'Letter' | 'Legal'
  outputPath?: string
}

interface ExportResult {
  success: boolean
  path?: string
  code?: 'cancelled' | 'not_found' | 'failed'
  error?: string
}

const SIZES = {
  A4: [595.28, 841.89],
  Letter: [612, 792],
  Legal: [612, 1008]
} as const

const exportPdf = (page: Page, input: ExportInput) =>
  invoke<ExportResult>(page, 'notes_export_pdf', { input })

/** Every page's `/MediaBox` width and height, in points. */
function pageBoxes(pdf: Buffer): Array<[number, number]> {
  const boxes = pdf
    .toString('latin1')
    .matchAll(/\/MediaBox\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*\]/g)
  return [...boxes].map((m) => [Number(m[3]) - Number(m[1]), Number(m[4]) - Number(m[2])])
}

/** A note several pages long at any of the sizes. */
function longNote(): string {
  const para =
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. '.repeat(
      5
    )
  const sections = Array.from({ length: 30 }, (_, i) => `## Section ${i}\n\n${para}`)
  return `# Long note\n\n\`\`\`js\nconst x = 1\n\`\`\`\n\n| A | B |\n|---|---|\n| one | two |\n\n${sections.join('\n\n')}\n\nThe last paragraph.\n`
}

test('each page size prints pages of that size', async ({ page }) => {
  await vaultOpen(page)
  const note = await createNote(page, {
    title: `PDF sizes ${Date.now()}`,
    content: longNote(),
    folder: 'notes'
  })
  const dir = mkdtempSync(join(tmpdir(), 'memry-export-pdf-'))
  try {
    for (const [size, [width, height]] of Object.entries(SIZES) as Array<
      [keyof typeof SIZES, readonly [number, number]]
    >) {
      const out = join(dir, `${size}.pdf`)
      const result = await exportPdf(page, { noteId: note.id, pageSize: size, outputPath: out })
      expect(result).toEqual({ success: true, path: out })
      const pdf = readFileSync(out)
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
      const boxes = pageBoxes(pdf)
      expect(boxes.length).toBeGreaterThan(1)
      for (const [w, h] of boxes) {
        expect(Math.abs(w - width)).toBeLessThanOrEqual(1)
        expect(Math.abs(h - height)).toBeLessThanOrEqual(1)
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing note answers not_found and writes nothing', async ({ page }) => {
  await vaultOpen(page)
  const dir = mkdtempSync(join(tmpdir(), 'memry-export-pdf-'))
  try {
    const out = join(dir, 'missing.pdf')
    const result = await exportPdf(page, { noteId: 'no-such-note', outputPath: out })
    expect(result.success).toBe(false)
    expect(result.code).toBe('not_found')
    expect(existsSync(out)).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
