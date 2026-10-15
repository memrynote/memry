/**
 * A tag rename rewrites an open note's chips AFTER the tag maps have already
 * moved on. The chip then carries `tag: new` with the old tag's stored color
 * and icon, and nothing re-styles it until the editor reloads (#3051).
 */

import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'

vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))
vi.mock('@/lib/url-metadata', () => ({
  fetchLinkPreview: vi.fn().mockResolvedValue({ domain: '', title: '', favicon: '' })
}))
vi.mock('@/hooks/use-sidebar-navigation', () => ({
  useSidebarNavigation: () => ({ openSidebarItem: vi.fn() })
}))

import { editorSchema } from '../editor-schema'
import { useTagSuggestions } from './use-tag-suggestions'

const mounted: Array<{ editor: BlockNoteEditor; el: HTMLElement }> = []

afterEach(() => {
  for (const { editor, el } of mounted.splice(0)) {
    editor.unmount()
    el.remove()
  }
})

function chipBlock(tag: string, color: string, icon: string) {
  return {
    type: 'paragraph',
    content: [{ type: 'hashTag', props: { tag, color, icon } }]
  }
}

function chipProps(editor: BlockNoteEditor): Record<string, string> {
  const content = (
    editor.document[0] as unknown as { content: Array<{ props: Record<string, string> }> }
  ).content
  return content[0].props
}

describe('useTagSuggestions chip styling', () => {
  it('re-styles a chip whose tag was renamed after the maps updated', () => {
    const editor = BlockNoteEditor.create({
      schema: editorSchema,
      initialContent: [chipBlock('old', 'red', 'emoji') as never]
    }) as unknown as BlockNoteEditor
    const el = document.createElement('div')
    document.body.appendChild(el)
    editor.mount(el)
    mounted.push({ editor, el })

    const containerRef = { current: el as HTMLDivElement }
    const { rerender } = renderHook(
      (maps: { color: Map<string, string>; icon: Map<string, string> }) =>
        useTagSuggestions({
          editor,
          editorContainerRef: containerRef,
          tagColorMap: maps.color,
          tagIconMap: maps.icon
        }),
      { initialProps: { color: new Map([['old', 'red']]), icon: new Map([['old', 'emoji']]) } }
    )

    // Rename `old` -> `new`: the tag data refreshes first...
    rerender({ color: new Map([['new', 'blue']]), icon: new Map() })
    // ...then the note body arrives with the renamed chip still holding old style.
    editor.replaceBlocks(editor.document, [chipBlock('new', 'red', 'emoji') as never])

    expect(chipProps(editor)).toMatchObject({ tag: 'new', color: 'blue', icon: '' })
  })
})
