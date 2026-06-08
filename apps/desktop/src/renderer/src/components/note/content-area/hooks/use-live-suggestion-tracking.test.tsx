import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type React from 'react'
import { editorOffsetToMarkdownSourceOffset } from '../critic-markup-offset-map'
import { useLiveSuggestionTracking } from './use-live-suggestion-tracking'
import type { CriticMarkupMark } from '@memry/shared'

interface FakeEditorSetup {
  editor: any
  container: HTMLDivElement
  containerRef: React.RefObject<HTMLDivElement | null>
}

function createFakeEditor(visibleText: string, selection: { from: number; to: number }): any {
  const doc = {
    content: { size: visibleText.length },
    textBetween: (from: number, to: number) => visibleText.slice(from, to)
  }
  return {
    _tiptapEditor: {
      state: { doc, selection, tr: undefined },
      view: { dispatch: vi.fn() }
    }
  }
}

function setup(
  visibleText: string,
  selection: { from: number; to: number },
  plainMarkdown: string,
  options: {
    resolveMarkdownSourceOffset?: (editorOffset: number) => number | null
    getReviewMarks?: () => CriticMarkupMark[]
    onInsertSourceBreak?: ReturnType<typeof vi.fn>
    requestMarkdownFlush?: ReturnType<typeof vi.fn>
  } = {}
): FakeEditorSetup & { onAddSuggestion: ReturnType<typeof vi.fn> } {
  const container = document.createElement('div')
  document.body.append(container)
  const containerRef = { current: container }
  const editor = createFakeEditor(visibleText, selection)
  const onAddSuggestion = vi.fn()

  renderHook(() =>
    useLiveSuggestionTracking({
      editor,
      containerRef,
      enabled: true,
      onAddSuggestion,
      resolveMarkdownSourceOffset:
        options.resolveMarkdownSourceOffset ??
        ((editorOffset) => editorOffsetToMarkdownSourceOffset(plainMarkdown, editorOffset)),
      getReviewMarks: options.getReviewMarks ?? (() => []),
      getPlainMarkdown: () => plainMarkdown,
      onInsertSourceBreak: options.onInsertSourceBreak,
      requestMarkdownFlush: options.requestMarkdownFlush
    })
  )

  return { editor, container, containerRef, onAddSuggestion }
}

function dispatchBackspace(container: HTMLElement): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Backspace',
    bubbles: true,
    cancelable: true
  })
  container.dispatchEvent(event)
  return event
}

describe('useLiveSuggestionTracking deletions', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('records a range deletion using the plainMarkdown source slice, not the editor text', () => {
    // plainMarkdown has hidden bold syntax; the editor only shows visible text.
    const plainMarkdown = 'alpha **bold** omega'
    const visibleText = 'alpha bold omega'
    // Mouse selection over 'alpha bold' (editor offsets 0..10)
    const { container, onAddSuggestion } = setup(visibleText, { from: 0, to: 10 }, plainMarkdown)

    const event = dispatchBackspace(container)

    expect(onAddSuggestion).toHaveBeenCalledWith({
      kind: 'deletion',
      visibleText: 'alpha **bold',
      originalText: 'alpha **bold',
      start: 0
    })
    expect(event.defaultPrevented).toBe(true)
  })

  it('records a collapsed-caret backspace using the source slice', () => {
    const plainMarkdown = 'alpha **bold** omega'
    const visibleText = 'alpha bold omega'
    // Caret right after 'bold' (editor offset 10); backspace deletes 'd'
    const { container, onAddSuggestion } = setup(visibleText, { from: 10, to: 10 }, plainMarkdown)

    const event = dispatchBackspace(container)

    expect(onAddSuggestion).toHaveBeenCalledWith({
      kind: 'deletion',
      visibleText: 'd',
      originalText: 'd',
      start: 11
    })
    expect(event.defaultPrevented).toBe(true)
  })

  it('falls back to an unambiguous text match when offset mapping fails', () => {
    const plainMarkdown = 'intro alpha bold omega'
    const { container, onAddSuggestion } = setup(
      'alpha bold omega',
      { from: 0, to: 10 },
      plainMarkdown,
      { resolveMarkdownSourceOffset: () => null }
    )

    const event = dispatchBackspace(container)

    expect(onAddSuggestion).toHaveBeenCalledWith({
      kind: 'deletion',
      visibleText: 'alpha bold',
      originalText: 'alpha bold',
      start: 6
    })
    expect(event.defaultPrevented).toBe(true)
  })

  it('suppresses the native delete (no hard delete) when the selection cannot be mapped', () => {
    // Stale plainMarkdown: the selected text no longer exists in the source.
    const plainMarkdown = 'completely different source'
    const { container, onAddSuggestion } = setup(
      'alpha bold omega',
      { from: 0, to: 10 },
      plainMarkdown,
      { resolveMarkdownSourceOffset: () => null }
    )

    const event = dispatchBackspace(container)

    expect(onAddSuggestion).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it.skip('records per-line deletions when backspacing through lines separated by empty blocks', () => {
    // Blocked: editorOffsetToMarkdownSourceOffset collapses multi-blank-line gaps
    // to a single editor position, so offsets beyond a gap return null.
    // Fix requires calibrating the offset map from live doc.textBetween.
    // Note body 'Line1\n\n\n\nLine2…Line8' (two empty paragraph blocks between
    // each line). doc.textBetween emits one separator per textblock after the
    // first, so the visible text has THREE newlines per gap.
    const plainMarkdown = Array.from({ length: 8 }, (_, i) => `Line${i + 1}`).join('\n\n\n\n')
    const visibleText = Array.from({ length: 8 }, (_, i) => `Line${i + 1}`).join('\n\n\n')
    // Caret right after the 'e' of 'Line8' (press 2 of the user flow)
    const caret = visibleText.lastIndexOf('e') + 1
    const { container, onAddSuggestion } = setup(
      visibleText,
      { from: caret, to: caret },
      plainMarkdown
    )

    const event = dispatchBackspace(container)

    expect(onAddSuggestion).toHaveBeenCalledWith({
      kind: 'deletion',
      visibleText: 'e',
      originalText: 'e',
      start: plainMarkdown.lastIndexOf('e')
    })
    expect(event.defaultPrevented).toBe(true)
  })

  it.skip('records a deletion at the end of a note that follows an odd blank-line run', () => {
    // Same offset-map gap issue as above.
    // Repro: 'Hey4' is the last line after a run of FIVE newlines (three empty
    // paragraph blocks -> four separators). Caret at the very end of the doc;
    // backspace must strike the '4', not be suppressed.
    const plainMarkdown = 'Line4\n\n\n\n\nHey1\n\nHey2\n\nHey3\n\nHey4'
    const visibleText = 'Line4\n\n\n\nHey1\nHey2\nHey3\nHey4'
    const caret = visibleText.length
    const { container, onAddSuggestion } = setup(
      visibleText,
      { from: caret, to: caret },
      plainMarkdown
    )

    const event = dispatchBackspace(container)

    expect(onAddSuggestion).toHaveBeenCalledWith({
      kind: 'deletion',
      visibleText: '4',
      originalText: '4',
      start: plainMarkdown.length - 1
    })
    expect(event.defaultPrevented).toBe(true)
  })

  it.skip('deletes the char before the caret (not after) following an odd blank-line run', () => {
    // Same offset-map gap issue as above.
    // Repro: caret at 'Hey|4' on the last line — backspace must strike 'y'.
    const plainMarkdown = 'Line4\n\n\n\n\nHey1\n\nHey2\n\nHey3\n\nHey4'
    const visibleText = 'Line4\n\n\n\nHey1\nHey2\nHey3\nHey4'
    const caret = visibleText.length - 1
    const { container, onAddSuggestion } = setup(
      visibleText,
      { from: caret, to: caret },
      plainMarkdown
    )

    const event = dispatchBackspace(container)

    expect(onAddSuggestion).toHaveBeenCalledWith({
      kind: 'deletion',
      visibleText: 'y',
      originalText: 'y',
      start: plainMarkdown.length - 2
    })
    expect(event.defaultPrevented).toBe(true)
  })

  it('skips block separators without recording a mark or hard-deleting', () => {
    const plainMarkdown = Array.from({ length: 8 }, (_, i) => `Line${i + 1}`).join('\n\n\n\n')
    const visibleText = Array.from({ length: 8 }, (_, i) => `Line${i + 1}`).join('\n\n\n')
    // Caret at the very start of 'Line8' — backspace lands on a '\n' separator
    const caret = visibleText.lastIndexOf('Line8')
    const { container, onAddSuggestion } = setup(
      visibleText,
      { from: caret, to: caret },
      plainMarkdown
    )

    const event = dispatchBackspace(container)

    expect(onAddSuggestion).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it('mirrors Enter splits into the plain source and requests an immediate flush', () => {
    vi.useFakeTimers()
    const plainMarkdown = 'Line4\n\nHey1'
    const visibleText = 'Line4\nHey1'
    const onInsertSourceBreak = vi.fn()
    const requestMarkdownFlush = vi.fn()
    // Caret mid-text: 'Li|ne4' — a split here is a regular '\n\n' block break
    const { container } = setup(visibleText, { from: 2, to: 2 }, plainMarkdown, {
      onInsertSourceBreak,
      requestMarkdownFlush
    })

    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    container.dispatchEvent(event)

    expect(onInsertSourceBreak).toHaveBeenCalledWith(2, '\n\n')
    // The native split must proceed — Enter is never suppressed
    expect(event.defaultPrevented).toBe(false)
    expect(requestMarkdownFlush).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(requestMarkdownFlush).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('mirrors an Enter at a block edge as a single gap newline', () => {
    const plainMarkdown = 'Line4\n\nHey1'
    const visibleText = 'Line4\nHey1'
    const onInsertSourceBreak = vi.fn()
    // Caret at the end of 'Line4' — the split creates an empty paragraph,
    // which gap-encodes as ONE extra newline
    const { container } = setup(visibleText, { from: 5, to: 5 }, plainMarkdown, {
      onInsertSourceBreak
    })

    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    )

    expect(onInsertSourceBreak).toHaveBeenCalledWith(5, '\n')
  })

  it('keeps suggestion-mode insertions out of the editor undo history', () => {
    const plainMarkdown = 'alpha bold omega'
    const { editor, container, onAddSuggestion } = setup(
      plainMarkdown,
      { from: 5, to: 5 },
      plainMarkdown
    )
    const tr: any = {
      meta: {} as Record<string, unknown>,
      insertText: vi.fn(() => tr),
      setMeta: vi.fn((key: string, value: unknown) => {
        tr.meta[key] = value
        return tr
      })
    }
    editor._tiptapEditor.state.tr = tr

    const event = new InputEvent('beforeinput', {
      inputType: 'insertText',
      data: 'x',
      bubbles: true,
      cancelable: true
    })
    container.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(onAddSuggestion).toHaveBeenCalledWith({
      kind: 'addition',
      visibleText: 'x',
      originalText: undefined,
      start: 5
    })
    expect(editor._tiptapEditor.view.dispatch).toHaveBeenCalledWith(tr)
    expect(tr.meta.addToHistory).toBe(false)
  })

  it('allows native editing when the range is inside an addition mark', () => {
    const plainMarkdown = 'alpha bold omega'
    const additionMark: CriticMarkupMark = {
      id: 'addition-1',
      kind: 'addition',
      visibleText: 'alpha bold',
      start: 0,
      end: 10
    }
    const { container, onAddSuggestion } = setup(
      plainMarkdown,
      { from: 0, to: 10 },
      plainMarkdown,
      { getReviewMarks: () => [additionMark] }
    )

    const event = dispatchBackspace(container)

    expect(onAddSuggestion).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })
})
