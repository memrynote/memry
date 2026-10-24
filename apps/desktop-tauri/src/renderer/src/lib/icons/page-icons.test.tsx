import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PageCalendarIcon, PageInboxIcon } from './page-icons'

describe('page icons', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('draws an outline at rest and a masked solid when active', () => {
    const { container, rerender } = render(<PageInboxIcon />)
    expect(container.querySelector('mask')).toBeNull()
    expect(container.querySelector('[fill="currentColor"]')).toBeNull()

    rerender(<PageInboxIcon active />)
    const mask = container.querySelector('mask')
    expect(mask).not.toBeNull()
    const solid = container.querySelector('g[fill="currentColor"]')
    expect(solid).toHaveAttribute('mask', `url(#${mask?.id})`)
  })

  it("prints today's day of month in the calendar", () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 2, 5, 12))

    const { container } = render(<PageCalendarIcon />)
    expect(container.querySelector('text')).toHaveTextContent(/^5$/)
  })
})
