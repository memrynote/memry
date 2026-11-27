import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TitleInput } from '@/components/note/note-title/TitleInput'
import { installImeCompositionGuard } from './ime-composition-guard'

describe('installImeCompositionGuard', () => {
  let uninstall: () => void
  beforeEach(() => {
    uninstall = installImeCompositionGuard(window)
  })
  afterEach(() => uninstall())

  // #5571: Enter while the Korean IME still composes the last syllable.
  it('keeps a field from acting on Enter until the IME commits', () => {
    const onChange = vi.fn()
    render(<TitleInput value="New note" fresh onChange={onChange} />)
    const title = screen.getByRole('textbox')
    title.focus()

    fireEvent.change(title, { target: { value: '이것은 제목입니' } })
    fireEvent.keyDown(title, { key: 'Enter', isComposing: true, keyCode: 229 })
    expect(title).toHaveFocus()
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.change(title, { target: { value: '이것은 제목입니다' } })
    fireEvent.keyDown(title, { key: 'Enter', keyCode: 13 })
    expect(title).not.toHaveFocus()
    expect(onChange).toHaveBeenCalledExactlyOnceWith('이것은 제목입니다')
  })

  // WebKit (Tauri on macOS and Linux) sends the Enter that commits a Japanese
  // conversion after compositionend, as keyCode 229 with isComposing false.
  it('keeps a field from acting on the Enter that WebKit sends after the commit', () => {
    const onChange = vi.fn()
    render(<TitleInput value="New note" fresh onChange={onChange} />)
    const title = screen.getByRole('textbox')
    title.focus()

    fireEvent.change(title, { target: { value: '日本語' } })
    fireEvent.keyDown(title, { key: 'Enter', isComposing: false, keyCode: 229 })
    expect(title).toHaveFocus()

    fireEvent.keyDown(title, { key: 'Enter', keyCode: 13 })
    expect(onChange).toHaveBeenCalledExactlyOnceWith('日本語')
  })

  it('leaves composing keys to contenteditable editors', () => {
    const editor = document.createElement('div')
    editor.contentEditable = 'true'
    document.body.append(editor)
    const onKeyDown = vi.fn()
    editor.addEventListener('keydown', onKeyDown)

    fireEvent.keyDown(editor, { key: 'Enter', isComposing: true, keyCode: 229 })
    expect(onKeyDown).toHaveBeenCalledOnce()
    editor.remove()
  })
})
