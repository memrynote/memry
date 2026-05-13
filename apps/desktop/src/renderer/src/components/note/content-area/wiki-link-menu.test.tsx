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
        'menus.wiki.wikiLinkAria': `Wiki link ${values?.title ?? ''}`.trim()
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
})
