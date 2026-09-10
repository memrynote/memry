import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { FOLDER_CUSTOM_ICON_CLASS, NoteIconDisplay } from './render-note-icon'

// The library is a module store fed by IPC. Only two cases matter here: an id
// the vault knows, and one it does not (deleted on a peer while a folder still
// points at it).
vi.mock('./custom-icons-store', () => ({
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

vi.mock('./hugeicon-renderer', () => ({
  HugeIconByName: ({ name, className }: { name: string; className?: string }) => (
    <span data-testid="huge-icon" data-name={name} className={className} />
  )
}))

describe('NoteIconDisplay custom icons', () => {
  it('sizes a custom icon to the caller box instead of the row text size', () => {
    const { container } = render(
      <NoteIconDisplay
        value="custom:known"
        className="text-sm leading-none"
        customIconClassName={FOLDER_CUSTOM_ICON_CLASS}
      />
    )

    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe('memry-file:///icons/known.png')
    expect(img?.getAttribute('alt')).toBe('Rocket')
    expect(img?.className).toContain(FOLDER_CUSTOM_ICON_CLASS)
    expect(img?.className).toContain('object-contain')
    // The 1em fallback must be gone, not merely joined with the box class.
    expect(img?.className).not.toContain('h-[1em]')
  })

  it('reserves the same box while an icon is missing, so nothing shifts later', () => {
    const { container } = render(
      <NoteIconDisplay
        value="custom:deleted-on-a-peer"
        className="text-sm leading-none"
        customIconClassName={FOLDER_CUSTOM_ICON_CLASS}
      />
    )

    expect(container.querySelector('img')).toBeNull()
    const placeholder = container.querySelector('span > span')
    expect(placeholder?.className).toBe(FOLDER_CUSTOM_ICON_CLASS)
  })

  it('still tracks the surrounding text when no box is requested', () => {
    const { container } = render(<NoteIconDisplay value="custom:known" className="text-sm" />)

    expect(container.querySelector('img')?.className).toContain('h-[1em] w-[1em]')
  })

  it('leaves emoji and library icons untouched by the custom-icon box', () => {
    const emoji = render(
      <NoteIconDisplay value="📚" customIconClassName={FOLDER_CUSTOM_ICON_CLASS} />
    )
    expect(emoji.container.textContent).toBe('📚')
    expect(emoji.container.innerHTML).not.toContain(FOLDER_CUSTOM_ICON_CLASS)

    const library = render(
      <NoteIconDisplay
        value="icon:StarIcon"
        className="text-sm"
        customIconClassName={FOLDER_CUSTOM_ICON_CLASS}
      />
    )
    const glyph = library.getByTestId('huge-icon')
    expect(glyph.getAttribute('data-name')).toBe('StarIcon')
    expect(glyph.className).toBe('text-sm')
  })
})
