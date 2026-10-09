import { describe, it, expect, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { HugeIconByName } from './hugeicon-renderer'

vi.mock('@hugeicons/core-free-icons', () => ({
  UserIcon: [['path', { d: 'M1 1', 'data-icon': 'user' }]],
  Building03Icon: [['path', { d: 'M2 2', 'data-icon': 'building' }]]
}))

describe('HugeIconByName', () => {
  it('draws the new icon when a mounted icon is handed another name', async () => {
    const { container, rerender } = render(<HugeIconByName name="Building03Icon" />)
    await waitFor(() => expect(container.querySelector('[data-icon=building]')).not.toBeNull())

    rerender(<HugeIconByName name="UserIcon" />)
    await waitFor(() => expect(container.querySelector('[data-icon=user]')).not.toBeNull())
    expect(container.querySelector('[data-icon=building]')).toBeNull()

    // Both are cached now: switching back is synchronous and still follows the name.
    rerender(<HugeIconByName name="Building03Icon" />)
    expect(container.querySelector('[data-icon=building]')).not.toBeNull()
  })
})
