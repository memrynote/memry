import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BlockSideMenuController } from './block-side-menu'

const state = vi.hoisted(() => ({
  block: undefined as { id: string; type: string; content: unknown } | undefined
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => {
      const messages: Record<string, string> = {
        'editor.blockMenu.turnInto': 'Turn into',
        'editor.blockMenu.turnIntoTypes.paragraph': 'Text',
        'editor.blockMenu.colors': 'Colors',
        'editor.blockMenu.duplicate': 'Duplicate',
        'editor.blockMenu.insertTemplate': 'Insert template…',
        'editor.blockMenu.moveTo': 'Move to…',
        'editor.blockMenu.delete': 'Delete',
        'editor.blockMenu.comment': 'Comment'
      }
      return messages[key] ?? key
    }
  })
}))

vi.mock('@blocknote/core/extensions', () => ({ SideMenuExtension: { name: 'sideMenu' } }))

vi.mock('./review-formatting-toolbar', () => ({
  getEditorSelectionFromState: vi.fn(() => null),
  getProseMirrorState: vi.fn(() => null)
}))

vi.mock('@blocknote/react', () => ({
  BlockColorsItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  RemoveBlockItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SideMenu: ({ dragHandleMenu: DragHandleMenu }: { dragHandleMenu: React.FC }) => (
    <DragHandleMenu />
  ),
  SideMenuController: ({ sideMenu: SideMenuComponent }: { sideMenu: React.FC }) => (
    <SideMenuComponent />
  ),
  useBlockNoteEditor: () => ({ schema: { blockSchema: { paragraph: {} } } }),
  useComponentsContext: () => ({
    Generic: {
      Menu: {
        Root: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
        Trigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
        Dropdown: ({ children }: { children: React.ReactNode }) => (
          <div role="menu">{children}</div>
        ),
        Divider: () => <hr />,
        Item: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
          <button type="button" role="menuitem" onClick={onClick}>
            {children}
          </button>
        )
      }
    }
  }),
  useExtensionState: () => state.block
}))

function menuItemNames(): string[] {
  return screen.getAllByRole('menuitem').map((item) => item.textContent?.trim() ?? '')
}

describe('BlockSideMenuController insert template item', () => {
  beforeEach(() => {
    state.block = {
      id: 'block-1',
      type: 'paragraph',
      content: [{ type: 'text', text: 'Hovered line' }]
    }
  })

  it('sits between Duplicate and Move to in the menu', () => {
    render(<BlockSideMenuController onRequestMove={vi.fn()} onRequestInsertTemplate={vi.fn()} />)

    expect(menuItemNames()).toEqual([
      'Turn into',
      'Text',
      expect.stringMatching(/^Duplicate/),
      'Insert template…',
      'Move to…'
    ])
  })

  it('requests an insert anchored below the hovered block without consuming it', async () => {
    const onRequestInsertTemplate = vi.fn()
    render(<BlockSideMenuController onRequestInsertTemplate={onRequestInsertTemplate} />)

    await userEvent.click(screen.getByRole('menuitem', { name: 'Insert template…' }))

    expect(onRequestInsertTemplate).toHaveBeenCalledTimes(1)
    expect(onRequestInsertTemplate).toHaveBeenCalledWith({
      blockId: 'block-1',
      placement: 'after'
    })
  })

  it('is hidden when no handler is wired', () => {
    render(<BlockSideMenuController />)

    expect(screen.queryByRole('menuitem', { name: 'Insert template…' })).toBeNull()
  })

  it('is hidden when no block is hovered', () => {
    state.block = undefined
    render(<BlockSideMenuController onRequestInsertTemplate={vi.fn()} />)

    expect(screen.queryByRole('menuitem', { name: 'Insert template…' })).toBeNull()
  })
})
