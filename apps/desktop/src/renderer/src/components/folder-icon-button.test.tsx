import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { FolderIconButton } from './folder-icon-button'

vi.mock('@/lib/custom-icons-store', () => ({
  useCustomIcon: (id: string) =>
    id === 'known'
      ? {
          id: 'known',
          name: 'Rocket',
          url: 'memry-file:///icons/known.png',
          createdAt: '2026-01-01T00:00:00.000Z'
        }
      : undefined
}))

describe('FolderIconButton custom icons', () => {
  // The picker button is the row's 20px slot, and its font size is the one icon
  // size every kind shares: a custom image takes one em of it, as an emoji does.
  it('renders a URL-backed folder icon in the same em box as emoji and library icons', () => {
    const { container } = render(
      <FolderIconButton icon="custom:known" isExpanded={false} onIconChange={vi.fn()} />
    )

    const img = container.querySelector('img')
    expect(img?.className).toContain('h-[1em] w-[1em]')
    expect(img?.getAttribute('alt')).toBe('Rocket')
    expect(img?.closest('button')?.className).toContain('h-5 w-5')
    expect(img?.closest('button')?.className).toContain('text-base')
  })

  it('keeps the same box when the icon is missing from the library', () => {
    const { container } = render(
      <FolderIconButton icon="custom:deleted-on-a-peer" isExpanded={false} onIconChange={vi.fn()} />
    )

    expect(container.querySelector('img')).toBeNull()
    const placeholder = container.querySelector('button span > span')
    expect(placeholder?.className).toBe('h-[1em] w-[1em]')
  })

  it('falls back to the built-in folder glyph when the folder has no icon', () => {
    const { container } = render(
      <FolderIconButton icon={null} isExpanded={false} onIconChange={vi.fn()} />
    )

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })
})
