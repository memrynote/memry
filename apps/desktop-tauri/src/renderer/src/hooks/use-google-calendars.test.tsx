import type { ReactNode } from 'react'
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_QUERY_DEFAULT_OPTIONS } from '@/lib/query-client-options'
import { googleCalendarsQueryKey, useGoogleCalendars } from './use-google-calendars'

const { listGoogleCalendars } = vi.hoisted(() => ({ listGoogleCalendars: vi.fn() }))

vi.mock('@/services/calendar-service', () => ({ listGoogleCalendars }))

afterEach(() => onlineManager.setOnline(true))

// #4146: local reads run offline (`networkMode: 'always'` in the app defaults). This list comes
// from Google, so it keeps waiting for the network as before.
describe('useGoogleCalendars', () => {
  it('waits for the network before listing the calendars', async () => {
    listGoogleCalendars.mockResolvedValue({ calendars: [] })
    const client = new QueryClient({ defaultOptions: APP_QUERY_DEFAULT_OPTIONS })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    onlineManager.setOnline(false)

    const { result } = renderHook(() => useGoogleCalendars(), { wrapper })

    await waitFor(() =>
      expect(client.getQueryState(googleCalendarsQueryKey)?.fetchStatus).toBe('paused')
    )
    expect(listGoogleCalendars).not.toHaveBeenCalled()
    expect(result.current.data).toBeUndefined()

    act(() => onlineManager.setOnline(true))

    await waitFor(() => expect(result.current.data).toEqual({ calendars: [] }))
    expect(listGoogleCalendars).toHaveBeenCalledTimes(1)
  })
})
