import { describe, expect, it } from 'vitest'
import {
  markdownToBlocks,
  yDocToMarkdown,
  blocksToYFragment,
  markdownToYFragment,
  yFragmentToBlocks,
  repairEmptyBlockIds
} from './blocknote-converter'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { collectTaskLinks, type TaskCandidate } from '@memry/shared/task-block'

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
    const { ok } = await markdownToYFragment(markdown, fragment)
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
    // The single extra blank line is preserved exactly, not grown. Before the
    // serializer trimmed the trailing newline blocksToMarkdownLossy appends, this
    // round-trip emitted 'Alpha\n\n\n\nBeta' — one extra blank line per save (the
    // inline-task "new line above the task on reopen" bug).
    expect(result).toBe('Alpha\n\n\nBeta')
  })

  it('keeps an image glued to the previous line as an image block', async () => {
    // #given — imported notes (Apple Notes/Bear/…) emit an image on the line
    // directly after text with no blank line between. Without separation that
    // image folds into the paragraph as an inline image and BlockNote drops it.
    const url = 'memry-file://local/v/attachments/n/abc-Screen-Shot.png'
    const markdown = `Cluster Proxy. \n![Screen Shot.png](${url})\n\nafter`
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)

    // #when
    const { ok } = await markdownToYFragment(markdown, fragment)
    const blocks = await yFragmentToBlocks(fragment)

    // #then — the image survives as a real image block with the right url
    expect(ok).toBe(true)
    const image = blocks!.find((b) => b.type === 'image')
    expect(image).toBeDefined()
    expect((image!.props as { url: string }).url).toBe(url)
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
    const { ok } = await markdownToYFragment(markdown, fragment)
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
    const { ok } = await markdownToYFragment(markdown, fragment)
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
    const { ok } = await markdownToYFragment(markdown, fragment)
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
    const { ok } = await markdownToYFragment('- [ ] Buy milk {task:abc-123}', fragment)
    const blocks = await yFragmentToBlocks(fragment)

    // #then
    expect(ok).toBe(true)
    expect(blocks).not.toBeNull()
    const task = blocks!.find((b) => b.type === 'taskBlock')
    expect(task).toBeTruthy()
    expect(task!.props).toMatchObject({ taskId: 'abc-123', title: 'Buy milk', checked: false })
    expect(blocks!.some((b) => b.type === 'checkListItem')).toBe(false)
  })

  it('serializes a legacy {task:} line back as a plain checkbox (suffix stripped)', async () => {
    // #given
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)

    // #when
    const { bindings } = await markdownToYFragment('- [x] Ship it {task:t-9}', fragment)
    const result = await yDocToMarkdown(doc)

    // #then — the id lives in the block props (and note_task_links), not the file
    expect(result).not.toBeNull()
    expect(result!.trim()).toBe('- [x] Ship it')
    expect(bindings).toEqual([
      expect.objectContaining({ taskId: 't-9', title: 'Ship it', checked: true, rule: 'legacy' })
    ])
  })

  it('binds plain task lines against candidates and emits them unchanged', async () => {
    // #given — a cold seed: clean file plus note_task_links candidates
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)

    // #when
    const { bindings, orphans } = await markdownToYFragment('- [ ] Buy milk', fragment, [
      { taskId: 't1', title: 'Buy milk', checked: false, anchor: null },
      { taskId: 'gone', title: 'Deleted line', checked: false, anchor: null }
    ])
    const blocks = await yFragmentToBlocks(fragment)
    const result = await yDocToMarkdown(doc)

    // #then
    const task = blocks!.find((b) => b.type === 'taskBlock')
    expect(task!.props).toMatchObject({ taskId: 't1', title: 'Buy milk' })
    expect(result!.trim()).toBe('- [ ] Buy milk')
    expect(bindings).toEqual([expect.objectContaining({ taskId: 't1', rule: 'title' })])
    expect(orphans).toEqual([expect.objectContaining({ taskId: 'gone' })])
  })

  it('emits an anchored task line when the anchor prop is set', async () => {
    // #given
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)

    // #when — anchor binds first and survives the round-trip
    await markdownToYFragment('- [ ] Buy milk ^k3f9q2', fragment, [
      { taskId: 't1', title: 'Old title', checked: false, anchor: 'k3f9q2' }
    ])
    const result = await yDocToMarkdown(doc)

    // #then
    expect(result!.trim()).toBe('- [ ] Buy milk ^k3f9q2')
  })

  it('preserves a task with an indented subtask through the full round-trip', async () => {
    // #given
    const md = '- [ ] Parent {task:p1}\n  - [x] Child {task:c1}'
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)

    // #when
    await markdownToYFragment(md, fragment)
    const result = await yDocToMarkdown(doc)

    // #then — plain lines out; ids stay in props
    expect(result).not.toBeNull()
    expect(result).toContain('- [ ] Parent')
    expect(result).toContain('  - [x] Child')
    expect(result).not.toContain('{task:')
  })

  it('does not accumulate blank lines around inline task list items on reopen', async () => {
    // Reproduces the inline-task bug: a task checklist followed by a gap and more
    // content. Each markdown → Yjs → markdown round-trip models one note reopen —
    // seeded with the note_task_links candidates the previous writeback snapshotted
    // (spec 02) — and must be a fixed point, otherwise a blank line grows above
    // the tasks every time the note is opened.
    const roundTrip = async (
      md: string,
      candidates: TaskCandidate[] = []
    ): Promise<{ md: string; candidates: TaskCandidate[] }> => {
      const doc = new Y.Doc()
      const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
      await markdownToYFragment(md, fragment, candidates)
      const blocks = await yFragmentToBlocks(fragment)
      return {
        md: (await yDocToMarkdown(doc)) ?? '',
        candidates: blocks ? collectTaskLinks(blocks) : []
      }
    }

    const original =
      '- [ ] Buy milk {task:t1}\n- [ ] Call mom {task:t2}\n- [ ] Ship the PR {task:t3}\n\n\n\nWrap-up notes'

    const once = await roundTrip(original)
    const twice = await roundTrip(once.md, once.candidates)

    expect(twice.md).toBe(once.md)
    expect(twice.md).not.toContain('{task:')
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

describe('blocknote-converter block id integrity', () => {
  const collectContainerIds = (fragment: Y.XmlFragment): (string | null)[] => {
    const ids: (string | null)[] = []
    const visit = (node: Y.XmlFragment | Y.XmlElement): void => {
      for (const child of node.toArray()) {
        const el = child as Y.XmlElement
        if (typeof el.nodeName !== 'string') continue
        if (el.nodeName === 'blockContainer') ids.push(el.getAttribute('id') ?? null)
        visit(el)
      }
    }
    visit(fragment)
    return ids
  }

  it('never writes an empty block id for multi-blank-line gaps', async () => {
    // #given markdown whose extra blank lines mint gap paragraphs
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)

    // #when
    const { ok } = await markdownToYFragment('one\n\n\n\n\ntwo', fragment)

    // #then every block container carries a real id (no '' or null)
    expect(ok).toBe(true)
    const ids = collectContainerIds(fragment)
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) expect(id).toBeTruthy()
  })

  it('regenerates a falsy block id passed to blocksToYFragment', () => {
    // #given a block handed in with an empty-string id
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)

    // #when
    const ok = blocksToYFragment(
      [{ id: '', type: 'paragraph', props: {}, content: [], children: [] } as unknown as never],
      fragment
    )

    // #then the persisted container id is a real value, not ''
    expect(ok).toBe(true)
    const ids = collectContainerIds(fragment)
    expect(ids).toHaveLength(1)
    expect(ids[0]).toBeTruthy()
  })

  it('repairEmptyBlockIds stamps ids on containers missing one', () => {
    // #given a fragment holding a block container with an empty id
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    const container = new Y.XmlElement('blockContainer')
    container.setAttribute('id', '')
    container.insert(0, [new Y.XmlElement('paragraph')])
    fragment.insert(0, [container])
    expect(container.getAttribute('id')).toBe('')

    // #when
    const repaired = repairEmptyBlockIds(fragment)

    // #then
    expect(repaired).toBe(1)
    expect(container.getAttribute('id')).toBeTruthy()
  })

  it('leaves already-valid block ids untouched', () => {
    // #given a fragment whose container already has an id
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    const container = new Y.XmlElement('blockContainer')
    container.setAttribute('id', 'keep-me')
    fragment.insert(0, [container])

    // #when
    const repaired = repairEmptyBlockIds(fragment)

    // #then
    expect(repaired).toBe(0)
    expect(container.getAttribute('id')).toBe('keep-me')
  })
})
