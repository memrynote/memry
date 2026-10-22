import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { PortalHost } from './portal-api'
import { PortalWhereUsedPopover } from './portal-where-used-popover'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => key.replace('portalFlows.whereUsed.', '')
  })
}))

const portal: PortalHost = {
  noteId: 'lab',
  title: 'Lab 4',
  path: 'Labs/Lab 4.md',
  count: 1,
  kind: 'portal'
}
const link: PortalHost = {
  noteId: 'exam',
  title: 'Exam prep',
  path: 'Exam prep.md',
  count: 1,
  kind: 'link'
}

function setup(hosts: PortalHost[]) {
  const onOpenHost = vi.fn()
  const anchor = document.createElement('button')
  document.body.appendChild(anchor)
  render(
    <PortalWhereUsedPopover
      anchorEl={anchor}
      hosts={hosts}
      onOpenHost={onOpenHost}
      onClose={vi.fn()}
    />
  )
  return { onOpenHost }
}

describe('PortalWhereUsedPopover', () => {
  it('lists portals and links as separate counted sections with their paths', () => {
    setup([portal, link])
    const portals = screen.getByRole('region', { name: 'portals' })
    const links = screen.getByRole('region', { name: 'links' })
    expect(within(portals).getByText('1')).toBeTruthy()
    expect(within(portals).getByText('Labs/Lab 4.md')).toBeTruthy()
    expect(within(links).getByText('Exam prep.md')).toBeTruthy()
  })

  it('omits an empty section', () => {
    setup([link])
    expect(screen.queryByRole('region', { name: 'portals' })).toBeNull()
  })

  it('opens on Enter, opens beside on Shift+Enter and Shift+click', async () => {
    const user = userEvent.setup()
    const { onOpenHost } = setup([portal, link])
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-where-used-row]'))
    await waitFor(() => expect(document.activeElement).toBe(rows[0]))

    await user.keyboard('{Enter}')
    expect(onOpenHost).toHaveBeenLastCalledWith(portal, { beside: false })

    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(rows[1])
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    expect(onOpenHost).toHaveBeenLastCalledWith(link, { beside: true })

    await user.keyboard('{Shift>}')
    await user.click(rows[0])
    await user.keyboard('{/Shift}')
    expect(onOpenHost).toHaveBeenLastCalledWith(portal, { beside: true })
  })
})
