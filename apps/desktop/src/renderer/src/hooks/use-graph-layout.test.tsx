import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphLayout } from '@memry/contracts/graph-api'
import { graphLayoutKey, useGraphLayout, useGraphLayoutActions } from './use-graph-layout'

const api = {
  getLayout: vi.fn(),
  saveLayout: vi.fn(),
  clearLayout: vi.fn()
}

const saved: GraphLayout = { version: 1, nodes: { a: { x: 1, y: 2, pinned: true } } }

function setup(): { client: QueryClient; wrapper: (props: { children: ReactNode }) => ReactNode } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }): ReactNode => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, wrapper }
}

beforeEach(() => {
  vi.clearAllMocks()
  window.api = { graph: api } as unknown as typeof window.api
})

describe('useGraphLayout', () => {
  it('loads the saved layout for a view', async () => {
    api.getLayout.mockResolvedValue(saved)
    const { wrapper } = setup()

    const { result } = renderHook(() => useGraphLayout('global'), { wrapper })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.layout).toEqual(saved)
    expect(api.getLayout).toHaveBeenCalledWith('global')
  })

  it('opens without a layout when the read fails', async () => {
    api.getLayout.mockRejectedValue(new Error('boom'))
    const { wrapper } = setup()

    const { result } = renderHook(() => useGraphLayout('global'), { wrapper })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.layout).toBeNull()
  })
})

describe('useGraphLayoutActions', () => {
  it('saves positions as a versioned layout', async () => {
    api.saveLayout.mockResolvedValue(undefined)
    const { wrapper } = setup()
    const { result } = renderHook(() => useGraphLayoutActions('global'), { wrapper })

    act(() => result.current.save(saved.nodes))

    await waitFor(() =>
      expect(api.saveLayout).toHaveBeenCalledWith({ viewKey: 'global', layout: saved })
    )
  })

  it('runs writes in order, so a clear lands after an earlier save', async () => {
    const order: string[] = []
    let finishSave: () => void = () => {}
    api.saveLayout.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishSave = () => {
            order.push('save')
            resolve()
          }
        })
    )
    api.clearLayout.mockImplementation(async () => {
      order.push('clear')
    })
    const { client, wrapper } = setup()
    client.setQueryData(graphLayoutKey('global'), saved)
    const { result } = renderHook(() => useGraphLayoutActions('global'), { wrapper })

    act(() => result.current.save(saved.nodes))
    let cleared: Promise<void> = Promise.resolve()
    act(() => {
      cleared = result.current.clear()
    })
    await waitFor(() => expect(api.saveLayout).toHaveBeenCalled())
    expect(api.clearLayout).not.toHaveBeenCalled()

    finishSave()
    await act(() => cleared)

    expect(order).toEqual(['save', 'clear'])
    expect(client.getQueryData(graphLayoutKey('global'))).toBeNull()
  })

  it('keeps the queue alive after a failed write', async () => {
    api.saveLayout.mockRejectedValueOnce(new Error('disk full'))
    api.clearLayout.mockResolvedValue(undefined)
    const { wrapper } = setup()
    const { result } = renderHook(() => useGraphLayoutActions('global'), { wrapper })

    act(() => result.current.save(saved.nodes))
    await act(() => result.current.clear())

    expect(api.clearLayout).toHaveBeenCalledWith('global')
  })
})
