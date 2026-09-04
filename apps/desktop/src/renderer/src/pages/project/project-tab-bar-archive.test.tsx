/**
 * The inbox is never archivable — `archiveProject` throws
 * `Cannot archive the inbox project` at the data layer. Production telemetry
 * had users reaching that throw, which means the menu offered an action the
 * app was always going to refuse. The guard stays; the affordance goes.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProjectTabBar } from './project-tab-bar'

const props = {
  active: 'overview' as const,
  onChange: vi.fn(),
  counts: { tasks: 0, notes: 0, files: 0, events: 0 },
  railOpen: false,
  onToggleRail: vi.fn(),
  onEdit: vi.fn(),
  onArchive: vi.fn()
}

async function openMenu(): Promise<void> {
  const user = userEvent.setup()
  const triggers = screen.getAllByRole('button')
  await user.click(triggers[triggers.length - 1])
}

describe('ProjectTabBar archive affordance', () => {
  it('offers archive for an ordinary project', async () => {
    render(<ProjectTabBar {...props} canArchive={true} />)
    await openMenu()

    const item = await screen.findByRole('menuitem', { name: /archive/i })
    expect(item).not.toHaveAttribute('aria-disabled', 'true')
  })

  it('disables archive for the inbox rather than letting it throw', async () => {
    const onArchive = vi.fn()
    render(<ProjectTabBar {...props} onArchive={onArchive} canArchive={false} />)
    await openMenu()

    const item = await screen.findByRole('menuitem', { name: /archive/i })
    expect(item).toHaveAttribute('aria-disabled', 'true')

    await userEvent.setup().click(item)
    expect(onArchive).not.toHaveBeenCalled()
  })
})
