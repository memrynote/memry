/**
 * #1959: `replaceNoteBodyInCrdt` must refresh the same side channels the
 * initial markdown seed does — link-reference definitions/usages (#1909) and
 * CriticMarkup marks — not just the fragment's blocks. Runs the real
 * `blocknote-converter` (only `crdt-provider` is stubbed) so the assertions
 * exercise the actual parse/write path an external edit goes through.
 */

import { describe, it, expect, vi } from 'vitest'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { readLinkReferencesFromYDoc } from '@memry/shared/link-references'
import { readCriticMarkupMarksFromYDoc } from '@memry/shared'
import { writeMarkdownSourceToYDoc } from '@memry/shared/markdown-source'
import { markdownToYFragment, yDocToMarkdown } from './blocknote-converter'

const getDoc = vi.fn()

vi.mock('../sync/crdt-provider', () => ({
  getCrdtProvider: () => ({ getDoc }),
  ORIGIN_LOCAL: 'local'
}))

import { replaceNoteBodyInCrdt } from './crdt-feed'

async function seed(markdown: string): Promise<Y.Doc> {
  const doc = new Y.Doc()
  const ok = await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))
  expect(ok, 'markdown reached the shared doc').toBe(true)
  return doc
}

describe('replaceNoteBodyInCrdt seed-parity (#1959)', () => {
  it('replaces a stale link-reference definition on an external edit', async () => {
    const doc = await seed('See [a][d].\n\n[d]: https://one.example')
    getDoc.mockReturnValue(doc)

    const ok = await replaceNoteBodyInCrdt('n1', 'See [a][d].\n\n[d]: https://two.example')
    expect(ok).toBe(true)

    const refs = readLinkReferencesFromYDoc(doc)
    expect(refs.definitions).toHaveLength(1)
    expect(refs.definitions[0]).toMatchObject({ label: 'd', destination: 'https://two.example' })

    // Clearing the raw-source record forces write-back through the same
    // canonical (fragment + side-channel array) path an edited region takes,
    // which is exactly where the stale array used to leak back out.
    writeMarkdownSourceToYDoc(doc, null)
    const writtenBack = await yDocToMarkdown(doc)
    expect(writtenBack).toContain('https://two.example')
    expect(writtenBack).not.toContain('https://one.example')
  })

  it('strips CriticMarkup and refreshes the marks array on an external edit', async () => {
    const doc = await seed('Hello {++brave++} world.')
    expect(readCriticMarkupMarksFromYDoc(doc)).toHaveLength(1)

    getDoc.mockReturnValue(doc)
    const ok = await replaceNoteBodyInCrdt('n1', 'Hello plain world.')
    expect(ok).toBe(true)

    // The new body has no CriticMarkup, so the stale mark must not survive.
    expect(readCriticMarkupMarksFromYDoc(doc)).toHaveLength(0)

    writeMarkdownSourceToYDoc(doc, null)
    const writtenBack = await yDocToMarkdown(doc)
    expect(writtenBack).toContain('Hello plain world.')
    expect(writtenBack).not.toContain('{++')
  })
})
