/**
 * Golden round-trip suite: adversarial vault files must survive
 * parse → (no edit) → serialize byte-identical, and no-op saves must not
 * touch the file at all. Regression insurance for the obs specs (01–06).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, readdirSync, copyFileSync, mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { parseNote, serializeParsedNote } from './frontmatter'
import { writeIfChanged } from './file-ops'

const FIXTURES_DIR = path.join(__dirname, '__fixtures__', 'golden-vault')
const fixtures = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.md'))

let tempDir: string

beforeAll(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'golden-vault-'))
})

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('golden round-trip (no edit)', () => {
  it('has the full adversarial fixture set', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(14)
  })

  it.each(fixtures)('%s survives parse → serialize byte-identical', (name) => {
    const filePath = path.join(FIXTURES_DIR, name)
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = parseNote(raw, filePath)

    const out = serializeParsedNote(parsed, parsed.content, { frontmatterEdited: false })

    expect(out).toBe(raw)
    // Byte-level compare catches encoding surprises (BOM, CR) that string
    // equality on decoded text could mask.
    expect(Buffer.compare(Buffer.from(out, 'utf-8'), readFileSync(filePath))).toBe(0)
  })

  it.each(fixtures)('%s no-op save skips the write and keeps mtime', async (name) => {
    const src = path.join(FIXTURES_DIR, name)
    const dest = path.join(tempDir, name)
    copyFileSync(src, dest)

    const raw = readFileSync(dest, 'utf-8')
    const parsed = parseNote(raw, dest)
    const out = serializeParsedNote(parsed, parsed.content, { frontmatterEdited: false })

    const before = statSync(dest).mtimeMs
    const wrote = await writeIfChanged(dest, out)
    const after = statSync(dest).mtimeMs

    expect(wrote).toBe(false)
    expect(after).toBe(before)
  })
})

describe('golden mutations (scope honesty)', () => {
  it('a property edit rewrites the frontmatter block but keeps the body verbatim', () => {
    const filePath = path.join(FIXTURES_DIR, 'yaml-comments.md')
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = parseNote(raw, filePath)

    parsed.frontmatter.status = 'done'
    const out = serializeParsedNote(parsed, parsed.content, { frontmatterEdited: true })

    expect(out).not.toBe(raw)
    expect(out.endsWith(parsed.content)).toBe(true)
    expect(out).toContain('status: done')
  })

  it('a body edit keeps the frontmatter block byte-identical', () => {
    const filePath = path.join(FIXTURES_DIR, 'yaml-weird-quoting.md')
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = parseNote(raw, filePath)

    const out = serializeParsedNote(parsed, parsed.content + 'Appended line.\n', {
      frontmatterEdited: false
    })

    expect(out).not.toBe(raw)
    expect(parsed.rawFrontmatterBlock).not.toBeNull()
    expect(out.startsWith(parsed.rawFrontmatterBlock as string)).toBe(true)
  })

  it('a body edit on a CRLF file converts to CRLF and keeps the final newline', () => {
    const filePath = path.join(FIXTURES_DIR, 'crlf.md')
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = parseNote(raw, filePath)
    expect(parsed.eol).toBe('\r\n')
    expect(parsed.hadTrailingNewline).toBe(true)

    // Editors emit LF-only markdown
    const out = serializeParsedNote(parsed, 'New body line one.\nLine two.', {
      frontmatterEdited: false
    })

    expect(out.startsWith(parsed.rawFrontmatterBlock as string)).toBe(true)
    expect(out.endsWith('New body line one.\r\nLine two.\r\n')).toBe(true)
  })

  it('a body edit on a file without final newline stays without one', () => {
    const filePath = path.join(FIXTURES_DIR, 'no-trailing-newline.md')
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = parseNote(raw, filePath)
    expect(parsed.hadTrailingNewline).toBe(false)

    const out = serializeParsedNote(parsed, 'Replaced body.\n', { frontmatterEdited: false })

    expect(out.startsWith(parsed.rawFrontmatterBlock as string)).toBe(true)
    expect(out.endsWith('Replaced body.')).toBe(true)
  })

  it('writeIfChanged writes when content differs', async () => {
    const dest = path.join(tempDir, 'mutation-target.md')
    copyFileSync(path.join(FIXTURES_DIR, 'no-frontmatter.md'), dest)
    const raw = readFileSync(dest, 'utf-8')

    const wrote = await writeIfChanged(dest, raw + 'Changed.\n')

    expect(wrote).toBe(true)
    expect(readFileSync(dest, 'utf-8')).toBe(raw + 'Changed.\n')
  })
})
