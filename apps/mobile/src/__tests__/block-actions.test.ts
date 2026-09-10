// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'

import { BlockNoteEditor } from '@blocknote/core'

import { createMobileEditorSchema } from '../../editor-web/src/schema'
import {
  runBlockAction,
  stripBlockIds,
  type BlockActionEditorSurface
} from '../../editor-web/src/block-actions'

/**
 * Colour, Duplicate and Delete against a real editor (#2100).
 *
 * The point of these assertions is the WIRE, not the widget. Block colour is a
 * PROP, not an inline mark, so it has to land where desktop's `BlockColorsItem`
 * puts it; and a block reset to `default` on a phone has to come out
 * indistinguishable from one nobody ever coloured, or the reset is a colour
 * every other device still reads.
 */

function editor() {
  return BlockNoteEditor.create({ schema: createMobileEditorSchema() })
}

/** `runBlockAction` takes the narrow surface; a real editor satisfies it. */
function surface(instance: ReturnType<typeof editor>): BlockActionEditorSurface {
  return instance as unknown as BlockActionEditorSurface
}

/** The inline styles the first run of a block carries on disk. */
function runStyles(block: unknown): Record<string, unknown> {
  const content = (block as { content: { styles: Record<string, unknown> }[] }).content
  return content[0].styles
}

describe('block actions against a real editor', () => {
  it('writes colour as a block PROP, not as a mark on the text', () => {
    const instance = editor()
    instance.replaceBlocks(instance.document, [{ type: 'paragraph', content: 'Text' }])
    const id = instance.document[0].id

    runBlockAction(surface(instance), id, { kind: 'colour', slot: 'text', colour: 'red' })
    runBlockAction(surface(instance), id, {
      kind: 'colour',
      slot: 'background',
      colour: 'yellow'
    })

    expect(instance.document[0].props).toMatchObject({
      textColor: 'red',
      backgroundColor: 'yellow'
    })
    // The run itself is untouched: the style panel colours TEXT, this colours
    // the BLOCK, and the two must not quietly become the same thing.
    expect(runStyles(instance.document[0])).toEqual({})
  })

  it('keeps the panel open after a colour and closes after duplicate or delete', () => {
    const instance = editor()
    instance.replaceBlocks(instance.document, [{ type: 'paragraph', content: 'Text' }])
    const id = instance.document[0].id

    expect(
      runBlockAction(surface(instance), id, { kind: 'colour', slot: 'text', colour: 'blue' })
    ).toEqual({ status: 'applied', keepOpen: true })
    expect(runBlockAction(surface(instance), id, { kind: 'duplicate' })).toEqual({
      status: 'applied',
      keepOpen: false
    })
  })

  it('serializes a block reset to default exactly like one never coloured', () => {
    const instance = editor()
    instance.replaceBlocks(instance.document, [
      { type: 'paragraph', content: 'Never coloured' },
      { type: 'paragraph', content: 'Never coloured' }
    ])
    const [virgin, subject] = instance.document
    const expected = instance.blocksToMarkdownLossy([virgin])
    const virginProps = { ...virgin.props }

    runBlockAction(surface(instance), subject.id, {
      kind: 'colour',
      slot: 'text',
      colour: 'red'
    })
    runBlockAction(surface(instance), subject.id, {
      kind: 'colour',
      slot: 'background',
      colour: 'green'
    })
    // BlockNote's markdown serializer drops block colour entirely, so the
    // markdown alone cannot see the difference. The PROPS can, and they are
    // what the Y.Doc carries to every other device.
    expect(instance.getBlock(subject.id)!.props).not.toEqual(virginProps)

    // `default` is written EXPLICITLY, unlike the inline path in
    // `runStyleAction`, which removes the style. A block prop's default value
    // IS the string `default`, and BlockNote omits default-valued props on
    // serialize — so the explicit write is the reset.
    runBlockAction(surface(instance), subject.id, {
      kind: 'colour',
      slot: 'text',
      colour: 'default'
    })
    runBlockAction(surface(instance), subject.id, {
      kind: 'colour',
      slot: 'background',
      colour: 'default'
    })

    expect(instance.getBlock(subject.id)!.props).toEqual(virginProps)
    expect(instance.blocksToMarkdownLossy([instance.getBlock(subject.id)!])).toBe(expected)
  })

  it('duplicates the subtree below the original, with fresh ids throughout', () => {
    const instance = editor()
    instance.replaceBlocks(instance.document, [
      {
        type: 'toggleListItem',
        content: 'Parent',
        children: [{ type: 'paragraph', content: 'Kid' }]
      },
      { type: 'paragraph', content: 'After' }
    ])
    const original = instance.document[0]

    expect(runBlockAction(surface(instance), original.id, { kind: 'duplicate' })).toEqual({
      status: 'applied',
      keepOpen: false
    })

    // Directly below, not at the end: the copy belongs where the eye is.
    const [first, copy, after] = instance.document
    expect(first.id).toBe(original.id)
    expect(after.type).toBe('paragraph')
    expect(copy.type).toBe('toggleListItem')
    expect(instance.blocksToMarkdownLossy([copy])).toBe(
      instance.blocksToMarkdownLossy([instance.getBlock(original.id)!])
    )

    // Desktop parity: the subtree comes along, and NOTHING reuses an id — one
    // id in two places is a Y.Doc that cannot say which block a later edit meant.
    expect(copy.children).toHaveLength(1)
    expect(copy.id).not.toBe(original.id)
    expect(copy.children[0].id).not.toBe(original.children[0].id)
  })

  it('strips the id of a block and of every descendant', () => {
    const stripped = stripBlockIds({
      id: 'a',
      type: 'toggleListItem',
      children: [{ id: 'b', type: 'paragraph', children: [{ id: 'c', type: 'paragraph' }] }]
    })

    expect(stripped).toEqual({
      id: undefined,
      type: 'toggleListItem',
      children: [
        { id: undefined, type: 'paragraph', children: [{ id: undefined, type: 'paragraph' }] }
      ]
    })
  })

  it('removes the block it names and leaves its neighbours alone', () => {
    const instance = editor()
    instance.replaceBlocks(instance.document, [
      { type: 'paragraph', content: 'One' },
      { type: 'paragraph', content: 'Two' },
      { type: 'paragraph', content: 'Three' }
    ])
    const middle = instance.document[1].id

    expect(runBlockAction(surface(instance), middle, { kind: 'delete' })).toEqual({
      status: 'applied',
      keepOpen: false
    })

    expect(instance.getBlock(middle)).toBeUndefined()
    expect(instance.document).toHaveLength(2)
    expect(instance.blocksToMarkdownLossy(instance.document)).toBe('One\n\nThree\n')
  })

  it('hands the move back to its caller rather than acting on it', () => {
    const instance = editor()
    instance.replaceBlocks(instance.document, [{ type: 'paragraph', content: 'Travels' }])
    const id = instance.document[0].id

    expect(runBlockAction(surface(instance), id, { kind: 'move' })).toEqual({
      status: 'requested-move'
    })
    // The source block is NOT removed here. It goes only when the host answers
    // that the target already holds a durable copy.
    expect(instance.getBlock(id)).toBeDefined()
  })

  it('reports a block that has left the document instead of throwing', () => {
    const instance = editor()
    instance.replaceBlocks(instance.document, [{ type: 'paragraph', content: 'Only' }])

    // A pull, an undo, or a second tap on a panel whose block is already gone.
    for (const action of [
      { kind: 'colour', slot: 'text', colour: 'red' },
      { kind: 'duplicate' },
      { kind: 'delete' },
      { kind: 'move' }
    ] as const) {
      expect(runBlockAction(surface(instance), 'no-such-block', action)).toEqual({
        status: 'gone'
      })
    }
    expect(instance.document).toHaveLength(1)
  })
})
