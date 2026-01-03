/**
 * Custom render wrapper for React component tests.
 * Provides common providers and utilities.
 */

import React, { ReactElement, ReactNode } from 'react'
import { render, RenderOptions, RenderResult } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { vi } from 'vitest'

// Re-export everything from testing-library
export * from '@testing-library/react'
export { default as userEvent } from '@testing-library/user-event'

// ============================================================================
// Query Client Factory
// ============================================================================

/**
 * Create a QueryClient configured for testing.
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Disable retries in tests
        retry: false,
        // Don't refetch on window focus in tests
        refetchOnWindowFocus: false,
        // Use stale time of 0 for tests
        staleTime: 0,
        // Disable garbage collection in tests
        gcTime: Infinity
      },
      mutations: {
        // Disable retries for mutations in tests
        retry: false
      }
    }
  })
}

// ============================================================================
// All Providers Wrapper
// ============================================================================

interface AllProvidersProps {
  children: ReactNode
  queryClient?: QueryClient
}

/**
 * Wrapper component that provides all necessary contexts.
 */
function AllProviders({ children, queryClient }: AllProvidersProps): ReactElement {
  const client = queryClient || createTestQueryClient()

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

// ============================================================================
// Custom Render Function
// ============================================================================

interface CustomRenderOptions extends Omit<RenderOptions, 'wrapper'> {
  queryClient?: QueryClient
}

/**
 * Custom render function that wraps components with all providers.
 *
 * @example
 * ```tsx
 * const { getByText } = renderWithProviders(<MyComponent />)
 * expect(getByText('Hello')).toBeInTheDocument()
 * ```
 */
export function renderWithProviders(
  ui: ReactElement,
  options: CustomRenderOptions = {}
): RenderResult & { queryClient: QueryClient } {
  const { queryClient = createTestQueryClient(), ...renderOptions } = options

  const Wrapper = ({ children }: { children: ReactNode }) => (
    <AllProviders queryClient={queryClient}>{children}</AllProviders>
  )

  return {
    ...render(ui, { wrapper: Wrapper, ...renderOptions }),
    queryClient
  }
}

// ============================================================================
// Hook Testing Utilities
// ============================================================================

interface WrapperOptions {
  queryClient?: QueryClient
}

/**
 * Create a wrapper for testing hooks with renderHook.
 *
 * @example
 * ```tsx
 * const { result } = renderHook(() => useMyHook(), {
 *   wrapper: createWrapper()
 * })
 * ```
 */
export function createWrapper(options: WrapperOptions = {}) {
  const queryClient = options.queryClient || createTestQueryClient()

  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

// ============================================================================
// Mock Window API Utilities
// ============================================================================

/**
 * Get the mocked window.api for assertions.
 */
export function getMockApi() {
  return (window as unknown as { api: Record<string, unknown> }).api
}

/**
 * Reset all window.api mocks.
 */
export function resetMockApi(): void {
  const api = getMockApi()
  if (!api) return

  // Recursively reset all mock functions
  function resetObject(obj: Record<string, unknown>): void {
    for (const key of Object.keys(obj)) {
      const value = obj[key]
      if (typeof value === 'function' && 'mockClear' in value) {
        ;(value as ReturnType<typeof vi.fn>).mockClear()
      } else if (typeof value === 'object' && value !== null) {
        resetObject(value as Record<string, unknown>)
      }
    }
  }

  resetObject(api)
}

/**
 * Configure mock responses for window.api methods.
 *
 * @example
 * ```tsx
 * configureMockApi({
 *   'notes.list': { notes: [], total: 0, hasMore: false },
 *   'notes.get': (id) => id === 'note-1' ? { id: 'note-1', title: 'Test' } : null
 * })
 * ```
 */
export function configureMockApi(
  config: Record<string, unknown | ((...args: unknown[]) => unknown)>
): void {
  const api = getMockApi()
  if (!api) return

  for (const [path, value] of Object.entries(config)) {
    const parts = path.split('.')
    let current = api as Record<string, unknown>

    for (let i = 0; i < parts.length - 1; i++) {
      current = current[parts[i]] as Record<string, unknown>
    }

    const methodName = parts[parts.length - 1]
    const mock = current[methodName]

    if (mock && typeof mock === 'function' && 'mockImplementation' in mock) {
      if (typeof value === 'function') {
        ;(mock as ReturnType<typeof vi.fn>).mockImplementation(value as (...args: unknown[]) => unknown)
      } else {
        ;(mock as ReturnType<typeof vi.fn>).mockResolvedValue(value)
      }
    }
  }
}

// ============================================================================
// Async Utilities
// ============================================================================

/**
 * Wait for React Query to settle.
 */
export async function waitForQueryToSettle(queryClient: QueryClient): Promise<void> {
  await queryClient.cancelQueries()
  await new Promise((resolve) => setTimeout(resolve, 0))
}
