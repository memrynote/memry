import { describe, expect, it } from 'vitest'
import { markdownToBlocks, yDocToMarkdown } from './blocknote-converter'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'

describe('blocknote-converter code block language', () => {
  it('returns empty markdown for an empty Yjs fragment', async () => {
    // #given
    const doc = new Y.Doc()

    // #when
    const result = await yDocToMarkdown(doc)

    // #then
    expect(result).toBe('')
  })

  it('preserves language when parsing markdown code fences to blocks', async () => {
    // #given
    const markdown = '```typescript\nconst x = 1\n```'

    // #when
    const blocks = await markdownToBlocks(markdown)

    // #then
    expect(blocks).not.toBeNull()
    const codeBlock = blocks!.find((b) => b.type === 'codeBlock')
    expect(codeBlock).toBeDefined()
    expect(codeBlock!.props).toHaveProperty('language')
    expect((codeBlock!.props as { language: string }).language).toBe('typescript')
  })

  it('preserves language when converting blocks to markdown', async () => {
    // #given
    const markdown = '```python\nprint("hello")\n```'
    const blocks = await markdownToBlocks(markdown)
    expect(blocks).not.toBeNull()

    // #when — round-trip: blocks back to markdown via Yjs
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    const { blocksToYFragment } = await import('./blocknote-converter')
    const ok = blocksToYFragment(blocks!, fragment)
    expect(ok).toBe(true)

    const result = await yDocToMarkdown(doc)

    // #then
    expect(result).not.toBeNull()
    expect(result).toContain('```python')
  })

  it('round-trips code block language through markdown → blocks → Yjs → markdown', async () => {
    // #given
    const original = '```javascript\nfunction foo() { return 42 }\n```'

    // #when
    const blocks = await markdownToBlocks(original)
    expect(blocks).not.toBeNull()

    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    const { blocksToYFragment } = await import('./blocknote-converter')
    blocksToYFragment(blocks!, fragment)

    const result = await yDocToMarkdown(doc)

    // #then
    expect(result).not.toBeNull()
    expect(result).toContain('```javascript')
    expect(result).toContain('function foo()')
  })

  it('handles code blocks with no language specified', async () => {
    // #given
    const markdown = '```\nplain code\n```'

    // #when
    const blocks = await markdownToBlocks(markdown)

    // #then
    expect(blocks).not.toBeNull()
    const codeBlock = blocks!.find((b) => b.type === 'codeBlock')
    expect(codeBlock).toBeDefined()
  })

  it('preserves extra blank lines through markdown to Yjs round-trip', async () => {
    // #given
    const markdown = 'Alpha\n\n\nBeta'
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    const { markdownToYFragment, yFragmentToBlocks } = await import('./blocknote-converter')

    // #when
    const ok = await markdownToYFragment(markdown, fragment)
    const blocks = await yFragmentToBlocks(fragment)
    const result = await yDocToMarkdown(doc)

    // #then
    expect(ok).toBe(true)
    expect(blocks).not.toBeNull()
    expect(
      blocks!.some(
        (block) => block.type === 'paragraph' && (block.content as unknown[]).length === 0
      )
    ).toBe(true)
    expect(result).toContain('Alpha')
    expect(result).toContain('Beta')
    expect(result).toContain('\n\n\n\n')
  })
})
