import { describe, expect, it } from 'vitest'
import {
  markdownToBlocks,
  yDocToMarkdown,
  blocksToYFragment,
  markdownToYFragment,
  yFragmentToBlocks,
  repairEmptyBlockIds,
  findUnrepresentableNodes
} from './blocknote-converter'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { serializeLinkMentionToken } from '@memry/editor-schema'
import { serializeDateMentionToken } from '@memry/shared/date-mention'

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
    const ok = await markdownToYFragment(markdown, fragment)
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

  it('does not accumulate blank lines around inline task list items on reopen', async () => {
    // Reproduces the inline-task bug: a task checklist followed by a gap and more
    // content. Each markdown → Yjs → markdown round-trip models one note reopen;
    // it must be a fixed point, otherwise a blank line grows above the tasks every
    // time the note is opened.
    const roundTrip = async (md: string): Promise<string> => {
      const doc = new Y.Doc()
      const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
      const { markdownToYFragment } = await import('./blocknote-converter')
      await markdownToYFragment(md, fragment)
      return (await yDocToMarkdown(doc)) ?? ''
    }

    const original =
      '- [ ] Buy milk {task:t1}\n- [ ] Call mom {task:t2}\n- [ ] Ship the PR {task:t3}\n\n\n\nWrap-up notes'

    const once = await roundTrip(original)
    const twice = await roundTrip(once)

    expect(twice).toBe(once)
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
    const ok = await markdownToYFragment('one\n\n\n\n\ntwo', fragment)

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

describe('blocknote-converter list fidelity', () => {
  const roundTrip = async (md: string): Promise<string | null> => {
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    await markdownToYFragment(md, fragment)
    return yDocToMarkdown(doc)
  }

  it('keeps `-` bullets and a tight list on round-trip (no `*`, no blank lines)', async () => {
    // #given a plain Obsidian-style bullet list
    const md = '- kaan\n- sevde\n- karaca\n'

    // #when it round-trips through the editor serializer
    const out = await roundTrip(md)

    // #then markers stay `-` and items stay adjacent
    expect(out).toBe('- kaan\n- sevde\n- karaca')
  })

  it('keeps a real paragraph gap between a list and following text', async () => {
    // #given a list, a blank line, then a paragraph
    const md = '- one\n- two\n\nAfter.'

    // #when
    const out = await roundTrip(md)

    // #then the intentional gap survives; only intra-list looseness is tightened
    expect(out).toBe('- one\n- two\n\nAfter.')
  })

  it('preserves numbered lists', async () => {
    const out = await roundTrip('1. first\n2. second\n')
    expect(out).toBe('1. first\n2. second')
  })
})

describe('blocknote-converter color fidelity', () => {
  const roundTrip = async (md: string): Promise<string | null> => {
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    await markdownToYFragment(md, fragment)
    return yDocToMarkdown(doc)
  }

  const blocksToMd = async (blocks: NonNullable<Awaited<ReturnType<typeof markdownToBlocks>>>) => {
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    blocksToYFragment(blocks, fragment)
    return yDocToMarkdown(doc)
  }

  it('round-trips a heading with a block-level color marker', async () => {
    // #given the drag-handle side-menu color path (block props)
    const md = '<!-- colors:{"textColor":"red"} -->\n### Hello'

    // #when
    const blocks = await markdownToBlocks(md)
    expect(blocks![0]).toMatchObject({
      type: 'heading',
      props: { level: 3, textColor: 'red' }
    })
    const out = await blocksToMd(blocks!)

    // #then
    expect(out).toBe(md)
  })

  it('serializes inline textColor styles on a heading as a span', async () => {
    // #given the formatting-toolbar color path (inline styles)
    const blocks = [
      {
        type: 'heading',
        props: { level: 3 },
        content: [
          { type: 'text', text: 'He', styles: {} },
          { type: 'text', text: 'llo', styles: { textColor: 'red' } },
          { type: 'text', text: ' world', styles: {} }
        ],
        children: []
      }
    ] as unknown as NonNullable<Awaited<ReturnType<typeof markdownToBlocks>>>

    // #when
    const out = await blocksToMd(blocks)

    // #then
    expect(out).toBe('### He<span style="color:red">llo</span> world')
  })

  it('parses inline color spans back into styles', async () => {
    // #given
    const md = '### He<span style="color:red">llo</span> world'

    // #when
    const blocks = await markdownToBlocks(md)

    // #then
    expect(blocks![0].type).toBe('heading')
    expect(blocks![0].content).toEqual([
      expect.objectContaining({ text: 'He', styles: {} }),
      expect.objectContaining({ text: 'llo', styles: { textColor: 'red' } }),
      expect.objectContaining({ text: ' world', styles: {} })
    ])
  })

  it('round-trips inline colors combined with bold and background color', async () => {
    // #given
    const md = 'a <span style="color:blue;background-color:yellow">**bold** plain</span> tail'

    // #when
    const out = await roundTrip(md)

    // #then
    expect(out).toBe(md)
  })

  it('round-trips inline color combined with italic despite intraword flanking', async () => {
    // #given an italic run wrapped in a color span (token punctuation must keep
    // the `*` delimiters left/right-flanking)
    const md = 'a <span style="color:red">*em*</span> tail'

    // #when
    const out = await roundTrip(md)

    // #then
    expect(out).toBe(md)
  })

  it('leaves literal span text inside code fences untouched', async () => {
    // #given
    const md = '```html\n<span style="color:red">code</span>\n```'

    // #when
    const out = await roundTrip(md)

    // #then
    expect(out).toContain('<span style="color:red">code</span>')
    expect(out).toContain('```html')
  })

  it('round-trips inline color on repeated saves without growing markup', async () => {
    // #given
    const md = 'He<span style="color:red">llo</span> world'

    // #when — two consecutive round-trips (open, save, reopen, save)
    const once = await roundTrip(md)
    const twice = await roundTrip(once!)

    // #then
    expect(once).toBe(md)
    expect(twice).toBe(md)
  })
})

describe('blocknote-converter soft-break fidelity', () => {
  it('round-trips single-newline lines without adding blank lines or backslashes', async () => {
    // #given an Obsidian-style paragraph of soft-broken lines (single \n)
    const md = 'kaan\nuraz\nsevde'

    // #when it round-trips markdown → Yjs → markdown
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    await markdownToYFragment(md, fragment)
    const out = await yDocToMarkdown(doc)

    // #then it stays a single soft-broken paragraph (no `\n\n`, no `\`)
    expect(out).toBe('kaan\nuraz\nsevde')
  })
})

describe('inline underline persistence through the real markdown pipeline', () => {
  const toMarkdown = async (blocks: unknown[]): Promise<string | null> => {
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    blocksToYFragment(blocks as never, fragment)
    return yDocToMarkdown(doc)
  }

  const paragraph = (content: unknown[]): unknown => ({
    id: 'p1',
    type: 'paragraph',
    props: { textColor: 'default', backgroundColor: 'default', textAlignment: 'left' },
    children: [],
    content
  })

  it('never emits colour and underline on one span (old clients reject the whole span)', async () => {
    // #given a run that is both coloured and underlined
    const blocks = [
      paragraph([{ type: 'text', text: 'both', styles: { textColor: 'red', underline: true } }])
    ]

    // #when
    const md = await toMarkdown(blocks)

    // #then the two styles live on separate nested spans, so an older client that
    // rejects the underline span still keeps the colour it already understands
    expect(md).not.toMatch(/<span style="[^"]*color[^"]*text-decoration/)
    expect(md).not.toMatch(/<span style="[^"]*text-decoration[^"]*color/)
    expect(md).toContain('<span style="color:red">')
    expect(md).toContain('<span style="text-decoration:underline">')
  })

  it('does not inject span html into a code block', async () => {
    // #given underline set inside a code block (Cmd+U works there — the schema allows the mark)
    const blocks = [
      {
        id: 'c1',
        type: 'codeBlock',
        props: { language: 'javascript' },
        children: [],
        content: [{ type: 'text', text: 'const a = 1', styles: { underline: true } }]
      }
    ]

    // #when
    const md = await toMarkdown(blocks)

    // #then the fence stays literal code — the parse side skips fences, so any
    // span written here could never be unmasked again
    expect(md).not.toContain('<span')
    expect(md).toContain('const a = 1')
  })

  it('round-trips an underlined table cell without leaking mask tokens', async () => {
    // #given a table whose cell carries an underline span (the format the docs advertise)
    const original =
      '| a | b |\n| --- | --- |\n| <span style="text-decoration:underline">u</span> | plain |'

    // #when parsed and written back out
    const blocks = await markdownToBlocks(original)
    expect(blocks).not.toBeNull()
    const md = await toMarkdown(blocks!)

    // #then no internal masking token reaches the vault file
    expect(md).not.toContain('MEMRYICO')
    expect(md).not.toContain('MEMRYICC')
  })
})

describe('blocknote-converter export path never mutates the live doc', () => {
  it('never mutates the live doc, even for a node type the schema does not know', async () => {
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    // A block containing an inline node the server schema cannot build.
    const block = new Y.XmlElement('blockContainer')
    block.setAttribute('id', 'b1')
    const para = new Y.XmlElement('paragraph')
    // Deliberately a name no build knows. `wikiLink` used to stand in here, but
    // this schema now registers it — the guard has to be aimed at a node type
    // that is genuinely unconstructible, e.g. one a future build introduces.
    const unknown = new Y.XmlElement('someUnknownFutureNode')
    unknown.setAttribute('target', 'Roadmap')
    para.insert(0, [unknown])
    block.insert(0, [para])
    fragment.insert(0, [block])

    const before = Y.encodeStateAsUpdate(doc)
    await yDocToMarkdown(doc)

    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })
})

describe('findUnrepresentableNodes', () => {
  function seedUnknownInlineNode(nodeName: string): Y.Doc {
    const doc = new Y.Doc()
    const block = new Y.XmlElement('blockContainer')
    block.setAttribute('id', 'b1')
    const para = new Y.XmlElement('paragraph')
    const unknown = new Y.XmlElement(nodeName)
    unknown.setAttribute('target', 'Roadmap')
    para.insert(0, [unknown])
    block.insert(0, [para])
    doc.getXmlFragment(CRDT_FRAGMENT_NAME).insert(0, [block])
    return doc
  }

  it('names the inline node type the server schema cannot build', () => {
    // #given a doc holding an inline node no build in this app can construct —
    // a note written by a newer version, say. (This case used `wikiLink` while
    // the main schema lacked it; that spec is now registered, so the coverage
    // moves to a name that is still genuinely unknown.)
    const doc = seedUnknownInlineNode('someUnknownFutureNode')

    // #when
    const unknown = findUnrepresentableNodes(doc)

    // #then
    expect(unknown).toEqual(['someUnknownFutureNode'])
  })

  it('reports nothing for content this build can serialize, tables included', async () => {
    // #given the node names a real vault note produces — tables expand into
    // tableRow/tableCell/tableHeader/tableParagraph, none of which are block
    // types, so a hand-written "known types" list would flag them
    const doc = new Y.Doc()
    const ok = await markdownToYFragment(
      '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n> quote\n\n- [ ] a task {task:t1}\n\n```ts\nconst x = 1\n```\n',
      doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    )
    expect(ok).toBe(true)

    // #when
    const unknown = findUnrepresentableNodes(doc)

    // #then
    expect(unknown).toEqual([])
  })

  it('reads without mutating the doc', () => {
    // #given
    const doc = seedUnknownInlineNode('someUnknownFutureNode')
    const before = Y.encodeStateAsUpdate(doc)

    // #when
    findUnrepresentableNodes(doc)

    // #then
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })

  it('reports an empty doc as representable', () => {
    // #given a note that has never been edited
    const doc = new Y.Doc()

    // #when / #then
    expect(findUnrepresentableNodes(doc)).toEqual([])
  })

  it('reports nothing for every custom node type the renderer can author', async () => {
    // #given the doc a synced note actually holds: a taskBlock plus all four
    // custom inline nodes. Every one of these was a delete-on-open before the
    // main schema was built from the shared factory.
    const doc = new Y.Doc()
    const ok = await markdownToYFragment(
      '- [ ] a task {task:t1}\n',
      doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    )
    expect(ok).toBe(true)
    const blockGroup = doc.getXmlFragment(CRDT_FRAGMENT_NAME).get(0) as Y.XmlElement
    blockGroup.push([customInlineBlockContainer()])

    // #when
    const unknown = findUnrepresentableNodes(doc)

    // #then
    expect(unknown).toEqual([])
  })
})

/**
 * One `blockContainer` whose paragraph holds every custom inline node type,
 * seeded the way the renderer seeds them: straight into the shared Y.Doc.
 */
function customInlineBlockContainer(): Y.XmlElement {
  const block = new Y.XmlElement('blockContainer')
  block.setAttribute('id', 'inline-b1')
  const para = new Y.XmlElement('paragraph')
  para.insert(
    0,
    INLINE_CASES.map(({ nodeName, attrs }) => {
      const node = new Y.XmlElement(nodeName)
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
      return node
    })
  )
  block.insert(0, [para])
  return block
}

/**
 * Every custom inline node type, with the markdown form it must serialize to.
 * A new inline spec with no case here fails this table rather than being
 * silently untested — the whole class of bug was one spec nobody covered.
 */
const INLINE_CASES = [
  {
    nodeName: 'wikiLink',
    attrs: { target: 'Roadmap', alias: 'the plan' },
    text: '[[Roadmap|the plan]]'
  },
  { nodeName: 'hashTag', attrs: { tag: 'roadmap' }, text: '#roadmap' },
  {
    nodeName: 'linkMention',
    attrs: { url: 'https://example.com/a', domain: 'example.com' },
    text: serializeLinkMentionToken('https://example.com/a')
  },
  {
    nodeName: 'dateMention',
    // `hasTime` is left at its schema default so the seeded attributes stay
    // strings; a string "false" would be truthy and change the token.
    attrs: {
      anchorId: 'a1',
      dateISO: '2026-08-14',
      dateFormat: 'relative',
      remind: 'none',
      timeFormat: 'system'
    },
    text: serializeDateMentionToken({
      anchorId: 'a1',
      dateISO: '2026-08-14',
      hasTime: false,
      dateFormat: 'relative',
      remind: 'none',
      timeFormat: 'system'
    })
  }
] as const

describe('custom inline nodes survive the CRDT write path', () => {
  /**
   * `blockGroup > blockContainer > paragraph > [text, node, text]` — the shape
   * the renderer's editor actually writes into the shared fragment (verified
   * against `markdownToYFragment` output), so the node reaches the converter
   * exactly as a real synced note would deliver it.
   */
  function seedInlineNode(nodeName: string, attrs: Record<string, string>): Y.Doc {
    const doc = new Y.Doc()
    const group = new Y.XmlElement('blockGroup')
    const block = new Y.XmlElement('blockContainer')
    block.setAttribute('id', 'b1')
    const para = new Y.XmlElement('paragraph')
    const node = new Y.XmlElement(nodeName)
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
    para.insert(0, [new Y.XmlText('See '), node, new Y.XmlText(' tomorrow.')])
    block.insert(0, [para])
    group.insert(0, [block])
    doc.getXmlFragment(CRDT_FRAGMENT_NAME).insert(0, [group])
    return doc
  }

  it('round-trips a wiki link through the CRDT write path', async () => {
    // #given the doc the renderer produces for `[[Roadmap|the plan]]`
    const doc = seedInlineNode('wikiLink', { target: 'Roadmap', alias: 'the plan' })
    const before = Y.encodeStateAsUpdate(doc)

    // #when write-back serializes it
    const markdown = await yDocToMarkdown(doc)

    // #then the link reaches the vault file…
    expect(markdown).toContain('[[Roadmap|the plan]]')
    // …and the shared doc is untouched: y-prosemirror's answer to an unknown
    // node is to delete it, which replicates to every other device.
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
    expect(findUnrepresentableNodes(doc)).toEqual([])
  })

  it.each(INLINE_CASES)(
    '$nodeName serializes to its markdown form',
    async ({ nodeName, attrs, text }) => {
      // #given
      const doc = seedInlineNode(nodeName, { ...attrs })
      const before = Y.encodeStateAsUpdate(doc)

      // #when
      const markdown = await yDocToMarkdown(doc)

      // #then
      expect(markdown).toContain(text)
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
    }
  )
})

describe('registering the custom specs does not rewrite existing markdown', () => {
  // Write-back byte-compares before writing, so any serialization drift here
  // rewrites every affected note in every vault on next open. The block-level
  // cases are the sharp ones: a spec whose `parse` matches an element by its
  // text content claims the whole `<li>` / `<blockquote>` / `<td>`, and the
  // block around the link is what gets lost.
  it.each([
    'See [[Roadmap|the plan]] tomorrow.',
    '[[Roadmap]]',
    '# Heading\n\n[[A]] and #tag and ((mention:https%3A%2F%2Fx.com)) inline.',
    '- [[A]]\n- [[B]]',
    '> [[Quoted]]',
    '- [ ] a task {task:t1}',
    '```ts\nconst x = "[[Roadmap]]"\n```',
    '((date:eyJhbmNob3JJZCI6ImExIn0)) leftover token.'
  ])('round-trips %j unchanged', async (markdown) => {
    // #given a vault note as it exists on disk today
    const doc = new Y.Doc()
    const ok = await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))
    expect(ok).toBe(true)

    // #when write-back serializes it again
    // #then the bytes are the same, so nothing is written
    expect(await yDocToMarkdown(doc)).toBe(markdown)
  })
})

describe('custom inline content inside a table', () => {
  // BlockNote serializes inline content inside a table through the spec's
  // `render`, NOT `toExternalHTML`. Every other block type takes the
  // `toExternalHTML` path, so a server spec can look correct everywhere and
  // still corrupt tables. Both failure modes below were real:
  //   - a throwing render made yDocToMarkdown return null, so the whole note
  //     silently stopped writing back
  //   - the editor's rich linkMention render emitted `<a href>`, rewriting the
  //     `((mention:…))` token as a plain markdown link and dropping the
  //     domain/title/favicon/siteName from disk permanently
  const cellProps = {
    colspan: 1,
    rowspan: 1,
    backgroundColor: 'default',
    textColor: 'default',
    textAlignment: 'left'
  }

  async function tableMarkdown(cellContent: unknown[]): Promise<string | null> {
    const doc = new Y.Doc()
    blocksToYFragment(
      [
        {
          id: 'tbl',
          type: 'table',
          props: {},
          children: [],
          content: {
            type: 'tableContent',
            columnWidths: [null, null],
            rows: [
              {
                cells: [
                  { type: 'tableCell', content: cellContent, props: cellProps },
                  {
                    type: 'tableCell',
                    content: [{ type: 'text', text: 'x', styles: {} }],
                    props: cellProps
                  }
                ]
              }
            ]
          }
        }
      ] as unknown as Parameters<typeof blocksToYFragment>[0],
      doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    )
    return await yDocToMarkdown(doc)
  }

  it.each([
    ['wikiLink', [{ type: 'wikiLink', props: { target: 'Roadmap', alias: '' } }], '[[Roadmap]]'],
    [
      'wikiLink with an alias',
      [{ type: 'wikiLink', props: { target: 'Roadmap', alias: 'the plan' } }],
      '[[Roadmap|the plan]]'
    ],
    ['hashTag', [{ type: 'hashTag', props: { tag: 'work', color: '', icon: '' } }], '#work'],
    [
      'linkMention',
      [
        {
          type: 'linkMention',
          props: {
            url: 'https://x.com/y',
            domain: 'x.com',
            title: 'T',
            favicon: 'f',
            siteName: 'S'
          }
        }
      ],
      serializeLinkMentionToken('https://x.com/y')
    ]
  ])('%s keeps its on-disk form in a table cell', async (_name, content, expected) => {
    // #when
    const markdown = await tableMarkdown(content)

    // #then the conversion succeeds at all (a throwing render returns null)...
    expect(markdown).not.toBeNull()
    // ...and the cell holds the textual form, not the editor's rich markup
    expect(markdown).toContain(expected)
  })

  it('a date mention keeps its token in a table cell', async () => {
    // #given
    const props = {
      anchorId: 'a1',
      dateISO: '2026-08-14T09:00:00.000Z',
      hasTime: true,
      dateFormat: 'relative' as const,
      remind: 'none' as const,
      timeFormat: 'system' as const
    }

    // #when
    const markdown = await tableMarkdown([{ type: 'dateMention', props }])

    // #then
    expect(markdown).not.toBeNull()
    expect(markdown).toContain(serializeDateMentionToken(props))
  })
})
