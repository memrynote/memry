import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WikiLinkPreviewCard } from './wiki-link-preview-card'

vi.mock('@/features/tag-fields/use-tag-schemas', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useObjectIdentity: () => null
}))

const preview = {
  id: 'note-ai',
  title: 'Artificial Intelligence',
  emoji: null,
  snippet: null,
  tags: [],
  createdAt: '2026-05-10T00:00:00.000Z',
  path: 'Artificial Intelligence.md',
  cover: null,
  description: null,
  bodyText: null
}

function renderCard(matchedName: string | null) {
  render(
    <WikiLinkPreviewCard
      preview={{ ...preview, matchedName }}
      position={{ top: 0, left: 0, placement: 'below' }}
      onMouseEnter={vi.fn()}
      onMouseLeave={vi.fn()}
    />
  )
}

describe('WikiLinkPreviewCard', () => {
  it('says which other name a link reached the note through', () => {
    renderCard('AI')
    expect(screen.getByText('AI → Artificial Intelligence')).toBeInTheDocument()
  })

  it('adds no name line for a link that named the title', () => {
    renderCard(null)
    expect(screen.queryByText(/→/)).not.toBeInTheDocument()
  })
})
