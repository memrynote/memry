import { act, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TabIdentityProvider } from '@/contexts/tabs/tab-identity'
import { publishActiveContext, runCommand, useEditorTarget, type EditorHandle } from '.'
import { resetCommandStoreForTests } from './store'
import { applyEditorAction, EDITOR_ACTIONS, useEditorCommands } from './use-editor-commands'

const mocks = vi.hoisted(() => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  toastError: vi.fn()
}))

vi.mock('@/lib/logger', () => ({ createLogger: () => mocks.logger }))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

function makeEditor(block: unknown = { id: 'block' }) {
  const domElement = document.createElement('div')
  const inner = document.createElement('span')
  inner.tabIndex = 0
  domElement.appendChild(inner)
  document.body.appendChild(domElement)
  return {
    toggleStyles: vi.fn(),
    getTextCursorPosition: vi.fn(() => ({ block })),
    updateBlock: vi.fn(),
    insertBlocks: vi.fn(),
    undo: vi.fn(() => true),
    redo: vi.fn(() => true),
    focus: vi.fn(),
    setTextCursorPosition: vi.fn(),
    insertInlineContent: vi.fn(),
    domElement,
    focusInside: () => {
      inner.focus()
    }
  } satisfies EditorHandle & { focusInside: () => void }
}

type TestEditor = ReturnType<typeof makeEditor>

function Editor({ editor }: { editor: TestEditor }): null {
  useEditorTarget(editor)
  return null
}

function Owner(): null {
  useEditorCommands()
  return null
}

const inTab = (tabId: string, node: ReactNode): ReactNode => (
  <TabIdentityProvider tabId={tabId} groupId={`group-${tabId}`}>
    {node}
  </TabIdentityProvider>
)

beforeEach(() => {
  resetCommandStoreForTests()
  vi.clearAllMocks()
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('applyEditorAction', () => {
  const act_ = (editor: TestEditor, id: keyof typeof EDITOR_ACTIONS) =>
    applyEditorAction(editor, EDITOR_ACTIONS[id])

  it('toggles inline styles without needing a block', () => {
    const editor = makeEditor()
    editor.getTextCursorPosition.mockReturnValue(undefined as never)
    expect(act_(editor, 'editor.bold')).toBe(true)
    expect(editor.toggleStyles).toHaveBeenCalledWith({ bold: true })
  })

  it('offers every heading level the editor supports, 1 through 6', () => {
    for (const level of [1, 2, 3, 4, 5, 6] as const) {
      const block = { id: `h${level}` }
      const editor = makeEditor(block)
      expect(act_(editor, `editor.heading${level}`)).toBe(true)
      expect(editor.updateBlock).toHaveBeenCalledWith(block, { type: 'heading', props: { level } })
    }
  })

  it('converts the current block to a bullet list', () => {
    const block = { id: 'b2' }
    const editor = makeEditor(block)
    act_(editor, 'editor.insertBulletList')
    expect(editor.updateBlock).toHaveBeenCalledWith(block, { type: 'bulletListItem' })
  })

  it('inserts a fresh table block after the cursor', () => {
    const block = { id: 'b3' }
    const editor = makeEditor(block)
    expect(act_(editor, 'editor.insertTable')).toBe(true)
    const [blocks, ref, placement] = editor.insertBlocks.mock.calls[0]
    expect((blocks[0] as { type: string }).type).toBe('table')
    expect(ref).toBe(block)
    expect(placement).toBe('after')
  })

  it('returns false when no block is focused for a block command', () => {
    const editor = makeEditor()
    editor.getTextCursorPosition.mockReturnValue(undefined as never)
    expect(act_(editor, 'editor.heading1')).toBe(false)
    expect(editor.updateBlock).not.toHaveBeenCalled()
  })
})

describe('editor commands target the active pane', () => {
  it('formats the editor of the active tab, not the last one mounted', async () => {
    const first = makeEditor()
    const second = makeEditor()
    render(
      <>
        <Owner />
        {inTab('tab-a', <Editor editor={first} />)}
        {inTab('tab-b', <Editor editor={second} />)}
      </>
    )

    act(() => {
      publishActiveContext({ activeTabId: 'tab-a', activeGroupId: 'g' })
    })
    await expect(runCommand('editor.bold', 'menu')).resolves.toBe('ran')
    expect(first.toggleStyles).toHaveBeenCalledWith({ bold: true })
    expect(second.toggleStyles).not.toHaveBeenCalled()

    act(() => {
      publishActiveContext({ activeTabId: 'tab-b', activeGroupId: 'g' })
    })
    await runCommand('editor.insertTable', 'menu')
    expect(second.insertBlocks).toHaveBeenCalledTimes(1)
    expect(first.insertBlocks).not.toHaveBeenCalled()
  })

  it('picks the editor focused last when a tab holds several', async () => {
    const top = makeEditor()
    const bottom = makeEditor()
    render(
      <>
        <Owner />
        {inTab(
          'journal',
          <>
            <Editor editor={top} />
            <Editor editor={bottom} />
          </>
        )}
      </>
    )
    act(() => {
      publishActiveContext({ activeTabId: 'journal', activeGroupId: 'g' })
    })

    // Neither was focused: the most recently mounted one wins.
    await runCommand('editor.italic', 'menu')
    expect(bottom.toggleStyles).toHaveBeenCalledWith({ italic: true })

    act(() => {
      top.focusInside()
    })
    await runCommand('editor.code', 'menu')
    expect(top.toggleStyles).toHaveBeenCalledWith({ code: true })
    expect(bottom.toggleStyles).toHaveBeenCalledTimes(1)
  })

  it('is unavailable in a tab without an editor, and again once its editor unmounts', async () => {
    const editor = makeEditor()
    const { rerender } = render(
      <>
        <Owner />
        {inTab('tab-a', <Editor editor={editor} />)}
      </>
    )
    act(() => {
      publishActiveContext({ activeTabId: 'tab-b', activeGroupId: 'g' })
    })
    await expect(runCommand('editor.bold', 'menu')).resolves.toBe('unavailable')

    act(() => {
      publishActiveContext({ activeTabId: 'tab-a', activeGroupId: 'g' })
    })
    await expect(runCommand('editor.bold', 'menu')).resolves.toBe('ran')

    rerender(<Owner />)
    await expect(runCommand('editor.bold', 'menu')).resolves.toBe('unavailable')
  })
})

describe('undo and redo', () => {
  const originalExecCommand = document.execCommand

  afterEach(() => {
    document.execCommand = originalExecCommand
  })

  function renderEditor(editor: TestEditor): void {
    render(
      <>
        <Owner />
        {inTab('tab-a', <Editor editor={editor} />)}
      </>
    )
  }

  it('routes undo and redo to the editor history while focus is inside it', async () => {
    const editor = makeEditor()
    renderEditor(editor)
    editor.focusInside()

    await runCommand('editor.undo', 'menu')
    expect(editor.undo).toHaveBeenCalledTimes(1)
    await runCommand('editor.redo', 'menu')
    expect(editor.redo).toHaveBeenCalledTimes(1)
  })

  it('leaves the editor history alone when focus is outside it', async () => {
    const editor = makeEditor()
    renderEditor(editor)
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()

    await runCommand('editor.undo', 'menu')
    expect(editor.undo).not.toHaveBeenCalled()
  })

  it('keeps native undo for focused inputs and textareas, with no editor mounted', async () => {
    const execCommand = vi.fn()
    document.execCommand = execCommand
    render(<Owner />)

    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    await expect(runCommand('editor.undo', 'menu')).resolves.toBe('ran')
    expect(execCommand).toHaveBeenCalledWith('undo')

    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    textarea.focus()
    await runCommand('editor.redo', 'menu')
    expect(execCommand).toHaveBeenCalledWith('redo')
  })

  it('gives other contenteditable surfaces the native command', async () => {
    const editor = makeEditor()
    renderEditor(editor)
    const execCommand = vi.fn()
    document.execCommand = execCommand

    const composer = document.createElement('div')
    composer.tabIndex = 0
    Object.defineProperty(composer, 'isContentEditable', { value: true })
    document.body.appendChild(composer)
    composer.focus()

    await runCommand('editor.undo', 'menu')
    expect(execCommand).toHaveBeenCalledWith('undo')
    expect(editor.undo).not.toHaveBeenCalled()
  })

  it('reports an editor that throws instead of crashing the menu', async () => {
    const editor = makeEditor()
    editor.undo.mockImplementation(() => {
      throw new Error('not ready')
    })
    renderEditor(editor)
    editor.focusInside()

    await expect(runCommand('editor.undo', 'menu')).resolves.toBe('failed')
    expect(mocks.logger.error).toHaveBeenCalled()
  })
})
