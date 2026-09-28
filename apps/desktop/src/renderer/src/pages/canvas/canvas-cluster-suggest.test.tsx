import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'

const mocks = vi.hoisted(() => ({
  cluster: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@excalidraw/excalidraw', () => ({
  // `regenerateIds: false` keeps the ids the plan minted.
  convertToExcalidrawElements: (skeletons: Array<Record<string, unknown>>) =>
    skeletons.map((skeleton) => ({ angle: 0, ...skeleton })),
  CaptureUpdateAction: { IMMEDIATELY: 'immediately' },
  FONT_FAMILY: { Nunito: 2 },
  ROUNDNESS: { ADAPTIVE_RADIUS: 3 }
}))

vi.mock('@/services/notes-service', () => ({
  notesService: { cluster: mocks.cluster }
}))

vi.mock('sonner', () => ({
  toast: { info: mocks.toastInfo, success: mocks.toastSuccess, error: mocks.toastError }
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

import { CanvasClusterSuggest } from './canvas-cluster-suggest'

interface Element {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  angle: number
  frameId?: string | null
  customData?: Record<string, unknown> | null
  isDeleted?: boolean
  name?: string
}

const card = (id: string, entityType = 'note'): Element => ({
  id: `el-${id}`,
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  angle: 0,
  customData: { entityType, entityId: id }
})

function fakeApi(elements: Element[], selected: string[] = []) {
  const state = { elements }
  const api = {
    getSceneElements: () => state.elements.filter((el) => !el.isDeleted),
    getSceneElementsIncludingDeleted: () => state.elements,
    getAppState: () => ({
      selectedElementIds: Object.fromEntries(selected.map((id) => [id, true]))
    }),
    updateScene: vi.fn(({ elements: next }: { elements: Element[] }) => {
      state.elements = next
    }),
    scrollToContent: vi.fn()
  }
  return { api, state }
}

const renderSuggest = (api: unknown, onSceneMutated = vi.fn()) =>
  render(
    <CanvasClusterSuggest api={api as ExcalidrawImperativeAPI} onSceneMutated={onSceneMutated} />
  )

describe('CanvasClusterSuggest', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('asks for more note cards instead of grouping too few', async () => {
    const { api } = fakeApi([card('a'), card('b'), card('t', 'task')])
    renderSuggest(api)

    await userEvent.click(screen.getByTestId('canvas-suggest-groups'))

    expect(mocks.toastInfo).toHaveBeenCalledWith('canvas.cluster.needMoreNotes')
    expect(mocks.cluster).not.toHaveBeenCalled()
  })

  it('groups only the selection when two or more note cards are selected', async () => {
    mocks.cluster.mockResolvedValue({ status: 'ready', groups: [], ungrouped: [], missing: [] })
    const { api } = fakeApi([card('a'), card('b'), card('c'), card('d')], ['el-a', 'el-b', 'el-c'])
    renderSuggest(api)

    await userEvent.click(screen.getByTestId('canvas-suggest-groups'))

    await waitFor(() => expect(mocks.cluster).toHaveBeenCalledWith(['a', 'b', 'c']))
    expect(mocks.toastInfo).toHaveBeenCalledWith('canvas.cluster.noGroups')
  })

  it('says so when embeddings are off', async () => {
    mocks.cluster.mockResolvedValue({ status: 'disabled', groups: [], ungrouped: [], missing: [] })
    const { api } = fakeApi([card('a'), card('b'), card('c')])
    renderSuggest(api)

    await userEvent.click(screen.getByTestId('canvas-suggest-groups'))

    await waitFor(() => expect(mocks.toastInfo).toHaveBeenCalledWith('canvas.cluster.disabled'))
  })

  it('changes nothing until Create, then frames only the accepted groups in one update', async () => {
    const user = userEvent.setup()
    mocks.cluster.mockResolvedValue({
      status: 'ready',
      groups: [
        { noteIds: ['a', 'b'], titles: ['A', 'B'], suggestedName: 'sleep' },
        { noteIds: ['c', 'd'], titles: ['C', 'D'], suggestedName: null }
      ],
      ungrouped: [],
      missing: []
    })
    const onSceneMutated = vi.fn()
    const { api, state } = fakeApi([card('a'), card('b'), card('c'), card('d')])
    renderSuggest(api, onSceneMutated)

    await user.click(screen.getByTestId('canvas-suggest-groups'))
    await screen.findByText('canvas.cluster.title')
    expect(api.updateScene).not.toHaveBeenCalled()

    const [first, second] = screen.getAllByRole('textbox')
    await user.clear(first)
    await user.type(first, 'Sleep notes')
    expect(second).toHaveValue('canvas.cluster.defaultName')
    // Discard the second group.
    await user.click(screen.getAllByRole('checkbox')[1])

    await user.click(screen.getByRole('button', { name: 'canvas.cluster.create' }))

    await waitFor(() => expect(api.updateScene).toHaveBeenCalledTimes(1))
    const frames = state.elements.filter((el) => el.type === 'frame')
    expect(frames).toHaveLength(1)
    expect(frames[0].name).toBe('Sleep notes')
    const framed = state.elements.filter((el) => el.frameId === frames[0].id).map((el) => el.id)
    expect(framed.sort()).toEqual(['el-a', 'el-b'])
    expect(state.elements.find((el) => el.id === 'el-c')?.frameId).toBeUndefined()
    expect(onSceneMutated).toHaveBeenCalled()
    expect(mocks.toastSuccess).toHaveBeenCalledWith('canvas.cluster.created')
  })

  it('skips cards deleted while the dialog was open', async () => {
    const user = userEvent.setup()
    mocks.cluster.mockResolvedValue({
      status: 'ready',
      groups: [{ noteIds: ['a', 'b'], titles: ['A', 'B'], suggestedName: 'g' }],
      ungrouped: [],
      missing: []
    })
    const { api, state } = fakeApi([card('a'), card('b'), card('c')])
    renderSuggest(api)

    await user.click(screen.getByTestId('canvas-suggest-groups'))
    await screen.findByText('canvas.cluster.title')
    state.elements = state.elements.map((el) => ({ ...el, isDeleted: true }))

    await user.click(screen.getByRole('button', { name: 'canvas.cluster.create' }))

    await waitFor(() => expect(mocks.toastInfo).toHaveBeenCalledWith('canvas.cluster.cardsGone'))
    expect(api.updateScene).not.toHaveBeenCalled()
  })
})
