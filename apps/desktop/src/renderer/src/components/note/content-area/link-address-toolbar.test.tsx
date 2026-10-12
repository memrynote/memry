import { BlockNoteEditor } from '@blocknote/core'
import { BlockNoteView } from '@blocknote/shadcn'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LinkAddressToolbar, openLinkAddress } from './link-address-toolbar'

const TITLED = 'https://e.com/x "T"'

function linkedEditor(href: string): { editor: BlockNoteEditor; from: number; to: number } {
  const editor = BlockNoteEditor.create({
    initialContent: [{ type: 'paragraph', content: [{ type: 'link', href, content: 'site' }] }]
  })
  let from = 0
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (node.isText && from === 0) from = pos
  })
  return { editor, from, to: from + 'site'.length }
}

function hrefOf(editor: BlockNoteEditor): string | undefined {
  const content = editor.document[0].content as Array<{ type: string; href?: string }>
  return content.find((item) => item.type === 'link')?.href
}

function renderToolbar(href: string): BlockNoteEditor {
  const { editor, from, to } = linkedEditor(href)
  render(
    <BlockNoteView editor={editor} linkToolbar={false}>
      <LinkAddressToolbar url={href} text="site" range={{ from, to }} />
    </BlockNoteView>
  )
  return editor
}

describe('openLinkAddress (BBF-112)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('opens the address half of a clicked titled link, once', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const anchor = document.createElement('a')
    anchor.setAttribute('href', TITLED)
    const label = anchor.appendChild(document.createElement('span'))
    const click = new MouseEvent('click')
    Object.defineProperty(click, 'target', { value: label })

    expect(openLinkAddress(click)).toBe(true)
    expect(open).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledWith('https://e.com/x', '_blank')
  })
})

describe('LinkAddressToolbar (BBF-112)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('opens the address half of a titled link', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    renderToolbar(TITLED)

    fireEvent.click(screen.getByRole('button', { name: 'Open in new tab' }))

    expect(open).toHaveBeenCalledWith('https://e.com/x', '_blank')
  })

  it('edits the address and keeps the stored title', async () => {
    const editor = renderToolbar(TITLED)

    fireEvent.click(screen.getByRole('button', { name: 'Edit link' }))
    const field = await screen.findByPlaceholderText('Edit URL')
    expect(field).toHaveValue('https://e.com/x')
    fireEvent.change(field, { target: { value: 'https://e.com/y' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    expect(hrefOf(editor)).toBe('https://e.com/y "T"')
  })

  it('keeps the whole href when only the text changes', async () => {
    const editor = renderToolbar(TITLED)

    fireEvent.click(screen.getByRole('button', { name: 'Edit link' }))
    const text = await screen.findByPlaceholderText('Edit title')
    fireEvent.change(text, { target: { value: 'page' } })
    fireEvent.keyDown(text, { key: 'Enter' })

    expect(hrefOf(editor)).toBe(TITLED)
  })
})
