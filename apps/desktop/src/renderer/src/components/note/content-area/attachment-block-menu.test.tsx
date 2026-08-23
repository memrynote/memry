/**
 * Tests for the attachment block menu (issue #1709): the "⋯" dropdown and the
 * right-click context menu that expose Reveal in Finder / Open in default app /
 * Copy path and the original + stored filename for a file block.
 */

import { useRef } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { fireEvent } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttachmentResolveResult } from '@memry/contracts/notes-api'
import { NoteFileUrlProvider } from './note-file-url-context'
import {
  AttachmentBlockContextMenu,
  AttachmentMenuButton,
  ImageHoverMenuButton,
  useImageHoverMenu
} from './attachment-block-menu'

const NOTE_ID = 'note-1'
const URL = '../attachments/note-1/k3f9x2-report.pdf'
const RESOLVED: AttachmentResolveResult = {
  absolutePath: '/vault/attachments/note-1/k3f9x2-report.pdf',
  storedFilename: 'k3f9x2-report.pdf',
  exists: true
}

const mocks = vi.hoisted(() => ({
  resolveAttachment: vi.fn(),
  revealAttachmentInFinder: vi.fn(),
  openAttachmentExternal: vi.fn(),
  clipboardWriteText: vi.fn()
}))

function renderWithProvider(ui: React.ReactNode) {
  return render(
    <NoteFileUrlProvider resolveFileUrl={async (url) => url} noteId={NOTE_ID}>
      {ui}
    </NoteFileUrlProvider>
  )
}

beforeEach(() => {
  mocks.resolveAttachment.mockReset().mockResolvedValue(RESOLVED)
  mocks.revealAttachmentInFinder.mockReset().mockResolvedValue(undefined)
  mocks.openAttachmentExternal.mockReset().mockResolvedValue(undefined)
  mocks.clipboardWriteText.mockReset().mockResolvedValue(undefined)

  const api = window.api as unknown as Record<string, unknown>
  api.notes = {
    ...((api.notes as Record<string, unknown>) ?? {}),
    resolveAttachment: mocks.resolveAttachment,
    revealAttachmentInFinder: mocks.revealAttachmentInFinder,
    openAttachmentExternal: mocks.openAttachmentExternal
  }
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: mocks.clipboardWriteText },
    configurable: true
  })
})

describe('AttachmentMenuButton', () => {
  it('opens on click, resolves the attachment, and shows both filenames', async () => {
    const user = userEvent.setup()
    renderWithProvider(<AttachmentMenuButton url={URL} name="report.pdf" />)

    await user.click(screen.getByRole('button', { name: 'File actions' }))

    await waitFor(() => {
      expect(mocks.resolveAttachment).toHaveBeenCalledWith(NOTE_ID, URL)
    })
    expect(await screen.findByText('report.pdf')).toBeInTheDocument()
    expect(await screen.findByText('Stored as k3f9x2-report.pdf')).toBeInTheDocument()
  })

  it('fires the reveal and open IPC calls with the raw block url', async () => {
    const user = userEvent.setup()
    renderWithProvider(<AttachmentMenuButton url={URL} name="report.pdf" />)

    await user.click(screen.getByRole('button', { name: 'File actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Reveal in Finder' }))
    expect(mocks.revealAttachmentInFinder).toHaveBeenCalledWith(NOTE_ID, URL)

    await user.click(screen.getByRole('button', { name: 'File actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Open in default app' }))
    expect(mocks.openAttachmentExternal).toHaveBeenCalledWith(NOTE_ID, URL)
  })

  it('copies the resolved absolute path to the clipboard', async () => {
    // userEvent.setup() installs its own clipboard stub and re-installs it
    // around every interaction — assert through it instead of a spy.
    const user = userEvent.setup()
    renderWithProvider(<AttachmentMenuButton url={URL} name="report.pdf" />)

    await user.click(screen.getByRole('button', { name: 'File actions' }))
    // The copy item stays disabled until the resolve result lands.
    await screen.findByText('Stored as k3f9x2-report.pdf')
    await user.click(screen.getByRole('menuitem', { name: 'Copy path' }))

    await waitFor(async () => {
      expect(await navigator.clipboard.readText()).toBe(RESOLVED.absolutePath)
    })
  })

  it('disables the actions and explains when the file is not on disk yet', async () => {
    mocks.resolveAttachment.mockResolvedValue({ ...RESOLVED, exists: false })
    const user = userEvent.setup()
    renderWithProvider(<AttachmentMenuButton url={URL} name="report.pdf" />)

    await user.click(screen.getByRole('button', { name: 'File actions' }))

    expect(await screen.findByText('Not synced to this device yet')).toBeInTheDocument()
    for (const label of ['Reveal in Finder', 'Open in default app', 'Copy path']) {
      expect(screen.getByRole('menuitem', { name: label })).toHaveAttribute('data-disabled')
    }
  })
})

function ImageHoverHarness({
  resolveImage
}: {
  resolveImage: (el: HTMLElement) => { url: string; name: string } | null
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { hoverTarget, handleMenuOpenChange } = useImageHoverMenu(containerRef, resolveImage)

  return (
    <div ref={containerRef} data-testid="editor-container">
      <div data-id="b1">
        <img alt="embedded pic" src="memry-file://local/x.png" />
      </div>
      <p>plain paragraph</p>
      {hoverTarget && (
        <ImageHoverMenuButton target={hoverTarget} onOpenChange={handleMenuOpenChange} />
      )}
    </div>
  )
}

describe('useImageHoverMenu + ImageHoverMenuButton', () => {
  const resolveImage = () => ({ url: URL, name: 'report.pdf' })

  it('shows the floating button while hovering an image and opens the menu from it', async () => {
    const user = userEvent.setup()
    renderWithProvider(<ImageHoverHarness resolveImage={resolveImage} />)

    fireEvent.mouseOver(screen.getByAltText('embedded pic'))
    const button = await screen.findByRole('button', { name: 'File actions' })

    await user.click(button)
    await waitFor(() => {
      expect(mocks.resolveAttachment).toHaveBeenCalledWith(NOTE_ID, URL)
    })
    expect(await screen.findByRole('menuitem', { name: 'Reveal in Finder' })).toBeInTheDocument()
    expect(await screen.findByText('Stored as k3f9x2-report.pdf')).toBeInTheDocument()
  })

  it('hides the button when the pointer moves off the image', async () => {
    renderWithProvider(<ImageHoverHarness resolveImage={resolveImage} />)

    fireEvent.mouseOver(screen.getByAltText('embedded pic'))
    await screen.findByRole('button', { name: 'File actions' })

    fireEvent.mouseOver(screen.getByText('plain paragraph'))
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'File actions' })).not.toBeInTheDocument()
    })
  })

  it('shows no button for an element that is not an image block', async () => {
    renderWithProvider(<ImageHoverHarness resolveImage={() => null} />)

    fireEvent.mouseOver(screen.getByAltText('embedded pic'))
    expect(screen.queryByRole('button', { name: 'File actions' })).not.toBeInTheDocument()
  })
})

describe('AttachmentBlockContextMenu', () => {
  it('opens the same menu on right-click over the wrapped block', async () => {
    renderWithProvider(
      <AttachmentBlockContextMenu url={URL} name="report.pdf">
        <div>block content</div>
      </AttachmentBlockContextMenu>
    )

    fireEvent.contextMenu(screen.getByText('block content'))

    expect(await screen.findByRole('menuitem', { name: 'Reveal in Finder' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Open in default app' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Copy path' })).toBeInTheDocument()
    await waitFor(() => {
      expect(mocks.resolveAttachment).toHaveBeenCalledWith(NOTE_ID, URL)
    })
    expect(await screen.findByText('Stored as k3f9x2-report.pdf')).toBeInTheDocument()
  })
})
