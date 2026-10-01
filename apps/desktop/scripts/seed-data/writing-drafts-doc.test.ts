import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import {
  readWritingAlternativesFromYDoc,
  readWritingGhostsFromYDoc,
  readWritingOverflowFromYDoc
} from '@memry/shared'
import { yDocToMarkdown, yFragmentToBlocks } from '../../src/main/sync/blocknote-converter'
import { parseNote } from '../../src/main/vault/frontmatter'
import { writeNoteFiles } from '../seed-vault/file-writer'
import {
  WRITING_DRAFTS_BODY,
  WRITING_DRAFTS_METADATA,
  WRITING_DRAFTS_NOTE,
  WRITING_DRAFTS_NOTE_PATH
} from './writing-drafts'
import {
  buildWritingDraftsDoc,
  checkWritingDraftsDoc,
  resolveWritingAnchorText
} from './writing-drafts-doc'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The body the app's first open would seed from: the written file, through `parseNote`. */
function writtenContent(): string {
  const vault = mkdtempSync(join(tmpdir(), 'writing-drafts-'))
  dirs.push(vault)
  writeNoteFiles(vault, [WRITING_DRAFTS_NOTE])
  const raw = readFileSync(join(vault, WRITING_DRAFTS_NOTE_PATH), 'utf8')
  return parseNote(raw, WRITING_DRAFTS_NOTE_PATH).content
}

async function seededDoc(): Promise<Y.Doc> {
  return buildWritingDraftsDoc(
    WRITING_DRAFTS_METADATA.id,
    writtenContent(),
    WRITING_DRAFTS_NOTE_PATH
  )
}

interface AnyBlock {
  type: string
  props?: Record<string, unknown>
  children?: AnyBlock[]
}

function flatten(blocks: AnyBlock[]): AnyBlock[] {
  return blocks.flatMap((block) => [block, ...flatten(block.children ?? [])])
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length
}

describe('Why memrynote keeps your drafts seed note', () => {
  it('anchors every alternative and ghost to the text the body shows', async () => {
    const doc = await seededDoc()
    expect(checkWritingDraftsDoc(doc)).toEqual([])
  })

  it('still resolves after the doc round-trips through its encoded state', async () => {
    // What the app does on open: a fresh doc with the persisted state applied.
    const loaded = new Y.Doc({ guid: WRITING_DRAFTS_METADATA.id })
    Y.applyUpdate(loaded, Y.encodeStateAsUpdate(await seededDoc()))
    expect(checkWritingDraftsDoc(loaded)).toEqual([])
    expect(loaded.getXmlFragment(CRDT_FRAGMENT_NAME).length).toBeGreaterThan(0)
  })

  it('seeds the records the demo needs', async () => {
    const doc = await seededDoc()
    const alternatives = readWritingAlternativesFromYDoc(doc)
    expect(alternatives.map((a) => a.variants.map((v) => v.source))).toEqual([
      ['user', 'user'],
      ['user', 'user', 'user', 'ai', 'ai'],
      ['user']
    ])
    const [heading, word, sentence] = alternatives
    expect(resolveWritingAnchorText(doc, heading.anchorStart, heading.anchorEnd)).toBe(
      'Drafts are where the thinking happens'
    )
    expect(resolveWritingAnchorText(doc, word.anchorStart, word.anchorEnd)).toBe('quiet')
    // The paragraph alternative shows its variant; the original is only in the record.
    expect(sentence.activeVariantId).toBe(sentence.variants[0].id)
    expect(WRITING_DRAFTS_BODY).toContain(sentence.variants[0].text)
    expect(WRITING_DRAFTS_BODY).not.toContain(sentence.original)
    expect(heading.activeVariantId).toBeNull()
    expect(word.activeVariantId).toBeNull()

    expect(readWritingGhostsFromYDoc(doc)).toHaveLength(2)
    expect(readWritingOverflowFromYDoc(doc).map((item) => item.label)).toEqual([
      'Spare paragraph',
      'Words I like',
      'Outline',
      'Quote'
    ])
  })

  it('uses varied blocks and writes back byte for byte', async () => {
    const doc = await seededDoc()
    const blocks = flatten(
      ((await yFragmentToBlocks(doc.getXmlFragment(CRDT_FRAGMENT_NAME))) ?? []) as AnyBlock[]
    )
    const types = new Set(blocks.map((block) => block.type))
    for (const type of [
      'heading',
      'paragraph',
      'quote',
      'callout',
      'bulletListItem',
      'numberedListItem',
      'checkListItem',
      'codeBlock',
      'divider'
    ]) {
      expect(types, type).toContain(type)
    }
    const levels = new Set(
      blocks.filter((block) => block.type === 'heading').map((block) => block.props?.level)
    )
    expect([...levels].sort()).toEqual([1, 2, 3])
    // Plain checkboxes, so the checklist never turns into seeded tasks.
    for (const block of blocks.filter((b) => b.type === 'checkListItem')) {
      expect(block.props?.plain).toBe(true)
    }

    // A body that re-serializes differently would be written back over the
    // file on first open.
    expect(
      await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath: WRITING_DRAFTS_NOTE_PATH })
    ).toBe(writtenContent())
  })

  it('reads like a post, not a fixture', () => {
    const words = wordCount(WRITING_DRAFTS_BODY)
    expect(words).toBeGreaterThanOrEqual(600)
    expect(words).toBeLessThanOrEqual(900)
  })
})
