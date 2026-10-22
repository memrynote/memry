/**
 * Hide and show in a whole-note portal (a deny list), read from a real window.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { parsePortalDefinition, type PortalDefinition } from '@memry/shared/portal-block'
import type { PartialBlock } from '@blocknote/core'

vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))
vi.mock('@/lib/url-metadata', () => ({
  fetchLinkPreview: vi.fn().mockResolvedValue({ domain: '', title: '', favicon: '' })
}))

import { para, unmountTestEditors } from './portal-test-editor'
import { mountPortalWindow } from './portal-window-test-editor'
import { planHide, planIncludeParent, planShow, planShowAllSiblings } from './portal-plans'
import { getPortalWindowState } from './portal-window-plugin'

afterEach(unmountTestEditors)

function define(hide: string[] = []): PortalDefinition {
  const parsed = parsePortalDefinition(JSON.stringify({ v: 1, note: 'src', hide }))
  if (!parsed.ok) throw new Error('bad definition')
  return parsed.definition
}

function mount(blocks: PartialBlock[], def: PortalDefinition) {
  if (def.target.kind === 'search') throw new Error('search')
  const mounted = mountPortalWindow(blocks, def.target)
  const id = (text: string): string => {
    const state = getPortalWindowState(mounted.view)!
    const found = [...state.visible, ...state.hiddenSiblings].find((b) => b.text === text)
    if (!found) throw new Error(`no block ${text}`)
    return found.blockId
  }
  return { ...mounted, id, def }
}

const note = (): PartialBlock[] => [
  para('Intro ^intr01'),
  para('Parent ^par111', [para('kid a ^kida1', [para('grand')]), para('kid b')]),
  para('Tail')
]

const visibleTexts = (view: Parameters<typeof getPortalWindowState>[0]): string[] =>
  getPortalWindowState(view)!.visible.map((b) => b.text)

describe('a whole-note portal window with a deny list', () => {
  it('hides the named block and its subtree, lists the outermost as hidden, no children', () => {
    const { view } = mount(note(), define(['par111', 'kida1']))
    const state = getPortalWindowState(view)!
    expect(visibleTexts(view)).toEqual(['Intro', 'Tail'])
    expect(state.hiddenSiblings.map((b) => b.text)).toEqual(['Parent'])
    expect(state.hiddenChildren).toEqual({})
    expect(state.rootFound).toBeNull()
  })
})

describe('planHide for a note portal', () => {
  it('adds an anchored block to hide', () => {
    const { view, def, id } = mount(note(), define())
    const plan = planHide(view, def, id('Parent'))
    expect(plan?.stamp).toBeUndefined()
    expect(plan?.definition.target).toMatchObject({ kind: 'note', hide: ['par111'] })
  })

  it('asks to stamp a bare block, then finishes with its anchor', () => {
    const { view, def, id } = mount(note(), define())
    const bare = id('Tail')
    const plan = planHide(view, def, bare)
    expect(plan?.stamp).toEqual([bare])
    const done = plan!.resolve({ [bare]: 'tail01' })
    expect(done.stamp).toBeUndefined()
    expect(done.definition.target).toMatchObject({ hide: ['tail01'] })
  })

  it('refuses when no block would stay visible', () => {
    const single = mount([para('Only ^only01', [para('child')])], define())
    expect(planHide(single.view, single.def, single.id('Only'))).toBeNull()

    const { view, def, id } = mount(note(), define(['intr01', 'par111']))
    expect(planHide(view, def, id('Tail'))).toBeNull()
  })

  it('refuses a hide that removes the last top-level subtree even with children showing', () => {
    const { view, def, id } = mount([para('Only ^only01', [para('child ^chld01')])], define())
    expect(planHide(view, def, id('Only'))).toBeNull()
    expect(planHide(view, def, id('child'))?.definition.target).toMatchObject({
      hide: ['chld01']
    })
  })
})

describe('planShow / planShowAllSiblings for a note portal', () => {
  it('removes one entry from hide', () => {
    const { view, def, id } = mount(note(), define(['intr01', 'par111']))
    expect(planShow(view, def, id('Parent'))?.definition.target).toMatchObject({
      hide: ['intr01']
    })
  })

  it('Show all clears hide, and does nothing when nothing is hidden', () => {
    const hidden = mount(note(), define(['intr01', 'par111']))
    expect(planShowAllSiblings(hidden.view, hidden.def)?.definition.target).toMatchObject({
      hide: []
    })
    const plain = mount(note(), define())
    expect(planShowAllSiblings(plain.view, plain.def)).toBeNull()
  })

  it('has no parent to include', () => {
    const { view, def, id } = mount(note(), define())
    expect(planIncludeParent(view, def, id('Parent'))).toBeNull()
  })
})
