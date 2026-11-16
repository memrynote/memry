import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { COLOR_NAMES, defaultTagColorName } from '@memry/contracts/tag-colors'

import { TagOverflowMenu } from './tag-overflow-menu'

const mocks = vi.hoisted(() => ({ updateTagColor: vi.fn() }))

vi.mock('@memry/i18n/renderer', () => ({ useT: () => ({ t: (key: string) => key }) }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/services/tags-service', () => ({
  tagsService: { updateTagColor: mocks.updateTagColor }
}))

vi.mock('@/components/ui/dropdown-menu', () => {
  const passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  return {
    DropdownMenu: passthrough,
    DropdownMenuTrigger: passthrough,
    DropdownMenuContent: passthrough,
    DropdownMenuItem: passthrough,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuSub: passthrough,
    DropdownMenuSubTrigger: passthrough,
    DropdownMenuSubContent: passthrough
  }
})

const tag = 'work'
const fallback = defaultTagColorName(tag)
const minted = COLOR_NAMES.find((name) => name !== fallback) ?? ''
const other = COLOR_NAMES.find((name) => name !== fallback && name !== minted) ?? ''

function shown(color: string): void {
  render(
    <TagOverflowMenu tag={tag} color={color} onRequestRename={vi.fn()} onRequestDelete={vi.fn()} />
  )
}

describe('TagOverflowMenu colour swatches', () => {
  beforeEach(() => {
    mocks.updateTagColor.mockReset().mockResolvedValue({ success: true })
  })

  it('writes nothing for the colour a definition holds, as Electron', async () => {
    shown(minted)
    fireEvent.click(screen.getByRole('button', { name: minted }))
    fireEvent.click(screen.getByRole('button', { name: other }))
    await waitFor(() => expect(mocks.updateTagColor).toHaveBeenCalledTimes(1))
    expect(mocks.updateTagColor).toHaveBeenCalledWith({ tag, color: other })
  })

  // #4678: a tag the index has not minted yet shows its name's default colour.
  it("writes the name's default colour picked while it is shown", async () => {
    shown(fallback)
    fireEvent.click(screen.getByRole('button', { name: fallback }))
    await waitFor(() => expect(mocks.updateTagColor).toHaveBeenCalledWith({ tag, color: fallback }))
  })
})
