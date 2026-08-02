/**
 * What an Obsidian image embed looks like after a note has been opened and saved.
 *
 * The embed rewrite happens on the markdown string before it is parsed, so
 * whatever it produces is what `blocksToMarkdownLossy` writes back to the vault
 * file. Before this was fixed the round trip replaced `![[photo.png]]` with an
 * absolute `memry-file://` URL carrying this machine's home directory — into a
 * file that syncs to other devices and is supposed to stay readable in Obsidian.
 */

import { describe, it, expect, vi } from 'vitest'
import * as Y from 'yjs'

const NOTE = 'People/Person.md'

vi.mock('../vault/resolve-embed', () => ({
  resolveVaultEmbeds: (refs: string[], notePath?: string) =>
    Object.fromEntries(
      refs.map((ref) => [
        ref,
        // Mirrors the real resolver's two shapes: relative to the note when the
        // caller knows where the note lives, absolute otherwise.
        notePath ? `../Images/${ref}` : `memry-file://local/Users/me/vault/Images/${ref}`
      ])
    )
}))

async function roundTrip(markdown: string, notePath?: string): Promise<string | null> {
  const { markdownToYFragment, yDocToMarkdown } = await import('./blocknote-converter')
  const doc = new Y.Doc()
  const ok = await markdownToYFragment(markdown, doc.getXmlFragment('blocknote'), notePath)
  expect(ok).toBe(true)
  return yDocToMarkdown(doc, 'blocknote')
}

describe('obsidian image embed round trip', () => {
  it('writes the embed back as a portable relative link', async () => {
    const back = await roundTrip('Before\n\n![[photo.png]]\n\nAfter\n', NOTE)

    expect(back).toContain('![photo.png](../Images/photo.png)')
    expect(back).toContain('Before')
    expect(back).toContain('After')
  })

  it('never bakes an absolute machine path into the note', async () => {
    const back = await roundTrip('![[photo.png]]\n', NOTE)

    expect(back).not.toContain('memry-file://')
    expect(back).not.toContain('/Users/')
  })

  it('carries the sized form through as the same link', async () => {
    const back = await roundTrip('![[photo.png|300x200]]\n', NOTE)

    expect(back).toContain('![photo.png](../Images/photo.png)')
    expect(back).not.toContain('memry-file://')
  })

  it('leaves note transclusions and plain wikilinks alone', async () => {
    const back = await roundTrip('![[Some Note]]\n\n[[wikilink]]\n', NOTE)

    expect(back).toContain('![[Some Note]]')
    expect(back).toContain('[[wikilink]]')
  })

  // Read-only surfaces (canvas previews) have no note path and never persist
  // what they render, so an absolute URL there is harmless.
  it('still resolves to an absolute url when no note path is given', async () => {
    const back = await roundTrip('![[photo.png]]\n')

    expect(back).toContain('memry-file://')
  })
})
