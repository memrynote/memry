/**
 * A gesture's plan becomes a fence edit: anchors are stamped first, then the
 * target the plan resolves to is written onto the live definition.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parsePortalDefinition } from '@memry/shared/portal-block'

const stamp = vi.hoisted(() => vi.fn())
vi.mock('./portal-api', () => ({ stampPortalAnchor: stamp }))

import { commitPortalPlan } from './portal-actions'
import type { PortalPlan } from './portal-plans'
import type { PortalHandle } from './portal-slots'

function handle(fence: string) {
  const parsed = parsePortalDefinition(fence)
  if (!parsed.ok) throw new Error('bad fence')
  let text = fence
  const editor = {
    isEditable: true,
    getBlock: () => ({ content: [{ type: 'text', text }] }),
    updateBlock: vi.fn((_id: string, update: { content: string }) => {
      text = update.content
    }),
    removeBlocks: vi.fn()
  }
  const portal: PortalHandle = {
    blockId: 'p',
    instanceId: 'i1',
    editor,
    definition: parsed.definition,
    sourceNoteId: 'src',
    hostNoteId: 'host'
  }
  return { portal, editor, written: () => JSON.parse(text) }
}

const fence = '{"v":1,"note":"src","blocks":["root"],"future":1}'

describe('commitPortalPlan', () => {
  beforeEach(() => stamp.mockReset())

  it('writes a finished plan, keeping keys the build does not manage', async () => {
    const { portal, written } = handle(fence)
    const definition = {
      ...portal.definition,
      target: { kind: 'blocks' as const, note: 'src', blocks: ['root', 'next'], open: {} }
    }
    const plan: PortalPlan = { definition, resolve: () => plan }

    expect(await commitPortalPlan(portal, plan)).toBe(true)
    expect(written()).toEqual({ v: 1, note: 'src', blocks: ['root', 'next'], future: 1 })
  })

  it('stamps the blocks a plan asks for, then plans again with their anchors', async () => {
    stamp.mockResolvedValue({ success: true, anchor: 'fresh1' })
    const { portal, written } = handle(fence)
    const finished: PortalPlan = {
      definition: {
        ...portal.definition,
        target: { kind: 'blocks', note: 'src', blocks: ['root', 'fresh1'], open: {} }
      },
      resolve: () => finished
    }
    const unfinished: PortalPlan = {
      definition: portal.definition,
      stamp: ['block-id'],
      resolve: (anchors) => (anchors['block-id'] === 'fresh1' ? finished : unfinished)
    }

    expect(await commitPortalPlan(portal, unfinished)).toBe(true)
    expect(stamp).toHaveBeenCalledWith('src', 'block-id')
    expect(written().blocks).toEqual(['root', 'fresh1'])
  })

  it('writes nothing when the source refuses to stamp', async () => {
    stamp.mockResolvedValue({ success: false, reason: 'locked' })
    const { portal, editor } = handle(fence)
    const plan: PortalPlan = {
      definition: portal.definition,
      stamp: ['block-id'],
      resolve: () => plan
    }

    expect(await commitPortalPlan(portal, plan)).toBe(false)
    expect(editor.updateBlock).not.toHaveBeenCalled()
  })

  it('writes nothing for a refused gesture', async () => {
    const { portal, editor } = handle(fence)

    expect(await commitPortalPlan(portal, null)).toBe(false)
    expect(editor.updateBlock).not.toHaveBeenCalled()
  })
})
