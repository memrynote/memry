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
  it('renders a URL-backed folder icon at the built-in glyph size, not the row text size', () => {
    const { container } = render(
      <FolderIconButton icon="custom:known" isExpanded={false} onIconChange={vi.fn()} />
    )

    const img = container.querySelector('img')
    expect(img?.className).toContain('size-5')
    expect(img?.className).toContain('object-contain')
    expect(img?.getAttribute('alt')).toBe('Rocket')
    // The picker button is the row's reserved 20px slot; the icon fills it
    // rather than growing it, which is what keeps the row height put.
    expect(img?.closest('button')?.className).toContain('h-5 w-5')
  })

  it('keeps the same 20px slot when the icon is missing from the library', () => {
    const { container } = render(
      <FolderIconButton icon="custom:deleted-on-a-peer" isExpanded={false} onIconChange={vi.fn()} />
    )

    expect(container.querySelector('img')).toBeNull()
    const placeholder = container.querySelector('button span > span')
    expect(placeholder?.className).toBe('size-5')
  })

  it('falls back to the built-in folder glyph when the folder has no icon', () => {
    const { container } = render(
      <FolderIconButton icon={null} isExpanded={false} onIconChange={vi.fn()} />
    )

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })
})
