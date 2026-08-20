import { describe, expect, it } from 'vitest'
import { ServerBlockNoteEditor } from '@blocknote/server-util'
import { createMemrySchema } from '@memry/editor-schema'
import { createServerBlockSpecs, createServerInlineSpecs } from '@memry/editor-schema/server'

const schema = createMemrySchema({
  blocks: createServerBlockSpecs(),
  inline: createServerInlineSpecs()
})
const ed = () => ServerBlockNoteEditor.create({ schema } as never) as ServerBlockNoteEditor

async function trip(label: string, md: string) {
  const editor = ed()
  const blocks = await editor.tryParseMarkdownToBlocks(md)
  const found = JSON.stringify(blocks).match(/"inlineImage","props":\{[^}]*\}/)?.[0]
  const back = await editor.blocksToMarkdownLossy(blocks)
  console.log(`${label} PARSED=${found} BACK=${JSON.stringify(back)}`)
}

describe('spike width carriers', () => {
  it('a', () => trip('A-numeric-alt', '| a |\n| --- |\n| ![300](x.png) |\n'))
  it('b', () => trip('B-escaped-pipe', '| a |\n| --- |\n| ![shot.png\\|300](x.png) |\n'))
  it('c', () => trip('C-title', '| a |\n| --- |\n| ![shot.png](x.png "300") |\n'))
  it('d', () => trip('D-dims', '| a |\n| --- |\n| ![300x200](x.png) |\n'))
  it('ok', () => expect(true).toBe(true))
})
