import { BlockNoteEditor, type PartialBlock } from '@blocknote/core'
import { BlockNoteView } from '@blocknote/shadcn'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { commands } from '../../../../../generated/bindings'
import { installExternalLinkGuard, openLink } from '@/lib/external-link-guard'
import { InboxContentEditor } from '@/components/inbox-detail/inbox-content-editor'
import { TaskDescriptionEditor } from '@/components/tasks/task-description-editor'
import { EDITOR_LINKS, EditorFormattingToolbar, useEditorLinkClicks } from './editor-links'

let opened: ReturnType<typeof vi.spyOn>
let stopGuard: () => void
beforeEach(() => {
  opened = vi.spyOn(commands, 'shellOpenLink').mockResolvedValue(null)
  // The guard runs in the app: it follows any link click no handler claimed.
  stopGuard = installExternalLinkGuard()
})
afterEach(() => {
  stopGuard()
  opened.mockRestore()
})

/** The guard follows after the dispatch. */
const afterDispatch = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * A person's click on `anchor`: ProseMirror runs BlockNote's `links.onClick` on mouseup, then the
 * click reaches the DOM. jsdom has no layout, so the point resolves to the anchor's text.
 */
async function clickLink(anchor: HTMLAnchorElement): Promise<void> {
  const text = anchor.firstChild ?? anchor
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(anchor)
  Object.assign(document, {
    caretRangeFromPoint: () => {
      const range = document.createRange()
      range.setStart(text, 1)
      range.collapse(true)
      return range
    }
  })
  const init = { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5, detail: 1 }
  try {
    fireEvent.mouseDown(anchor, init)
    fireEvent.mouseUp(anchor, init)
    fireEvent.click(anchor, init)
    await afterDispatch()
  } finally {
    vi.mocked(document.elementFromPoint).mockRestore()
    Reflect.deleteProperty(document, 'caretRangeFromPoint')
  }
}

function Editor({ content }: { content: PartialBlock[] }): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  useEditorLinkClicks(container)
  const [editor] = useState(() =>
    BlockNoteEditor.create({ links: EDITOR_LINKS, initialContent: content })
  )
  return (
    <div ref={container}>
      <BlockNoteView editor={editor} formattingToolbar={false}>
        <EditorFormattingToolbar />
      </BlockNoteView>
    </div>
  )
}

const anchor = async (): Promise<HTMLAnchorElement> => {
  const found = await waitFor(() => {
    const link = document.querySelector<HTMLAnchorElement>('.bn-editor a[href]')
    if (!link) throw new Error('no link yet')
    return link
  })
  return found
}

describe('an editor link click', () => {
  // BBF-112: BlockNote opened on mouseup and the guard followed the raw href on click, so a
  // titled link opened twice, once with its title in the URL.
  it('opens a titled link once, by its address', async () => {
    render(
      <Editor
        content={[
          {
            type: 'paragraph',
            content: [{ type: 'link', href: 'https://e.com/x "T"', content: 'site' }]
          }
        ]}
      />
    )
    await clickLink(await anchor())
    expect(opened.mock.calls).toEqual([['https://e.com/x']])
  })

  it.each([
    ['the inbox editor', () => <InboxContentEditor initialContent="[site](https://e.com/x)" />],
    [
      'the task description',
      () => <TaskDescriptionEditor initialContent="[site](https://e.com/x)" />
    ]
  ])('opens a link in %s once', async (_name, Surface) => {
    render(<Surface />)
    await clickLink(await anchor())
    expect(opened.mock.calls).toEqual([['https://e.com/x']])
  })
})

/** A whiteboard in an editor: Excalidraw's link claims its click and `onLinkOpen` opens it. */
function Whiteboard(): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  useEditorLinkClicks(container)
  return (
    <div ref={container}>
      <div data-content-type="whiteboard">
        <a
          href="https://e.com/board"
          onClick={(event) => {
            event.preventDefault()
            openLink('https://e.com/board')
          }}
        >
          board link
        </a>
      </div>
    </div>
  )
}

describe('a whiteboard link click', () => {
  // canvas-note-body and agent-diff-body listen on their whole container, which holds any board.
  it('is left to the board, which opens it once', async () => {
    render(<Whiteboard />)
    fireEvent.click(screen.getByText('board link'))
    await afterDispatch()
    expect(opened.mock.calls).toEqual([['https://e.com/board']])
  })
})

describe('the formatting toolbar', () => {
  // BlockNote's FileDownloadButton calls window.open, which opens nothing on macOS (#3675).
  it("downloads a file block's file through the shell", async () => {
    const url = 'memry-file://local/v/attachments/a.png'
    render(<Editor content={[{ type: 'image', props: { url, name: 'a.png' } }]} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Download image' }))
    await waitFor(() => expect(opened.mock.calls).toEqual([[url]]))
  })
})
