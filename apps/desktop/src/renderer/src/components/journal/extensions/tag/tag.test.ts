import { describe, expect, it, vi } from 'vitest'

const suggestionMock = vi.hoisted(() => vi.fn((options: unknown) => ({ options })))

vi.mock('@tiptap/suggestion', () => ({
  default: suggestionMock
}))

import { Tag, tagStyles } from './tag'

describe('journal Tag extension', () => {
  it('builds default options and inserts a tag node from the suggestion command', () => {
    const run = vi.fn()
    const insertSpace = vi.fn(() => ({ run }))
    const insertTag = vi.fn(() => ({ insertContent: insertSpace }))
    const deleteRange = vi.fn(() => ({ insertContent: insertTag }))
    const focus = vi.fn(() => ({ deleteRange }))
    const editor = { chain: () => ({ focus }) }

    const options = (Tag as any).config.addOptions.call({ name: 'tag' })
    expect(options.HTMLAttributes).toEqual({})
    expect(options.getAriaLabel('work')).toBe('Tag: work, click to filter')
    expect(options.suggestion.char).toBe('#')

    options.suggestion.command({
      editor,
      range: { from: 1, to: 6 },
      props: { tag: 'work' }
    })

    expect(deleteRange).toHaveBeenCalledWith({ from: 1, to: 6 })
    expect(insertTag).toHaveBeenCalledWith({
      type: 'tag',
      attrs: { tag: 'work' }
    })
    expect(insertSpace).toHaveBeenCalledWith(' ')
    expect(run).toHaveBeenCalled()
  })

  it('parses, renders, serializes, and handles missing tag attributes', () => {
    const attributes = (Tag as any).config.addAttributes()
    const element = document.createElement('span')
    element.setAttribute('data-tag', 'work')

    expect(attributes.tag.parseHTML(element)).toBe('work')
    expect(attributes.tag.renderHTML({ tag: 'work' })).toEqual({ 'data-tag': 'work' })
    expect(attributes.tag.renderHTML({ tag: '' })).toEqual({})
    expect((Tag as any).config.parseHTML()).toEqual([{ tag: 'span[data-tag-node]' }])

    const rendered = (Tag as any).config.renderHTML.call(
      {
        options: {
          HTMLAttributes: { 'data-source': 'journal' },
          getAriaLabel: (tag: string) => `Filter ${tag}`
        }
      },
      { HTMLAttributes: { tag: 'work' } }
    )

    expect(rendered).toEqual([
      'span',
      expect.objectContaining({
        'data-source': 'journal',
        'data-tag-node': '',
        class: 'tag',
        role: 'button',
        tabindex: '0',
        'aria-label': 'Filter work'
      }),
      '#work'
    ])

    const renderedWithoutLabel = (Tag as any).config.renderHTML.call(
      { options: { HTMLAttributes: {}, getAriaLabel: undefined } },
      { HTMLAttributes: { tag: undefined } }
    )
    expect(renderedWithoutLabel[1]).toEqual(expect.objectContaining({ 'aria-label': '' }))
    expect(renderedWithoutLabel[2]).toBe('#undefined')
    expect((Tag as any).config.renderText({ node: { attrs: { tag: 'work' } } })).toBe('#work')
    expect(tagStyles).toContain('.tag:hover')
  })

  it('deletes an adjacent tag node on Backspace and ignores non-tag selections', () => {
    const deleteMock = vi.fn()
    const command = vi.fn((callback) =>
      callback({
        tr: { delete: deleteMock },
        state: {
          selection: { empty: true, anchor: 10 },
          doc: {
            nodesBetween: vi.fn((_from, _to, visit) => {
              expect(visit({ type: { name: 'tag' }, nodeSize: 2 }, 8)).toBe(false)
            })
          }
        }
      })
    )

    const shortcuts = (Tag as any).config.addKeyboardShortcuts.call({
      name: 'tag',
      editor: { commands: { command } }
    })
    expect(shortcuts.Backspace()).toBe(true)
    expect(deleteMock).toHaveBeenCalledWith(8, 10)

    const nonTagCommand = vi.fn((callback) =>
      callback({
        tr: { delete: vi.fn() },
        state: {
          selection: { empty: true, anchor: 10 },
          doc: {
            nodesBetween: vi.fn((_from, _to, visit) =>
              visit({ type: { name: 'text' }, nodeSize: 1 }, 9)
            )
          }
        }
      })
    )
    const nonTagShortcuts = (Tag as any).config.addKeyboardShortcuts.call({
      name: 'tag',
      editor: { commands: { command: nonTagCommand } }
    })
    expect(nonTagShortcuts.Backspace()).toBe(false)

    const nonEmptyCommand = vi.fn((callback) =>
      callback({
        tr: { delete: vi.fn() },
        state: { selection: { empty: false, anchor: 10 }, doc: { nodesBetween: vi.fn() } }
      })
    )
    const nonEmptyShortcuts = (Tag as any).config.addKeyboardShortcuts.call({
      name: 'tag',
      editor: { commands: { command: nonEmptyCommand } }
    })
    expect(nonEmptyShortcuts.Backspace()).toBe(false)
  })

  it('allows empty and slug-like suggestions but rejects spaces and punctuation', () => {
    ;(Tag as any).config.addProseMirrorPlugins.call({
      editor: {},
      options: { suggestion: { char: '#' } }
    })

    const suggestionOptions = suggestionMock.mock.calls.at(-1)?.[0] as {
      allow: (input: { state: any; range: { from: number; to: number } }) => boolean
    }
    const stateFor = (text: string) => ({
      doc: {
        resolve: () => ({
          start: () => 0,
          parent: {
            textBetween: () => text
          }
        })
      }
    })

    expect(suggestionOptions.allow({ state: stateFor('#'), range: { from: 0, to: 1 } })).toBe(true)
    expect(
      suggestionOptions.allow({ state: stateFor('#work/project'), range: { from: 0, to: 13 } })
    ).toBe(true)
    expect(
      suggestionOptions.allow({ state: stateFor('#bad tag'), range: { from: 0, to: 8 } })
    ).toBe(false)
    expect(suggestionOptions.allow({ state: stateFor('#bad!'), range: { from: 0, to: 5 } })).toBe(
      false
    )
  })
})
