import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { ServerBlockNoteEditor } from '@blocknote/server-util'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { writeMarkdownSourceToYDoc } from '@memry/shared/markdown-source'
import { loadBlockNoteConverter } from './blocknote-converter-loader'
import { SERVER_EDITOR_IDLE_RELEASE_MS } from './blocknote-converter'

const MARKDOWN = '# Title\n\n- one\n- two\n\n```ts\nconst x = 1\n```\n\nBody with **bold** text.'

async function roundTrip(markdown: string): Promise<string | null> {
  const { markdownToYFragment, yDocToMarkdown } = await loadBlockNoteConverter()
  const doc = new Y.Doc()
  expect(await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))).toBe(true)
  // House style, so both passes serialize from the document alone.
  writeMarkdownSourceToYDoc(doc, null)
  return yDocToMarkdown(doc)
}

describe('loadBlockNoteConverter', () => {
  it('shares one load between concurrent first callers', async () => {
    const first = loadBlockNoteConverter()
    const second = loadBlockNoteConverter()

    expect(second).toBe(first)
    expect(await second).toBe(await first)
  })
})

describe('blocknote-converter idle release', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('rebuilds the server editor after an idle period and converts byte-identically', async () => {
    vi.useFakeTimers()
    const create = vi.spyOn(ServerBlockNoteEditor, 'create')

    const before = await roundTrip(MARKDOWN)
    const createdBeforeRelease = create.mock.calls.length
    // #when a burst is over and nothing converts for the idle period
    vi.advanceTimersByTime(SERVER_EDITOR_IDLE_RELEASE_MS)
    const after = await roundTrip(MARKDOWN)

    // #then a new editor is built, and it writes exactly the same bytes
    expect(create.mock.calls.length).toBe(createdBeforeRelease + 1)
    expect(after).not.toBeNull()
    expect(after).toBe(before)
  })

  it('keeps the server editor while conversions keep arriving', async () => {
    vi.useFakeTimers()
    await roundTrip(MARKDOWN)
    const create = vi.spyOn(ServerBlockNoteEditor, 'create')

    // #when each conversion lands inside the idle window of the previous one
    vi.advanceTimersByTime(SERVER_EDITOR_IDLE_RELEASE_MS - 1)
    await roundTrip(MARKDOWN)
    vi.advanceTimersByTime(SERVER_EDITOR_IDLE_RELEASE_MS - 1)
    await roundTrip(MARKDOWN)

    // #then the same editor serves all of them
    expect(create).not.toHaveBeenCalled()
  })
})
