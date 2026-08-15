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
import { ServerBlockNoteEditor } from '@blocknote/server-util'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import {
  createMemrySchema,
  serializeLinkMentionToken,
  MEMRY_INLINE_CONTENT_TYPES
} from '@memry/editor-schema'
import {
  MEMRY_BLOCK_TYPES,
  serializeBookmark,
  serializeCalloutBlock,
  serializeYoutubeEmbed
} from '@memry/editor-schema/blocks'
import {
  BlockNoteSchema,
  createInlineContentSpec,
  defaultBlockSpecs,
  defaultInlineContentSpecs
} from '@blocknote/core'
import { createWikiLinkInlineContent, wikiLinkToText } from '@memry/editor-schema/inline'
import { createServerBlockSpecs, createServerInlineSpecs } from '@memry/editor-schema/server'
import { serializeDateMentionToken } from '@memry/shared/date-mention'
import { fileBlockCommentData, parseFileBlockMarker } from '@memry/editor-schema/blocks'

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
    // `yFragmentToBlocks` is typed against BlockNote's default block union, which
    // has no `taskBlock` — the custom specs only exist at runtime here.
    const task = (blocks as unknown as Array<{ type: string; props: unknown }>).find(
      (b) => b.type === 'taskBlock'
    )
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
 * The hole `findUnrepresentableNodes` does NOT cover, and what closed it (#1455).
 *
 * The guard asks whether this build can CONSTRUCT a node name, because that is
 * the question y-prosemirror's delete depends on. It is not the question "will
 * this node survive serialization", and the difference is a whole class of
 * silent loss: a spec registered under a key that is not its `config.type`
 * builds fine (the node name comes from `config.type`) and serializes to
 * nothing (BlockNote resolves nodes against a schema keyed by the REGISTRATION
 * key). Every guard reads green while the text leaves the vault file.
 *
 * The first test measures that, with the mis-keyed schema built the only way it
 * still can be — `BlockNoteSchema.create` directly. The second shows the door it
 * came through is shut: `createMemrySchema` refuses the same divergence.
 */
describe('a spec registered under a key that is not its config.type', () => {
  /** `See [[Wiki Link]] for details.` as the renderer puts it in the shared doc. */
  function wikiLinkDoc(): Y.Doc {
    const doc = new Y.Doc()
    const ok = blocksToYFragment(
      [
        {
          id: 'p1',
          type: 'paragraph',
          props: {},
          children: [],
          content: [
            { type: 'text', text: 'See ', styles: {} },
            { type: 'wikiLink', props: { target: 'Wiki Link', alias: '' } },
            { type: 'text', text: ' for details.', styles: {} }
          ]
        }
      ] as unknown as Parameters<typeof blocksToYFragment>[0],
      doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    )
    expect(ok).toBe(true)
    return doc
  }

  it('drops the node while every constructibility check stays green', async () => {
    // #given the shipped schema writes the note, and reads it back whole
    const doc = wikiLinkDoc()
    expect(await yDocToMarkdown(doc)).toBe('See [[Wiki Link]] for details.')
    expect(findUnrepresentableNodes(doc)).toEqual([])

    // #given a schema whose wikiLink spec sits under the wrong key. Built
    // through `BlockNoteSchema.create` because `createMemrySchema` no longer
    // permits it — this is the shape that shipped-adjacent code could have had.
    const inline = createServerInlineSpecs()
    const misKeyed = ServerBlockNoteEditor.create({
      schema: BlockNoteSchema.create({
        blockSpecs: { ...defaultBlockSpecs, ...createServerBlockSpecs() },
        inlineContentSpecs: {
          ...defaultInlineContentSpecs,
          wikiLinkRenamed: inline.wikiLink,
          linkMention: inline.linkMention,
          hashTag: inline.hashTag,
          dateMention: inline.dateMention
        }
      })
      // Through `unknown`: with `wikiLink` gone from the inline map the schema
      // no longer overlaps the default-parameterised `ServerBlockNoteEditor` at
      // all, which is the type system noticing the same divergence this test is
      // about. Only the runtime behaviour is under test here.
    }) as unknown as ServerBlockNoteEditor

    // #then the node name ProseMirror knows is `config.type`, NOT the key — so
    // y-prosemirror builds the element instead of deleting it, and a
    // constructibility scan of this schema reports nothing wrong
    const pmNodes = misKeyed.editor.pmSchema.nodes
    expect('wikiLink' in pmNodes).toBe(true)
    expect('wikiLinkRenamed' in pmNodes).toBe(false)

    // …while BlockNote's own map is keyed by the registration key, so it cannot
    // resolve the node it just built
    expect(Object.keys(misKeyed.editor.schema.inlineContentSchema)).toContain('wikiLinkRenamed')
    expect(Object.keys(misKeyed.editor.schema.inlineContentSchema)).not.toContain('wikiLink')

    // #when the note is written back through that schema. `trimEnd` only
    // removes the serializer's trailing newline, which `yDocToMarkdown`
    // normalizes away before the vault file is written.
    const blocks = misKeyed.yXmlFragmentToBlocks(doc.getXmlFragment(CRDT_FRAGMENT_NAME))
    const written = (await misKeyed.blocksToMarkdownLossy(blocks)).trimEnd()

    // #then the link is gone from the bytes — 30 down to 16. BlockNote logs
    // `unrecognized inline content type wikiLink` on the way past (visible in
    // this run's stderr) and returns normally, so nothing rejects the write and
    // the guard has nothing to refuse.
    expect(written).toBe('See for details.')
    expect('See [[Wiki Link]] for details.'.length).toBe(30)
    expect(written.length).toBe(16)
  })

  it('cannot be built through createMemrySchema', () => {
    // #given the same divergence, in the one map a caller still supplies
    // free-form: `createMemrySchema` takes block specs as they come, so the
    // renderer's React blocks reach no factory that could key them. The cast is
    // what the mistake now costs — the parameter's mapped type makes a mis-keyed
    // entry `never`, so this does not compile without one.
    const blocks = createServerBlockSpecs()
    const misKeyed = {
      ...blocks,
      bookmarkRenamed: blocks.bookmark
    } as unknown as ReturnType<typeof createServerBlockSpecs>

    // #when / #then the schema build throws, naming the slot and the node name,
    // so no editor exists to reach `yDocToMarkdown` with
    expect(() =>
      createMemrySchema({ blocks: misKeyed, inline: createServerInlineSpecs() })
    ).toThrowError(/blockSpecs\["bookmarkRenamed"\].*config\.type is "bookmark"/s)
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

/**
 * #1439: `**[[A]]**` lost its bold the moment the note was opened.
 *
 * The renderer promotes the styled run into a `wikiLink` node, and BlockNote's
 * data model gives custom inline content no `styles` field — so the marks now
 * ride in the node's PROPS and are re-emitted from `toExternalHTML`. These
 * assert the exact bytes, because write-back byte-compares: a single character
 * of drift here rewrites every note with a wiki link in every vault.
 */
describe('a wiki link carries its marks to disk', () => {
  /** A doc holding one paragraph whose only content is the wiki link. */
  async function markdownForProps(props: Record<string, unknown>): Promise<string | null> {
    const doc = new Y.Doc()
    blocksToYFragment(
      [
        {
          id: 'b1',
          type: 'paragraph',
          props: {},
          children: [],
          content: [{ type: 'wikiLink', props }]
        }
      ] as unknown as Parameters<typeof blocksToYFragment>[0],
      doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    )
    return await yDocToMarkdown(doc)
  }

  // THE byte-stability guard. Every wiki link already in every vault takes this
  // path; if it moves by one character, every one of those notes is rewritten
  // on next open. Asserted as an exact string, never `toContain`.
  it.each([
    [{ target: 'A', alias: '' }, '[[A]]'],
    [{ target: 'A', alias: 'b' }, '[[A|b]]'],
    // Marks explicitly at their schema defaults are the same as no marks.
    [
      {
        target: 'A',
        alias: '',
        bold: false,
        italic: false,
        underline: false,
        strike: false,
        code: false,
        textColor: 'default',
        backgroundColor: 'default'
      },
      '[[A]]'
    ]
  ])('an unmarked link serializes to exactly %j -> %j', async (props, expected) => {
    expect(await markdownForProps(props)).toBe(expected)
  })

  // The marked forms are byte-identical to what BlockNote emits for the marked
  // `[[A]]` TEXT run the link was promoted from — verified by the sibling test
  // below, which serializes both and compares.
  it.each([
    [{ bold: true }, '**[[A]]**'],
    [{ italic: true }, '*[[A]]*'],
    [{ strike: true }, '~~[[A]]~~'],
    [{ code: true }, '`[[A]]`'],
    [{ bold: true, italic: true }, '***[[A]]***'],
    [{ bold: true, italic: true, strike: true, code: true }, '***~~`[[A]]`~~***']
  ])('a link marked %j serializes to %j', async (marks, expected) => {
    expect(await markdownForProps({ target: 'A', alias: '', ...marks })).toBe(expected)
  })

  it('an aliased link keeps its marks', async () => {
    expect(await markdownForProps({ target: 'A', alias: 'b', bold: true })).toBe('**[[A|b]]**')
  })

  // The seam between the two processes. `createWikiLinkInlineContent` is the
  // shared factory the renderer's `normalizeWikiLinks` calls when it promotes a
  // styled run, so building the node through it here means a change to the
  // promotion's output shape fails on this side too.
  it.each([
    [{ bold: true }, '**[[A]]**'],
    [{ italic: true }, '*[[A]]*'],
    [{ bold: true, italic: true, strike: true, code: true }, '***~~`[[A]]`~~***'],
    [{}, '[[A]]']
  ])('serializes the node the renderer promotion builds for %j', async (styles, expected) => {
    // #given exactly what the renderer puts in the shared doc
    const promoted = createWikiLinkInlineContent('A', '', styles)

    // #then
    expect(await markdownForProps(promoted.props)).toBe(expected)
  })

  // The bar the whole fix is measured against: whatever BlockNote writes for a
  // marked text run is what the promoted link must write, or opening a note
  // rewrites it.
  it.each([
    [{ bold: true }],
    [{ italic: true }],
    [{ strike: true }],
    [{ code: true }],
    [{ bold: true, italic: true, strike: true, code: true }]
  ])('marked %j serializes the same as the marked text it was promoted from', async (marks) => {
    // #given the same paragraph twice: once as a styled text run, once as a
    // promoted wikiLink node carrying the same marks
    const textDoc = new Y.Doc()
    blocksToYFragment(
      [
        {
          id: 'b1',
          type: 'paragraph',
          props: {},
          children: [],
          content: [{ type: 'text', text: '[[A]]', styles: marks }]
        }
      ] as unknown as Parameters<typeof blocksToYFragment>[0],
      textDoc.getXmlFragment(CRDT_FRAGMENT_NAME)
    )

    // #then
    expect(await markdownForProps({ target: 'A', alias: '', ...marks })).toBe(
      await yDocToMarkdown(textDoc)
    )
  })

  // Colours and underline have no markdown syntax. A coloured TEXT run reaches
  // disk as `<span style="color:red">` via the token masking in
  // @memry/shared/inline-colors; a coloured link takes the same road.
  it.each([
    [{ textColor: 'red' }, '<span style="color:red">[[A]]</span>'],
    [{ backgroundColor: 'blue' }, '<span style="background-color:blue">[[A]]</span>'],
    [{ underline: true }, '<span style="text-decoration:underline">[[A]]</span>'],
    [{ textColor: 'red', bold: true }, '<span style="color:red">**[[A]]**</span>']
  ])('a link marked %j serializes to %j', async (marks, expected) => {
    expect(await markdownForProps({ target: 'A', alias: '', ...marks })).toBe(expected)
  })

  // BlockNote serializes inline content inside a TABLE through the spec's
  // `render`, not `toExternalHTML` — a marked link in a table cell would lose
  // its marks if only one of the two emitted them.
  it('keeps its marks inside a table cell', async () => {
    // #given
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
            columnWidths: [null],
            rows: [
              {
                cells: [
                  {
                    type: 'tableCell',
                    content: [{ type: 'wikiLink', props: { target: 'A', alias: '', bold: true } }],
                    props: {
                      colspan: 1,
                      rowspan: 1,
                      backgroundColor: 'default',
                      textColor: 'default',
                      textAlignment: 'left'
                    }
                  }
                ]
              }
            ]
          }
        }
      ] as unknown as Parameters<typeof blocksToYFragment>[0],
      doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    )

    // #when
    const markdown = await yDocToMarkdown(doc)

    // #then the conversion succeeds at all (a throwing render returns null)…
    expect(markdown).not.toBeNull()
    // …and the cell holds the marked form
    expect(markdown).toContain('**[[A]]**')
  })

  /**
   * The compat case, and the one that decides whether this may ship to a live
   * beta. A `wikiLink` written by a build that predates the mark props carries
   * `target`/`alias` and nothing else. ProseMirror's `computeAttrs` walks the
   * SCHEMA's attributes and fills a default for every key the element lacks, so
   * the node still builds and still serializes to the bytes it always did — no
   * migration, no rewrite.
   */
  it('a node persisted by an older build, with no mark props, still serializes', async () => {
    // #given the element shape an older build wrote: two attributes, no marks
    const doc = new Y.Doc()
    const group = new Y.XmlElement('blockGroup')
    const block = new Y.XmlElement('blockContainer')
    block.setAttribute('id', 'b1')
    const para = new Y.XmlElement('paragraph')
    const node = new Y.XmlElement('wikiLink')
    node.setAttribute('target', 'Roadmap')
    node.setAttribute('alias', 'the plan')
    para.insert(0, [new Y.XmlText('See '), node, new Y.XmlText(' tomorrow.')])
    block.insert(0, [para])
    group.insert(0, [block])
    doc.getXmlFragment(CRDT_FRAGMENT_NAME).insert(0, [group])
    const before = Y.encodeStateAsUpdate(doc)

    // #when
    const markdown = await yDocToMarkdown(doc)

    // #then it converts to exactly the bytes it did before the props existed…
    expect(markdown).toBe('See [[Roadmap|the plan]] tomorrow.')
    // …the schema can still build it (an unbuildable node is DELETED)…
    expect(findUnrepresentableNodes(doc)).toEqual([])
    // …and reading it did not touch the shared doc
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })

  // The other half of the same compat question: an old element read back as
  // BLOCKS carries the schema defaults, which is what makes it serialize
  // unchanged. Measured rather than reasoned about.
  it('an older build’s node reads back with the mark props at their defaults', async () => {
    // #given
    const doc = new Y.Doc()
    const group = new Y.XmlElement('blockGroup')
    const block = new Y.XmlElement('blockContainer')
    block.setAttribute('id', 'b1')
    const para = new Y.XmlElement('paragraph')
    const node = new Y.XmlElement('wikiLink')
    node.setAttribute('target', 'Old')
    para.insert(0, [node])
    block.insert(0, [para])
    group.insert(0, [block])
    doc.getXmlFragment(CRDT_FRAGMENT_NAME).insert(0, [group])

    // #when
    const blocks = await yFragmentToBlocks(doc.getXmlFragment(CRDT_FRAGMENT_NAME))

    // #then
    expect((blocks![0] as { content: unknown[] }).content).toEqual([
      {
        type: 'wikiLink',
        props: {
          target: 'Old',
          alias: '',
          bold: false,
          italic: false,
          underline: false,
          strike: false,
          code: false,
          textColor: 'default',
          backgroundColor: 'default'
        }
      }
    ])
  })

  /**
   * The downgrade direction, which is the half a live beta actually risks: a
   * released build that has never heard of the mark props meets a document a
   * NEWER build wrote with them.
   *
   * Run for real, not reasoned about — the `wikiLink` spec below is rebuilt with
   * the pre-#1439 two-attribute propSchema and put in a live server editor, so
   * the assertions below are ProseMirror actually executing the old schema
   * against the new bytes. `_computeAttrs` iterates the SCHEMA's attrs, so keys
   * it has never heard of are dropped; `_checkAttrs`, which does throw on an
   * unknown key, is not on the `NodeType.create` path y-prosemirror uses.
   */
  it('an older build reads a node carrying the new props without throwing or deleting it', async () => {
    // #given a document this build wrote: a marked wiki link, mark props and all
    const doc = new Y.Doc()
    blocksToYFragment(
      [
        {
          id: 'b1',
          type: 'paragraph',
          props: {},
          children: [],
          content: [
            {
              type: 'wikiLink',
              props: { target: 'Roadmap', alias: 'the plan', bold: true, textColor: 'red' }
            }
          ]
        }
      ] as unknown as Parameters<typeof blocksToYFragment>[0],
      doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    )
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    expect(fragment.toString()).toContain('bold="true"')
    const before = Y.encodeStateAsUpdate(doc)

    // #when the build that predates the props reads it. Same spec, same
    // implementation — only the propSchema is rolled back.
    const oldSpec = createInlineContentSpec(
      {
        type: 'wikiLink' as const,
        propSchema: { target: { default: '' }, alias: { default: '' } },
        content: 'none' as const
      },
      {
        render: (inlineContent) => {
          const dom = document.createElement('span')
          const props = inlineContent.props as unknown as { target: string; alias: string }
          dom.textContent = wikiLinkToText(props.target || '', props.alias || '')
          return { dom }
        }
      }
    )
    const oldEditor = ServerBlockNoteEditor.create({
      schema: createMemrySchema({
        blocks: createServerBlockSpecs(),
        inline: {
          ...createServerInlineSpecs(),
          // The whole point: a spec whose propSchema is two keys short.
          wikiLink: oldSpec as unknown as ReturnType<typeof createServerInlineSpecs>['wikiLink']
        }
      })
    }) as ServerBlockNoteEditor

    const blocks = oldEditor.yXmlFragmentToBlocks(fragment)

    // #then the node is THERE — an unbuildable node is deleted from the shared
    // doc by y-prosemirror, which replicates to every device — and it carries
    // exactly the two props the old schema knows about
    expect((blocks[0] as { content: unknown[] }).content).toEqual([
      { type: 'wikiLink', props: { target: 'Roadmap', alias: 'the plan' } }
    ])

    // …it serializes to the pre-#1439 bytes: the mark is forgotten, never
    // corrupted, which is exactly what that build did before this change…
    expect(await oldEditor.blocksToMarkdownLossy(blocks)).toContain('[[Roadmap|the plan]]')

    // …and reading it left the shared document byte-identical, so an old client
    // merely OPENING the note does not strip the marks for everyone else.
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })

  /**
   * `code` combined with any of bold/italic/strike is write-only, and has been
   * since long before this node existed: BlockNote's markdown PARSER drops the
   * emphasis off any run that also carries inline code — ``**`x`**`` parses to
   * `{ code: true }` for plain text, no wiki link involved. The serializer
   * above emits the combination faithfully; the read-back is what flattens it.
   * Asserted so the limitation is recorded rather than rediscovered.
   */
  it('code combined with emphasis is a pre-existing parser limitation, not ours', async () => {
    const blocks = await markdownToBlocks('**`x`**')
    expect((blocks![0] as { content: unknown[] }).content).toEqual([
      { type: 'text', text: 'x', styles: { code: true } }
    ])
  })
})

/**
 * The textual form each custom inline type takes on disk.
 *
 * Typed against `MEMRY_INLINE_CONTENT_TYPES`, so a new inline spec with no
 * entry here fails `typecheck` before it fails a test.
 */
const INLINE_TEXT_FORMS: Record<(typeof MEMRY_INLINE_CONTENT_TYPES)[number], string> = {
  wikiLink: '[[Roadmap]]',
  hashTag: '#roadmap',
  linkMention: '((mention:https%3A%2F%2Fx.com))',
  dateMention: '((date:eyJhbmNob3JJZCI6ImExIn0))'
}

/** The block shapes a marker's own text can be sitting inside of. */
const BLOCK_CONTEXTS: Array<[string, (form: string) => string]> = [
  ['a bullet item', (f) => `- ${f}`],
  ['a numbered item', (f) => `1. ${f}`],
  ['a quote', (f) => `> ${f}`],
  ['a heading', (f) => `# ${f}`],
  ['a checklist item', (f) => `- [ ] ${f}`],
  ['a code fence', (f) => ['```md', f, '```'].join('\n')],
  ['mid-sentence', (f) => `See ${f} today.`],
  ['a paragraph of its own', (f) => f]
]

describe('a custom spec must not claim the block its text sits in', () => {
  // This is the gate for `parse`, and it is the one class the name/propSchema
  // comparisons cannot see. A spec whose `parse` matches an element by its TEXT
  // rather than by its own markup claims the whole <li>/<blockquote>/<td>, and
  // the block around the marker is what gets lost. It has happened once already:
  // wikiLink's editor `parse` promotes any element whose whole text reads
  // `[[X]]` — a paste convenience — and sharing it into main's markdown importer
  // destroyed the surrounding block in 13 of 78 fixtures.
  //
  // Derived from MEMRY_INLINE_CONTENT_TYPES on purpose: a new spec cannot opt
  // out of this by simply not having a fixture written for it.
  it('declares a textual form for every custom inline type', () => {
    expect(Object.keys(INLINE_TEXT_FORMS).sort()).toEqual([...MEMRY_INLINE_CONTENT_TYPES].sort())
  })

  const cases = MEMRY_INLINE_CONTENT_TYPES.flatMap((type) =>
    BLOCK_CONTEXTS.map(([context, wrap]) => [type, context, wrap(INLINE_TEXT_FORMS[type])] as const)
  )

  it.each(cases)('%s inside %s survives untouched', async (_type, _context, markdown) => {
    // #given a vault note as it exists on disk today
    const doc = new Y.Doc()
    const ok = await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))
    expect(ok).toBe(true)

    // #when the converter reads and writes it back
    // #then byte-identical — write-back byte-compares, so anything else rewrites
    // the note in every vault on next open
    expect(await yDocToMarkdown(doc)).toBe(markdown)
  })

  it.each(MEMRY_INLINE_CONTENT_TYPES)('%s inside a table cell keeps the table', async (type) => {
    // #given a table whose first cell is nothing but the marker — the shape that
    // makes a text-matching `parse` claim the whole <td>
    const form = INLINE_TEXT_FORMS[type]
    const markdown = `| ${form} | b |\n| --- | --- |\n| c | d |`
    const doc = new Y.Doc()
    await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))

    // #when
    const result = await yDocToMarkdown(doc)

    // #then the table is still a table (the separator row's padding is
    // normalized by remark on both sides of any change, so it is not asserted)
    expect(result).toContain(form)
    expect(result?.split('\n')).toHaveLength(3)
    expect(result?.startsWith('|')).toBe(true)
    expect(result).toContain('| d |')
  })
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
    // Marked links, the #1439 shapes. Main has no wikiLink `parse` rule, so
    // these stay styled TEXT runs on this path — which is exactly why the bytes
    // must not move: the renderer promotes them to nodes on open, and the node
    // has to serialize back to these same bytes.
    '**[[Roadmap]]**',
    '*[[A]]*',
    '~~[[A]]~~',
    '`[[A]]`',
    '**[[A|b]]**',
    'See **[[A]]** and *[[B]]* today.',
    // The shape the narrowing declines to promote — it has to survive main's
    // own round trip untouched, or declining would not help.
    '~~Cancelled: [[Meeting]]~~',
    '**See [[Roadmap]] for details**',
    '# Heading\n\n[[A]] and #tag and ((mention:https%3A%2F%2Fx.com)) inline.',
    '- [[A]]\n- [[B]]',
    '> [[Quoted]]',
    '- [ ] a task {task:t1}',
    '```ts\nconst x = "[[Roadmap]]"\n```',
    '((date:eyJhbmNob3JJZCI6ImExIn0)) leftover token.',
    // Callouts stay quote blocks on this path: their marker line carries a type
    // and an optional title the callout schema cannot hold, so parsing them
    // would rewrite `> [!note]` as `> [!info]` in every Obsidian vault.
    '> [!info]\n> Heads up',
    '> [!note]\n> An Obsidian type this schema has no value for',
    '> [!info] A title on the marker line\n> and a body',
    // A marker inside a fence is the author's text, not a marker.
    '```md\n![bookmark](https://example.com)\n<!-- file:{"url":"u","name":"n","size":1,"mimeType":"m"} -->\n```',
    // `![embed](…)` only becomes a video when there is a video to play.
    '![embed](https://example.com/not-a-video)'
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

/**
 * Every custom BLOCK type, with the markdown form it must serialize to and the
 * block the renderer authors for it. A new block spec with no case here fails
 * this table rather than being silently untested — the whole class of bug was
 * one spec nobody covered.
 *
 * `callout`, `youtubeEmbed` and `bookmark` COMPUTE their expected markdown from
 * `serializeCalloutBlock` / `serializeYoutubeEmbed` / `serializeBookmark`. For
 * those three the on-disk form genuinely has two implementations — those
 * functions, which the renderer's save path calls directly, and the hand-built
 * DOM in main's server spec that BlockNote turns into markdown — so comparing
 * main's real output against the renderer's serializer gates their agreement.
 *
 * `file` and `taskBlock` spell the bytes out as LITERALS, because main
 * serializes through the very same functions (`fileBlockCommentData` inside the
 * file server spec, `serializeTaskBlock` inside the converter). Computing those
 * expectations compares a function to itself: renaming the marker `file:` →
 * `memry-file:` — a change that rewrites every note holding an attachment, in
 * every vault — left this suite 104/104 green. Where there is only one
 * implementation, the literal IS the contract.
 */
const BLOCK_CASES = [
  {
    type: 'callout',
    markdown: serializeCalloutBlock('info', 'Heads up'),
    block: {
      id: 'blk',
      type: 'callout',
      props: { type: 'info', textAlignment: 'left', textColor: 'default' },
      content: [{ type: 'text', text: 'Heads up', styles: {} }],
      children: []
    }
  },
  {
    type: 'youtubeEmbed',
    markdown: serializeYoutubeEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
    block: {
      id: 'blk',
      type: 'youtubeEmbed',
      props: { videoId: 'dQw4w9WgXcQ', videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
      children: []
    }
  },
  {
    type: 'bookmark',
    markdown: serializeBookmark('https://example.com/a'),
    block: {
      id: 'blk',
      type: 'bookmark',
      props: {
        url: 'https://example.com/a',
        domain: 'example.com',
        title: '',
        description: '',
        image: '',
        favicon: '',
        siteName: ''
      },
      children: []
    }
  },
  {
    type: 'file',
    // Literal on purpose. `serializeFileBlock` is what MAIN serializes through
    // (its server spec builds the comment from `fileBlockCommentData`), so
    // computing the expectation from it would compare the function to itself:
    // renaming the marker `file:` → `memry-file:` — which rewrites every note
    // holding an attachment, in every vault — left this suite 104/104 green.
    // The bytes below are the vault format; they are the contract.
    markdown:
      '<!-- file:{"url":"memry-file://local/v/a/x.pdf","name":"x.pdf","size":1234,"mimeType":"application/pdf"} -->',
    block: {
      id: 'blk',
      type: 'file',
      props: {
        url: 'memry-file://local/v/a/x.pdf',
        name: 'x.pdf',
        size: 1234,
        mimeType: 'application/pdf',
        width: 0,
        height: 0,
        align: 'left'
      },
      children: []
    }
  },
  {
    type: 'taskBlock',
    // Literal for the same reason as `file`: the converter serializes task
    // blocks through `serializeTaskBlock` itself (blocknote-converter.ts), so a
    // computed expectation cannot fail.
    markdown: '- [ ] a task {task:t1}',
    block: {
      id: 'blk',
      type: 'taskBlock',
      props: { taskId: 't1', title: 'a task', checked: false, parentTaskId: '' },
      children: []
    }
  }
] as const

function docHolding(block: unknown): Y.Doc {
  const doc = new Y.Doc()
  blocksToYFragment(
    [block] as unknown as Parameters<typeof blocksToYFragment>[0],
    doc.getXmlFragment(CRDT_FRAGMENT_NAME)
  )
  return doc
}

describe('the round-trip tables cover every custom node type', () => {
  // The gate on the gate (#1433). BLOCK_CASES and INLINE_CASES are hand-written
  // fixtures, and a hand-written list is exactly how this whole class of bug got
  // in: a spec was added, nobody wrote a case for it, and nothing was red. So
  // the case lists are checked against the package's exported type lists —
  // adding a spec without a fixture FAILS here rather than being skipped.
  it('has a round-trip fixture for every custom block type', () => {
    expect(BLOCK_CASES.map((c) => c.type as string).sort()).toEqual([...MEMRY_BLOCK_TYPES].sort())
  })

  it('has a round-trip fixture for every custom inline type', () => {
    expect(INLINE_CASES.map((c) => c.nodeName as string).sort()).toEqual(
      [...MEMRY_INLINE_CONTENT_TYPES].sort()
    )
  })

  it('the converter this build ships can construct every custom node type', () => {
    // #given one document holding every custom block AND every custom inline
    // node, read through the converter's OWN schema — not a reconstruction.
    // A type missing from `blocknote-converter.ts`'s schema is a delete
    // y-prosemirror replicates to every device.
    const doc = new Y.Doc()
    blocksToYFragment(
      BLOCK_CASES.map((c) => c.block) as unknown as Parameters<typeof blocksToYFragment>[0],
      doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    )
    const blockGroup = doc.getXmlFragment(CRDT_FRAGMENT_NAME).get(0) as Y.XmlElement
    blockGroup.push([customInlineBlockContainer()])

    // #when / #then
    expect(findUnrepresentableNodes(doc)).toEqual([])
  })
})

describe('custom blocks survive the CRDT write path', () => {
  it.each(BLOCK_CASES.filter((c) => c.type !== 'taskBlock'))(
    '$type survives markdown → doc → markdown unchanged',
    async ({ markdown }) => {
      // #given a vault note as it exists on disk today
      const doc = new Y.Doc()
      const ok = await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))
      expect(ok).toBe(true)

      // #when write-back serializes it again
      // #then the bytes are identical, so nothing is written
      expect(await yDocToMarkdown(doc)).toBe(markdown)
    }
  )

  it.each(BLOCK_CASES)(
    '$type serializes to its on-disk form without touching the doc',
    async ({ block, markdown }) => {
      // #given the doc the renderer produces when the user authors the block
      const doc = docHolding(block)
      const before = Y.encodeStateAsUpdate(doc)

      // #when write-back serializes it
      const result = await yDocToMarkdown(doc)

      // #then the vault file gets the exact marker it holds today…
      expect(result).toBe(markdown)
      // …and the shared doc is untouched: y-prosemirror's answer to a node it
      // cannot build is to DELETE it, which replicates to every other device.
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
    }
  )

  it.each(BLOCK_CASES)('$type is representable by this build', ({ block }) => {
    // #given / #when / #then — a name missing from the schema is a replicated
    // delete, and write-back refuses the whole file when it sees one.
    expect(findUnrepresentableNodes(docHolding(block))).toEqual([])
  })

  it.each(BLOCK_CASES)(
    '$type keeps its marker nested under a list item',
    async ({ block, markdown }) => {
      // #given a block indented under a bullet. This path does NOT take the
      // converter's top-level branch — it goes through the spec's own HTML,
      // which is where a `render` that throws stops the note writing back.
      const doc = docHolding({
        id: 'parent',
        type: 'bulletListItem',
        props: { textAlignment: 'left', textColor: 'default', backgroundColor: 'default' },
        content: [{ type: 'text', text: 'parent', styles: {} }],
        children: [block]
      })

      // #when
      const result = await yDocToMarkdown(doc)

      // #then the conversion succeeds at all (a throwing render returns null)…
      expect(result).not.toBeNull()
      // …and the nested block still carries its own marker, not editor markup
      expect(result).toContain('parent')
      expect(result).toContain(markdown)
    }
  )
})

describe('custom blocks and table cells', () => {
  // The inline specs have to survive a table cell because BlockNote serializes
  // inline content through `render` there. Blocks cannot: a cell holds inline
  // content only, so no block spec's `render` is reachable that way. That is a
  // property of the schema, so it is proven rather than assumed — if a future
  // BlockNote lets a block into a cell, this fails and the block specs need the
  // same treatment the inline ones got.
  it('a table cell admits inline content only, so no block spec renders inside one', () => {
    const pmSchema = serverEditorForSchemaInspection().editor.pmSchema

    for (const cellNode of ['tableCell', 'tableHeader', 'tableParagraph']) {
      const content = pmSchema.nodes[cellNode]?.spec.content ?? ''
      for (const blockType of MEMRY_BLOCK_TYPES) {
        expect(content).not.toContain(blockType)
      }
    }
  })

  it.each(BLOCK_CASES)(
    '$type serializes next to a table without breaking it',
    async ({ block, markdown }) => {
      // #given a note that holds both — the combination that made a throwing spec
      // return null for the whole document rather than for one block
      const doc = new Y.Doc()
      blocksToYFragment(
        [
          block,
          {
            id: 'tbl',
            type: 'table',
            props: {},
            children: [],
            content: {
              type: 'tableContent',
              columnWidths: [null],
              rows: [
                {
                  cells: [
                    {
                      type: 'tableCell',
                      content: [{ type: 'text', text: 'x', styles: {} }],
                      props: {
                        colspan: 1,
                        rowspan: 1,
                        backgroundColor: 'default',
                        textColor: 'default',
                        textAlignment: 'left'
                      }
                    }
                  ]
                }
              ]
            }
          }
        ] as unknown as Parameters<typeof blocksToYFragment>[0],
        doc.getXmlFragment(CRDT_FRAGMENT_NAME)
      )

      // #when / #then
      const result = await yDocToMarkdown(doc)
      expect(result).not.toBeNull()
      expect(result).toContain(markdown)
    }
  )
})

/**
 * The same schema `blocknote-converter` builds, in an editor of its own, purely
 * so a test can look at the ProseMirror schema and call the specs directly.
 */
function serverEditorForSchemaInspection(): ServerBlockNoteEditor {
  return ServerBlockNoteEditor.create({
    schema: createMemrySchema({
      blocks: createServerBlockSpecs(),
      inline: createServerInlineSpecs()
    })
  }) as ServerBlockNoteEditor
}

// `render` is not presentation in the main process — BlockNote reaches it for
// anything it serializes without a `toExternalHTML`, and one throw there makes
// `yDocToMarkdown` return null so the note stops writing back entirely. That
// property is asserted for every block AND inline spec, derived from the
// exported type lists, in `packages/editor-schema/src/schema-contract.test.ts`
// (`pnpm --filter @memry/editor-schema test`), next to the specs themselves.
// What this file gates is the other half: the bytes the real converter writes.

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

  it.each(INLINE_CASES)(
    '$nodeName keeps its on-disk form in a table cell',
    async ({ nodeName, attrs, text }) => {
      // #given the same table-driven list the top-level round-trip uses, so a
      // new inline spec is covered here too or the coverage gate above is red.
      // A cell is the one place BlockNote reaches `render`, which is how a rich
      // or throwing server implementation reaches the vault file.
      const markdown = await tableMarkdown([{ type: nodeName, props: { ...attrs } }])

      // #then the conversion succeeds at all (a throwing render returns null)…
      expect(markdown).not.toBeNull()
      // …and the cell holds the textual form, not the editor's rich markup
      expect(markdown).toContain(text)
    }
  )

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

describe('custom block markers are not claimed out of context', () => {
  const FENCE3 = '`'.repeat(3)
  const FENCE4 = '`'.repeat(4)
  const FILE_MARKER =
    '<!-- file:{"url":"memry-file://local/v/a/x.pdf","name":"x.pdf","size":1234,"mimeType":"application/pdf"} -->'

  async function roundTrip(markdown: string): Promise<string | null> {
    const doc = new Y.Doc()
    await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))
    return await yDocToMarkdown(doc)
  }

  it('a marker quoted inside a nested code fence stays text', async () => {
    // #given a note documenting the marker format — a four-backtick fence
    // wrapping a three-backtick one. A fence tracker that only toggles on
    // /^```/ reads the inner fence as the closing one, and everything after it
    // as live markdown: the code block is torn in two and the *example* marker
    // becomes a real file block pointing at a PDF.
    const markdown = `How the marker looks:\n\n${FENCE4}md\n${FENCE3}\n${FILE_MARKER}\n${FENCE3}\n${FENCE4}\n\nThat is all.`

    // #when
    const result = await roundTrip(markdown)

    // #then
    expect(result).toBe(markdown)
  })

  it('a tilde fence does not close a backtick fence', async () => {
    // #given ~~~ inside a ``` block is content, not a delimiter
    const markdown = `${FENCE3}md\n~~~\n${FILE_MARKER}\n~~~\n${FENCE3}`

    // #when / #then
    expect(await roundTrip(markdown)).toBe(markdown)
  })

  it('keeps a block-colour marker that follows a nested fence', async () => {
    // #given colours are parsed on a path that predates custom blocks. Guarding
    // it on fence state made a marker after a fence the tracker read wrong
    // vanish from the vault file — data loss on a path this work never touched.
    const markdown = `${FENCE4}\n${FENCE3}\n${FENCE4}\n\n<!-- colors:{"backgroundColor":"blue"} -->\ntinted`

    // #when
    const result = await roundTrip(markdown)

    // #then the colour survives (the fence's language tag is normalized by
    // remark on both sides of this change, so compare the part that matters)
    expect(result).toContain('<!-- colors:{"backgroundColor":"blue"} -->\ntinted')
  })

  it('leaves an embed marker indented under a list item nested', async () => {
    // #given the renderer matches the two image markers on the RAW line, so a
    // marker indented under a list item is content. Trimming first claims it
    // and the nesting is lost — the same file would then parse to a different
    // document depending on which process read it.
    const markdown = '- item\n\n  ![embed](https://youtu.be/dQw4w9WgXcQ)'

    // #when
    const result = await roundTrip(markdown)

    // #then the nesting marker is still there
    expect(result).toContain('block-nesting-level=1')
  })

  it('leaves a real image whose alt text happens to be bookmark alone', async () => {
    // #given someone's screenshot, not a bookmark card. The embed branch has
    // extractYouTubeVideoId for this; the bookmark branch needs its own check.
    const markdown = '![bookmark](assets/photo.png)'

    // #when / #then
    expect(await roundTrip(markdown)).toBe(markdown)
  })

  // HTML closes a comment on `-->` and on `--!>` (the spec's comment-end-bang
  // state). Either one inside the payload splits the marker and spills the rest
  // of the JSON into the note as a paragraph — a file named `a-->b.pdf` is
  // enough. Only the `>` is escaped: escaping every `--` would change the bytes
  // of every marker whose filename contains one.
  it.each([['a-->b.pdf'], ['a--!>b.pdf'], ['a--b--c.pdf']])(
    'a file named %s survives the marker round-trip',
    (name) => {
      // #given
      const props = { url: 'memry-file://x/y.pdf', name, size: 5, mimeType: 'application/pdf' }

      // #when
      const marker = `<!--${fileBlockCommentData(props as never)}-->`

      // #then exactly one terminator — the one that closes the marker
      expect(marker.match(/--!?>/g)).toHaveLength(1)
      expect(parseFileBlockMarker(marker)).toMatchObject({ name })
    }
  )

  it('does not scan quadratically over a line that only looks like a marker', () => {
    // #given note bodies arrive over sync, so an unanchored scan here is
    // reachable input. Unanchored this took 392ms at 8k repetitions.
    const decoy = '<!-- file:{'.repeat(8000)

    // #when
    const started = performance.now()
    const parsed = parseFileBlockMarker(decoy)

    // #then rejected, and in constant-ish time rather than seconds
    expect(parsed).toBeNull()
    expect(performance.now() - started).toBeLessThan(50)
  })
})
