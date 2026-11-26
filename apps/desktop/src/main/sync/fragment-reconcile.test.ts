import { describe, it, expect, vi } from 'vitest'
import * as Y from 'yjs'

vi.mock('./crdt-provider', () => ({
  getCrdtProvider: () => ({ getDoc: () => undefined }),
  ORIGIN_LOCAL: 'local'
}))
vi.mock('../database', () => ({ getIndexDatabase: () => ({}) }))
vi.mock('@main/database/queries/notes', () => ({ getNoteCacheById: () => undefined }))

import { replaceDocBody } from './crdt-feed'
import { markdownToYFragment, yDocToMarkdown } from './blocknote-converter'

const FRAGMENT = 'prosemirror'

async function seeded(markdown: string): Promise<Y.Doc> {
  const doc = new Y.Doc()
  await markdownToYFragment(markdown, doc.getXmlFragment(FRAGMENT), 'n.md')
  return doc
}

const bodyOf = (doc: Y.Doc): Promise<string | null> =>
  yDocToMarkdown(doc, FRAGMENT, { notePath: 'n.md' })

describe('the block-keeping body replace (#5319)', () => {
  it.each([
    {
      case: 'an html code block',
      before: 'Intro\n\n```html\n<div id="main">x</div>\n```\n\nOutro',
      after: 'Intro\n\n```html\n<div id="footer">x</div>\n```\n\nOutro'
    },
    {
      case: 'plain inline text',
      before: 'Intro\n\nset id="1" here\n\nOutro',
      after: 'Intro\n\nset id="2" here\n\nOutro'
    }
  ])('takes an edit to id="..." typed in $case', async ({ before, after }) => {
    const live = await seeded(before)

    expect(await replaceDocBody(live, 'n', after)).toBe(true)

    expect(await bodyOf(live)).toBe(await bodyOf(await seeded(after)))
  })

  it('keeps a peer edit inside a block the feed left unchanged', async () => {
    const live = await seeded('One\n\nTwo\n\nThree')
    const peer = new Y.Doc()
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(live))
    const group = peer.getXmlFragment(FRAGMENT).get(0) as Y.XmlElement
    const paragraph = (group.get(group.length - 1) as Y.XmlElement).get(0) as Y.XmlElement
    ;(paragraph.get(0) as Y.XmlText).insert(5, ' peer')
    const seen = Y.encodeStateVector(live)

    await replaceDocBody(live, 'n', 'One\n\nTwo changed\n\nThree')
    Y.applyUpdate(live, Y.encodeStateAsUpdate(peer, seen))

    expect(await bodyOf(live)).toBe('One\n\nTwo changed\n\nThree peer')
  })
})
