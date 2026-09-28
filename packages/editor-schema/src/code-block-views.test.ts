import { afterEach, describe, expect, it } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'
import { createMemrySchema } from './schema'
import { memryCodeBlockOptions } from './code-block'
import { createServerBlockSpecs, createServerInlineSpecs } from './server'

/**
 * `codeBlockViews` draws a code block tagged with one of its languages through
 * that view (#2488's `memry-view`), and every other code block as code. The
 * node is the code block's either way, so the document — and the markdown it
 * serializes to — must not change with the view.
 */
describe('codeBlockViews', () => {
  let editor: BlockNoteEditor<any, any, any> | null = null

  afterEach(() => {
    editor?.unmount()
    editor = null
    document.body.innerHTML = ''
  })

  function mount(withViews: boolean): HTMLElement {
    const schema = createMemrySchema({
      blocks: createServerBlockSpecs(),
      inline: createServerInlineSpecs(),
      codeBlock: memryCodeBlockOptions,
      codeBlockViews: withViews
        ? {
            'memry-view': () => {
              const dom = document.createElement('div')
              dom.dataset.testView = 'true'
              const contentDOM = document.createElement('code')
              dom.appendChild(contentDOM)
              return { dom, contentDOM }
            }
          }
        : undefined
    })
    editor = BlockNoteEditor.create({
      schema,
      initialContent: [
        {
          type: 'codeBlock',
          props: { language: 'memry-view' },
          content: '{"source":{"kind":"vault"}}'
        },
        { type: 'codeBlock', props: { language: 'javascript' }, content: 'const a = 1' }
      ]
    } as never) as BlockNoteEditor<any, any, any>
    const host = document.createElement('div')
    document.body.appendChild(host)
    editor.mount(host)
    return host
  }

  it('routes only the tagged language to the view', () => {
    const host = mount(true)

    const views = host.querySelectorAll('[data-test-view="true"]')
    expect(views).toHaveLength(1)
    expect(views[0].textContent).toBe('{"source":{"kind":"vault"}}')
    expect(host.querySelectorAll('pre')).toHaveLength(1)
  })

  it('writes the same markdown with or without the view', async () => {
    mount(false)
    const plain = await editor!.blocksToMarkdownLossy(editor!.document)
    editor!.unmount()
    mount(true)
    const viewed = await editor!.blocksToMarkdownLossy(editor!.document)

    expect(viewed).toBe(plain)
    expect(viewed).toContain('```memry-view\n{"source":{"kind":"vault"}}\n```')
  })
})
