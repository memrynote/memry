import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import {
  readWritingAlternativesFromYDoc,
  readWritingGhostsFromYDoc,
  readWritingOverflowFromYDoc,
  writingFrontmatterOf
} from '@memry/shared'
import {
  markdownToYFragment,
  yDocToMarkdown,
  yDocToMarkdownWithWritingRanges
} from '../../src/main/sync/blocknote-converter'
import { serializeNoteBody } from '../../src/main/sync/writing-markdown'
import { parseNote } from '../../src/main/vault/frontmatter'
import { writeNoteFiles } from '../seed-vault/file-writer'
import {
  WRITING_DRAFTS_NOTE,
  WRITING_DRAFTS_NOTE_PATH,
  WRITING_DRAFTS_WRITING
} from './writing-drafts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The note as the app's first open reads it: the written file, through `parseNote`. */
function writtenNote(): ReturnType<typeof parseNote> {
  const vault = mkdtempSync(join(tmpdir(), 'writing-drafts-'))
  dirs.push(vault)
  writeNoteFiles(vault, [WRITING_DRAFTS_NOTE])
  return parseNote(
    readFileSync(join(vault, WRITING_DRAFTS_NOTE_PATH), 'utf8'),
    WRITING_DRAFTS_NOTE_PATH
  )
}

describe('writing tools demo note', () => {
  it('opens with every alternative, ghost and overflow item the file describes', async () => {
    const note = writtenNote()
    expect(writingFrontmatterOf(note.frontmatter)).toEqual(WRITING_DRAFTS_WRITING)

    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    expect(
      await markdownToYFragment(
        note.content,
        fragment,
        WRITING_DRAFTS_NOTE_PATH,
        writingFrontmatterOf(note.frontmatter)
      )
    ).toBe(true)

    const alternatives = readWritingAlternativesFromYDoc(doc)
    expect(alternatives.map((record) => record.id).sort()).toEqual(
      Object.keys(WRITING_DRAFTS_WRITING.alternatives).sort()
    )
    expect(alternatives.filter((record) => record.activeVariantId !== null)).toHaveLength(1)
    expect(readWritingGhostsFromYDoc(doc)).toHaveLength(2)
    expect(readWritingOverflowFromYDoc(doc)).toHaveLength(WRITING_DRAFTS_WRITING.overflow.length)

    // Every marker survived the real parse: writing the doc back carries them all.
    const written = await serializeNoteBody(
      doc,
      { notePath: WRITING_DRAFTS_NOTE_PATH },
      { yDocToMarkdown, yDocToMarkdownWithWritingRanges }
    )
    expect(written?.writing).toEqual(WRITING_DRAFTS_WRITING)
    expect(written?.markdown.match(/<!--ghost-->/g)).toHaveLength(2)
  })
})
