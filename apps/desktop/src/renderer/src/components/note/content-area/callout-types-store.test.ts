import { afterEach, describe, expect, it } from 'vitest'
import { readCalloutRun } from '@memry/editor-schema/blocks'
import { getCustomCalloutSlashMenuItems } from './callout-block'
import { getCalloutTypes, publishCalloutTypes } from './callout-types-store'

const mytype = { name: 'mytype', label: 'My type', color: '#ff8800', icon: 'star' }

afterEach(() => {
  publishCalloutTypes([])
})

describe('renderer callout types (#3207)', () => {
  it('publishing makes the markdown parser claim the type', () => {
    expect(readCalloutRun(['> [!mytype]', '> body'], 0, true)).toBeNull()

    publishCalloutTypes([mytype])

    expect(getCalloutTypes()).toEqual([mytype])
    expect(readCalloutRun(['> [!mytype]', '> body'], 0, true)).toMatchObject({ type: 'mytype' })
  })

  it('lists one slash row per custom type that inserts a callout of that type', () => {
    publishCalloutTypes([mytype])
    const updates: unknown[] = []
    const editor = {
      getTextCursorPosition: () => ({ block: { props: { type: 'info' } } }),
      updateBlock: (_block: unknown, update: unknown) => updates.push(update)
    }

    const [item] = getCustomCalloutSlashMenuItems(editor, { group: 'Basic', subtext: 'Custom' })
    item.onItemClick()

    expect(item).toMatchObject({ id: 'callout:mytype', title: 'My type' })
    expect(updates).toEqual([{ type: 'callout', props: { type: 'mytype' } }])
  })
})
