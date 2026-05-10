import { describe, expect, it, vi } from 'vitest'

import { WikiLink, wikiLinkStyles } from './wiki-link'

describe('journal WikiLink extension', () => {
  it('builds default options and inserts a wiki-link node from the suggestion command', () => {
    const insertContent = vi.fn(() => ({ run }))
    const deleteRange = vi.fn(() => ({ insertContent }))
    const focus = vi.fn(() => ({ deleteRange }))
    const run = vi.fn()
    const editor = {
      chain: () => ({ focus })
    }

    const options = (WikiLink as any).config.addOptions.call({ name: 'wikiLink' })
    expect(options.HTMLAttributes).toEqual({})
    expect(options.getAriaLabel('Page')).toBe('Link to Page')
    expect(options.suggestion.char).toBe('[[')

    options.suggestion.command({
      editor,
      range: { from: 1, to: 3 },
      props: { href: 'note-1', title: 'Daily Note', exists: true }
    })

    expect(focus).toHaveBeenCalledOnce()
    expect(deleteRange).toHaveBeenCalledWith({ from: 1, to: 3 })
    expect(insertContent).toHaveBeenCalledWith({
      type: 'wikiLink',
      attrs: { href: 'note-1', title: 'Daily Note', exists: true }
    })
    expect(run).toHaveBeenCalledOnce()
  })

  it('parses and renders attributes, HTML, text, broken state, and aria labels', () => {
    const attributes = (WikiLink as any).config.addAttributes()
    const element = document.createElement('span')
    element.setAttribute('data-href', 'note-1')
    element.setAttribute('data-title', 'Daily Note')
    element.setAttribute('data-exists', 'false')

    expect(attributes.href.parseHTML(element)).toBe('note-1')
    expect(attributes.title.parseHTML(element)).toBe('Daily Note')
    expect(attributes.exists.parseHTML(element)).toBe(false)
    expect(attributes.exists.parseHTML(document.createElement('span'))).toBe(true)

    expect(attributes.href.renderHTML({ href: 'note-1' })).toEqual({ 'data-href': 'note-1' })
    expect(attributes.href.renderHTML({ href: '' })).toEqual({})
    expect(attributes.title.renderHTML({ title: 'Daily Note' })).toEqual({
      'data-title': 'Daily Note'
    })
    expect(attributes.title.renderHTML({ title: '' })).toEqual({})
    expect(attributes.exists.renderHTML({ exists: false })).toEqual({ 'data-exists': false })

    expect((WikiLink as any).config.parseHTML()).toEqual([{ tag: 'span[data-wiki-link]' }])

    const rendered = (WikiLink as any).config.renderHTML.call(
      {
        options: {
          HTMLAttributes: { 'data-source': 'journal' },
          getAriaLabel: (title: string) => `Open ${title}`
        }
      },
      {
        HTMLAttributes: {
          href: 'note-1',
          title: 'Missing Page',
          exists: false
        }
      }
    )
    expect(rendered).toEqual([
      'span',
      expect.objectContaining({
        'data-source': 'journal',
        'data-wiki-link': '',
        class: 'wiki-link wiki-link-broken',
        role: 'link',
        tabindex: '0',
        'aria-label': 'Open Missing Page'
      }),
      'Missing Page'
    ])

    const renderedStringExists = (WikiLink as any).config.renderHTML.call(
      {
        options: {
          HTMLAttributes: {},
          getAriaLabel: undefined
        }
      },
      { HTMLAttributes: { title: undefined, exists: 'false' } }
    )
    expect(renderedStringExists[1]).toEqual(
      expect.objectContaining({
        class: 'wiki-link wiki-link-broken',
        'aria-label': ''
      })
    )
    expect(renderedStringExists[2]).toBe('')

    expect((WikiLink as any).config.renderText({ node: { attrs: { title: 'Daily Note' } } })).toBe(
      '[[Daily Note]]'
    )
    expect(wikiLinkStyles).toContain('.wiki-link-broken')
  })

  it('deletes an adjacent wiki-link node on Backspace and ignores non-empty selections', () => {
    const deleteMock = vi.fn()
    const command = vi.fn((callback) =>
      callback({
        tr: { delete: deleteMock },
        state: {
          selection: { empty: true, anchor: 10 },
          doc: {
            nodesBetween: vi.fn((_from, _to, visit) => {
              expect(visit({ type: { name: 'wikiLink' }, nodeSize: 3 }, 7)).toBe(false)
            })
          }
        }
      })
    )

    const shortcuts = (WikiLink as any).config.addKeyboardShortcuts.call({
      name: 'wikiLink',
      editor: { commands: { command } }
    })
    expect(shortcuts.Backspace()).toBe(true)
    expect(deleteMock).toHaveBeenCalledWith(7, 10)

    const nonEmptyCommand = vi.fn((callback) =>
      callback({
        tr: { delete: vi.fn() },
        state: {
          selection: { empty: false, anchor: 10 },
          doc: { nodesBetween: vi.fn() }
        }
      })
    )
    const nonEmptyShortcuts = (WikiLink as any).config.addKeyboardShortcuts.call({
      name: 'wikiLink',
      editor: { commands: { command: nonEmptyCommand } }
    })
    expect(nonEmptyShortcuts.Backspace()).toBe(false)
  })
})
