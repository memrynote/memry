import type { ReactNode } from 'react'
import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { publishActiveContext, runCommand } from '@/commands'
import { resetCommandStoreForTests } from '@/commands/store'
import { TabIdentityProvider } from '@/contexts/tabs/tab-identity'
import { CanvasCommandOwner } from './canvas-command-owner'

const mount = (props: Parameters<typeof CanvasCommandOwner>[0]): ReactNode => (
  <TabIdentityProvider tabId="t" groupId="group">
    <CanvasCommandOwner {...props} />
  </TabIdentityProvider>
)

beforeEach(() => {
  resetCommandStoreForTests()
})

describe('canvas commands', () => {
  it('open the card picker, the layout dialog and the link picker the board opens', async () => {
    const openAddCard = vi.fn()
    const openLayout = vi.fn()
    const openLinkPicker = vi.fn()
    render(mount({ openAddCardRef: { current: openAddCard }, openLayout, openLinkPicker }))
    act(() => {
      publishActiveContext({ activeTabId: 't', activeGroupId: 'group' })
    })

    await runCommand('canvas.addCard', 'palette')
    await runCommand('canvas.layoutByProperty', 'palette')
    await runCommand('canvas.linkToItem', 'palette')
    expect(openAddCard).toHaveBeenCalledTimes(1)
    expect(openLayout).toHaveBeenCalledTimes(1)
    expect(openLinkPicker).toHaveBeenCalledTimes(1)
  })

  it('does nothing for Add card before the layer has published its opener', async () => {
    render(
      mount({ openAddCardRef: { current: null }, openLayout: vi.fn(), openLinkPicker: vi.fn() })
    )
    act(() => {
      publishActiveContext({ activeTabId: 't', activeGroupId: 'group' })
    })

    await expect(runCommand('canvas.addCard', 'palette')).resolves.toBe('ran')
  })
})
