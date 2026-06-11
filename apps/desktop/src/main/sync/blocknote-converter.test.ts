import { describe, expect, it } from 'vitest'
import {
  markdownToBlocks,
  yDocToMarkdown,
  blocksToYFragment,
  markdownToYFragment,
  yFragmentToBlocks
} from './blocknote-converter'
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

  it('applies block color markers when parsing markdown to blocks', async () => {
    // #given
    const markdown = 'Plain intro\n<!-- colors:{"textColor":"red"} -->\nColored line'

    // #when
    const blocks = await markdownToBlocks(markdown)

    // #then
    expect(blocks).not.toBeNull()
    const texts = blocks!.map((b) =>
      ((b.content as Array<{ text?: string }>) ?? []).map((c) => c.text).join('')
    )
    expect(texts).toEqual(['Plain intro', 'Colored line'])
    expect((blocks![0].props as { textColor: string }).textColor).toBe('default')
    expect((blocks![1].props as { textColor: string }).textColor).toBe('red')
  })

  it('round-trips block colors through markdown → Yjs → markdown', async () => {
    // #given
    const markdown =
      'Plain intro\n<!-- colors:{"textColor":"red","backgroundColor":"yellow"} -->\nColored line'
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    const { markdownToYFragment } = await import('./blocknote-converter')

    // #when
    const ok = await markdownToYFragment(markdown, fragment)
    const result = await yDocToMarkdown(doc)

    // #then
    expect(ok).toBe(true)
    expect(result).toContain('Plain intro')
    expect(result).toContain(
      '<!-- colors:{"textColor":"red","backgroundColor":"yellow"} -->\nColored line'
    )
  })

  it('keeps list item content when a middle item is colored', async () => {
    // #given
    const markdown = '- one\n<!-- colors:{"backgroundColor":"blue"} -->\n- two\n- three'
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    const { markdownToYFragment } = await import('./blocknote-converter')

    // #when
    const ok = await markdownToYFragment(markdown, fragment)
    const result = await yDocToMarkdown(doc)

    // #then
    expect(ok).toBe(true)
    expect(result).toContain('one')
    expect(result).toContain('two')
    expect(result).toContain('three')
    expect(result).toContain('<!-- colors:{"backgroundColor":"blue"} -->')
  })

  it('seeds CriticMarkup as plain Yjs content with review marks metadata', async () => {
    // #given
    const markdown = 'Keep {--deleted--} and {++added++}'
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    const { markdownToYFragment } = await import('./blocknote-converter')

    // #when
    const ok = await markdownToYFragment(markdown, fragment)
    const result = await yDocToMarkdown(doc)
    const marks = doc.getArray('criticMarkupMarks').toArray()

    // #then
    expect(ok).toBe(true)
    expect(result?.trimEnd()).toBe('Keep deleted and added')
    expect(result).not.toContain('{--')
    expect(result).not.toContain('{++')
    expect(marks).toEqual([
      expect.objectContaining({ kind: 'deletion', visibleText: 'deleted', start: 5, end: 12 }),
      expect.objectContaining({ kind: 'addition', visibleText: 'added', start: 17, end: 22 })
    ])
  })

  it('seeds a {task:} checkbox into the Yjs doc as a taskBlock node (no raw checkbox)', async () => {
    // #given
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)

    // #when
    const ok = await markdownToYFragment('- [ ] Buy milk {task:abc-123}', fragment)
    const blocks = await yFragmentToBlocks(fragment)

    // #then
    expect(ok).toBe(true)
    expect(blocks).not.toBeNull()
    const task = blocks!.find((b) => b.type === 'taskBlock')
    expect(task).toBeTruthy()
    expect(task!.props).toMatchObject({ taskId: 'abc-123', title: 'Buy milk', checked: false })
    expect(blocks!.some((b) => b.type === 'checkListItem')).toBe(false)
  })

  it('round-trips a checked taskBlock back to its {task:} markdown line', async () => {
    // #given
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)

    // #when
    await markdownToYFragment('- [x] Ship it {task:t-9}', fragment)
    const result = await yDocToMarkdown(doc)

    // #then
    expect(result).not.toBeNull()
    expect(result!.trim()).toBe('- [x] Ship it {task:t-9}')
  })

  it('preserves a task with an indented subtask through the full round-trip', async () => {
    // #given
    const md = '- [ ] Parent {task:p1}\n  - [x] Child {task:c1}'
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)

    // #when
    await markdownToYFragment(md, fragment)
    const result = await yDocToMarkdown(doc)

    // #then
    expect(result).not.toBeNull()
    expect(result).toContain('- [ ] Parent {task:p1}')
    expect(result).toContain('  - [x] Child {task:c1}')
  })

  it('preserves nested paragraph indentation through markdown writeback', async () => {
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    const ok = blocksToYFragment(
      [
        {
          id: 'parent',
          type: 'paragraph',
          props: { backgroundColor: 'default', textColor: 'default', textAlignment: 'left' },
          content: [{ type: 'text', text: 'Parent', styles: {} }],
          children: [
            {
              id: 'child',
              type: 'paragraph',
              props: { backgroundColor: 'default', textColor: 'default', textAlignment: 'left' },
              content: [{ type: 'text', text: 'Child', styles: {} }],
              children: []
            }
          ]
        }
      ] as never,
      fragment
    )

    expect(ok).toBe(true)
    const markdown = await yDocToMarkdown(doc)
    expect(markdown).toContain('<!-- memry:block-nesting-level=1 -->')

    const blocks = await markdownToBlocks(markdown!)
    expect(blocks).toEqual([
      expect.objectContaining({
        content: [{ type: 'text', text: 'Parent', styles: {} }],
        children: [
          expect.objectContaining({
            content: [{ type: 'text', text: 'Child', styles: {} }],
            children: []
          })
        ]
      })
    ])
  })
})
