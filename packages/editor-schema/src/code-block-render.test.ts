import { afterEach, describe, expect, it } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'
import { createMemrySchema } from './schema'
import { memryCodeBlockOptions } from './code-block'
import { createServerBlockSpecs, createServerInlineSpecs } from './server'

/**
 * BlockNote 0.54's language picker throws for a `language` the picker does not
 * list, from inside the node view, and the editor's error boundary then
 * replaces the whole note. Memry stores an untagged fence as `''` (#1909), so a
 * single bare ``` fence made a note unopenable.
 */
describe('a code block whose language the picker does not list', () => {
  let editor: BlockNoteEditor<any, any, any> | null = null

  afterEach(() => {
    editor?.unmount()
    editor = null
    document.body.innerHTML = ''
  })

  function mountWith(language: string): {
    editor: BlockNoteEditor<any, any, any>
    host: HTMLElement
  } {
    const schema = createMemrySchema({
      blocks: createServerBlockSpecs(),
      inline: createServerInlineSpecs(),
      codeBlock: memryCodeBlockOptions
    })
    const created = BlockNoteEditor.create({
      schema,
      initialContent: [
        { type: 'codeBlock', props: { language }, content: '{"kanban-plugin":"basic"}' }
      ]
    } as never) as BlockNoteEditor<any, any, any>
    const host = document.createElement('div')
    document.body.appendChild(host)
    created.mount(host)
    editor = created
    return { editor: created, host }
  }

  it.each([
    ['an untagged fence', ''],
    ['a tag the picker lacks', 'not-a-language']
  ])('renders %s as Plain Text and keeps the stored language', (_label, language) => {
    // #when
    const { editor: mounted, host } = mountWith(language)

    // #then the picker shows Plain Text, and the prop the fence is written back
    // from is untouched
    expect(host.querySelector<HTMLSelectElement>('select')?.value).toBe('text')
    expect(mounted.document[0]?.props.language).toBe(language)
  })

  it('still selects a listed language', () => {
    // #when
    const { host } = mountWith('python')

    // #then
    expect(host.querySelector<HTMLSelectElement>('select')?.value).toBe('python')
  })
})
