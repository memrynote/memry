// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'

import { BlockNoteEditor, defaultProps } from '@blocknote/core'
import { serializeBlockAlignMarker, sidecarMarkerLines } from '@memry/shared/block-markers'

import { createMobileEditorSchema } from '../../editor-web/src/schema'
import { runStyleAction, type StyleEditorSurface } from '../../editor-web/src/block-styles'
/**
 * Alignment, colour and nesting in the guest (#2102).
 *
 * The point of these assertions is the WIRE, not the widget: mobile has to
 * write the props and styles desktop already reads, so a note styled on a
 * phone opens on a desktop that predates this panel.
 */

function editor() {
  return BlockNoteEditor.create({ schema: createMobileEditorSchema() })
}

/** `runStyleAction` takes the narrow surface; a real editor satisfies it. */
function surface(instance: ReturnType<typeof editor>): StyleEditorSurface {
  return instance as unknown as StyleEditorSurface
}

/** The inline styles the first run of the first block carries on disk. */
function styles(instance: ReturnType<typeof editor>): Record<string, unknown> {
  const content = instance.document[0].content as { styles: Record<string, unknown> }[]
  return content[0].styles
}

describe('style actions against a real editor', () => {
  it('writes the same textAlignment prop desktop reads back', () => {
    const instance = editor()
    instance.replaceBlocks(instance.document, [{ type: 'paragraph', content: 'Centred' }])
    instance.setTextCursorPosition(instance.document[0])

    runStyleAction(surface(instance), { kind: 'align', alignment: 'center' })

    const block = instance.document[0]
    // The prop mobile writes is BlockNote's own default prop — the exact one
    // desktop's `TextAlignButton` reads and writes.
    expect('textAlignment' in defaultProps).toBe(true)
    expect(block.props).toMatchObject({ textAlignment: 'center' })
    // And it is the value the shared markdown marker serializes, so the note
    // on disk is byte-identical to one centred on desktop.
    const marked = block as unknown as { props: Record<string, unknown>; content: unknown }
    expect(serializeBlockAlignMarker(marked.props)).toBe('<!-- align:center -->')
    expect(sidecarMarkerLines(marked as Parameters<typeof sidecarMarkerLines>[0])).toEqual([
      '<!-- align:center -->'
    ])
  })

  it('leaves a block with no textAlignment prop untouched', () => {
    const instance = editor()
    instance.replaceBlocks(instance.document, [{ type: 'divider' }])
    instance.setTextCursorPosition(instance.document[0])
    const before = { ...instance.document[0].props }

    runStyleAction(surface(instance), { kind: 'align', alignment: 'right' })

    expect(instance.document[0].props).toEqual(before)
  })

  it('adds a palette colour as a style and clears it with default', () => {
    const instance = editor()
    instance.replaceBlocks(instance.document, [
      { type: 'paragraph', content: 'Text' },
      { type: 'paragraph', content: 'More' }
    ])
    // A range, not a caret: a collapsed selection only ever produces stored
    // marks, which need a mounted view to survive.
    instance.setSelection(instance.document[0].id, instance.document[1].id)

    runStyleAction(surface(instance), { kind: 'text-colour', colour: 'red' })
    runStyleAction(surface(instance), { kind: 'background-colour', colour: 'yellow' })
    expect(styles(instance)).toEqual({ textColor: 'red', backgroundColor: 'yellow' })

    runStyleAction(surface(instance), { kind: 'text-colour', colour: 'default' })
    // Removed, not set to the string `default`: an explicit `default` would
    // write a colour marker for a run nobody coloured.
    expect(styles(instance)).toEqual({ backgroundColor: 'yellow' })
  })

  it('nests and unnests through the editor commands Tab already runs', () => {
    const instance = editor()
    instance.replaceBlocks(instance.document, [
      { type: 'bulletListItem', content: 'One' },
      { type: 'bulletListItem', content: 'Two' }
    ])
    instance.setTextCursorPosition(instance.document[1])

    expect(instance.canNestBlock()).toBe(true)
    runStyleAction(surface(instance), { kind: 'nest' })

    expect(instance.document).toHaveLength(1)
    expect(instance.document[0].children).toHaveLength(1)

    instance.setTextCursorPosition(instance.document[0].children[0])
    runStyleAction(surface(instance), { kind: 'unnest' })

    expect(instance.document).toHaveLength(2)
    expect(instance.document[0].children).toHaveLength(0)
  })

  it('does nothing when the caret cannot be nested any further', () => {
    const instance = editor()
    instance.replaceBlocks(instance.document, [{ type: 'paragraph', content: 'Only' }])
    instance.setTextCursorPosition(instance.document[0])
    const before = instance.document.length

    expect(instance.canNestBlock()).toBe(false)
    runStyleAction(surface(instance), { kind: 'nest' })
    runStyleAction(surface(instance), { kind: 'unnest' })

    expect(instance.document).toHaveLength(before)
  })
})
