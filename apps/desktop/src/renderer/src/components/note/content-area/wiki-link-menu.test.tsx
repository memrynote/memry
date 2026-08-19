import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WikiLinkMenu, type WikiLinkSuggestionItem } from './wiki-link-menu'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: { title?: string }) => {
      const messages: Record<string, string> = {
        'menus.wiki.embed': 'Embed',
        'menus.wiki.wikiLink': 'Wiki link',
        'menus.wiki.embedAria': `Embed ${values?.title ?? ''}`.trim(),
        'menus.wiki.wikiLinkAria': `Wiki link ${values?.title ?? ''}`.trim(),
        'menus.wiki.noHeadings': `${values?.title ?? ''} has no headings`.trim(),
        'menus.wiki.noMatchingHeadings': `No headings in ${values?.title ?? ''} match`.trim()
      }
      return messages[key] ?? key
    }
  })
}))

describe('WikiLinkMenu', () => {
  it('offers embed and wiki link actions on audio suggestions', () => {
    const onItemClick = vi.fn()
    const item: WikiLinkSuggestionItem = {
      id: 'voice-1',
      title: 'Voice memo',
      target: 'Voice memo',
      exists: true,
      type: 'note',
      fileType: 'audio',
      mimeType: 'audio/wav',
      fileSize: 4096
    }

    render(
      <WikiLinkMenu
        items={[item]}
        loadingState="loaded"
        selectedIndex={0}
        onItemClick={onItemClick}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Embed Voice memo' }))
    expect(onItemClick).toHaveBeenCalledWith({ ...item, insertMode: 'embed' })

    fireEvent.click(screen.getByRole('button', { name: 'Wiki link Voice memo' }))
    expect(onItemClick).toHaveBeenCalledWith({ ...item, insertMode: 'wikiLink' })
  })

  it('renders heading rows that insert a note#heading target', () => {
    const onItemClick = vi.fn()
    const heading: WikiLinkSuggestionItem = {
      id: 'heading:note-1:0',
      title: 'Kararlar',
      target: 'Toplantı#Kararlar',
      alias: '',
      exists: true,
      type: 'heading',
      headingLevel: 2
    }

    render(
      <WikiLinkMenu
        items={[heading]}
        loadingState="loaded"
        selectedIndex={0}
        onItemClick={onItemClick}
      />
    )

    fireEvent.click(screen.getByRole('option', { name: 'Kararlar' }))
    expect(onItemClick).toHaveBeenCalledWith({ ...heading, insertMode: 'wikiLink' })
  })

  it('says the note has no headings, and cannot be picked', () => {
    const onItemClick = vi.fn()
    const empty: WikiLinkSuggestionItem = {
      id: 'headings:note-1',
      title: 'Toplantı',
      target: '',
      exists: true,
      type: 'headingEmpty',
      filtered: false
    }

    const { rerender } = render(
      <WikiLinkMenu
        items={[empty]}
        loadingState="loaded"
        selectedIndex={0}
        onItemClick={onItemClick}
      />
    )

    expect(screen.getByText('Toplantı has no headings')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('option'))
    expect(onItemClick).not.toHaveBeenCalled()

    rerender(
      <WikiLinkMenu
        items={[{ ...empty, filtered: true }]}
        loadingState="loaded"
        selectedIndex={0}
        onItemClick={onItemClick}
      />
    )
    expect(screen.getByText('No headings in Toplantı match')).toBeInTheDocument()
  })
})
