import { describe, expect, it } from 'vitest'

import { customIconDataUri, resolveIcon } from '../icon-value'

/**
 * Icon values, isolated.
 *
 * The bug this pins is a rendering one that only shows on a real vault: the
 * tree used to print the stored string, so a desktop-set glyph arrived as the
 * literal text `icon:folder-01` on the row. Every branch below is a value some
 * desktop build actually writes into the same column.
 */

const LIBRARY = new Map([['abc123', 'data:image/png;base64,AAAA']])

describe('resolveIcon', () => {
  it('renders a literal emoji as text', () => {
    expect(resolveIcon('📚', LIBRARY)).toEqual({ kind: 'emoji', text: '📚' })
  })

  it('falls back for a named glyph rather than printing its name', () => {
    // Desktop names HugeIcons; this app draws lucide. There is no name to look
    // up, and the row's own type glyph is the honest answer.
    expect(resolveIcon('icon:folder-01', LIBRARY)).toBeNull()
  })

  it('resolves a custom icon to its bytes', () => {
    expect(resolveIcon('custom:abc123', LIBRARY)).toEqual({
      kind: 'image',
      uri: 'data:image/png;base64,AAAA'
    })
  })

  it('falls back when the custom icon has not synced yet', () => {
    // The icon value and the `custom_icon` row are two sync items, so a device
    // routinely holds one without the other for a while.
    expect(resolveIcon('custom:missing', LIBRARY)).toBeNull()
  })

  it('treats an absent or empty value as no icon', () => {
    expect(resolveIcon(null, LIBRARY)).toBeNull()
    expect(resolveIcon(undefined, LIBRARY)).toBeNull()
    expect(resolveIcon('', LIBRARY)).toBeNull()
  })
})

describe('customIconDataUri', () => {
  it('maps the extensions main can store', () => {
    expect(customIconDataUri('png', 'AA')).toBe('data:image/png;base64,AA')
    expect(customIconDataUri('SVG', 'AA')).toBe('data:image/svg+xml;base64,AA')
    expect(customIconDataUri('jpeg', 'AA')).toBe('data:image/jpeg;base64,AA')
  })

  it('guesses PNG for an extension it does not know', () => {
    // Main normalizes every upload to PNG except SVG, so an unknown extension
    // is a newer build widening the set — drawing it beats refusing to.
    expect(customIconDataUri('avif', 'AA')).toBe('data:image/png;base64,AA')
    expect(customIconDataUri(undefined, 'AA')).toBe('data:image/png;base64,AA')
  })
})
