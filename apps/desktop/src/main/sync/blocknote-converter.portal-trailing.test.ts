/**
 * The host editor keeps an empty paragraph after a trailing portal
 * (`portal-trailing-paragraph-plugin`). It must write nothing: a note that ends
 * in a fence keeps the same bytes on every save.
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { writeMarkdownSourceToYDoc } from '@memry/shared/markdown-source'
import {
  blocksToYFragment,
  markdownToYFragment,
  yDocToMarkdown,
  yFragmentToBlocks
} from './blocknote-converter'

// The body as the serializer writes it: the file writer adds the final newline.
const FENCE = '```memry-portal\n{\n  "v": 1,\n  "note": "src"\n}\n```'

/** Seed, then append the empty trailing paragraph the way the editor does. */
async function saveWithTrailingParagraph(markdown: string, keepSource: boolean): Promise<string> {
  const seeded = new Y.Doc()
  await markdownToYFragment(markdown, seeded.getXmlFragment(CRDT_FRAGMENT_NAME))
  if (!keepSource) writeMarkdownSourceToYDoc(seeded, null)
  const blocks = await yFragmentToBlocks(seeded.getXmlFragment(CRDT_FRAGMENT_NAME))
  expect(blocks?.at(-1)?.type).toBe('codeBlock')
  const edited = new Y.Doc()
  const withParagraph = [
    ...(blocks ?? []),
    { type: 'paragraph', props: {}, content: [], children: [] }
  ]
  expect(blocksToYFragment(withParagraph as never, edited.getXmlFragment(CRDT_FRAGMENT_NAME))).toBe(
    true
  )
  if (keepSource) {
    const { readMarkdownSourceRecordFromYDoc } = await import('@memry/shared/markdown-source')
    const record = readMarkdownSourceRecordFromYDoc(seeded)
    if (record) writeMarkdownSourceToYDoc(edited, record.source)
  }
  const out = await yDocToMarkdown(edited)
  expect(out).not.toBeNull()
  return out as string
}

describe('trailing empty paragraph after a portal', () => {
  const cases = [
    ['a note ending in a portal', `- Intro\n\n${FENCE}`],
    ['a note that is only a portal', FENCE]
  ] as const

  it.each(cases)('writes the same canonical bytes for %s', async (_name, markdown) => {
    const plain = new Y.Doc()
    await markdownToYFragment(markdown, plain.getXmlFragment(CRDT_FRAGMENT_NAME))
    writeMarkdownSourceToYDoc(plain, null)
    const without = await yDocToMarkdown(plain)
    expect(await saveWithTrailingParagraph(markdown, false)).toBe(without)
  })

  it.each(cases)('keeps the file bytes for %s', async (_name, markdown) => {
    expect(await saveWithTrailingParagraph(markdown, true)).toBe(markdown)
  })
})
