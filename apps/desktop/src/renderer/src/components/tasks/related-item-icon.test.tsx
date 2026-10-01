import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { RelatedIcon } from './related-item-icon'

// The drawer's Related list, its "Search related..." dropdown and the task
// block's related chip all draw a note through RelatedIcon.
describe('RelatedIcon', () => {
  it.each(['custom:1l4E1zFoOCBC_x6h', 'icon:StarIcon'])(
    'renders a %s note icon as an icon, not as literal text',
    (value) => {
      const { container } = render(
        <RelatedIcon
          kind="note"
          info={{
            kind: 'note',
            title: 'ISO Scoping Information',
            emoji: value,
            fileType: 'markdown'
          }}
          projectColor="#888"
        />
      )

      expect(container.textContent).not.toContain(value)
    }
  )
})
