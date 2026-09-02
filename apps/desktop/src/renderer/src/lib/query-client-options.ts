import type { DefaultOptions } from '@tanstack/react-query'

/**
 * Query defaults for the whole renderer, shared with the tests that depend on them.
 *
 * `staleTime` is the reason a test harness cannot invent its own client and still
 * prove anything about cache freshness: with the harness default of 0 every remount
 * refetches, so a query that production would serve from cache looks live in a test.
 * Anything asserting that a tab picks up a change it missed while unmounted has to
 * run against these numbers.
 */
export const APP_QUERY_DEFAULT_OPTIONS: DefaultOptions = {
  queries: {
    // Data is considered fresh for 30 seconds
    staleTime: 30 * 1000,
    // Keep unused data in cache for 5 minutes
    gcTime: 5 * 60 * 1000,
    // Retry failed requests once
    retry: 1,
    // Don't refetch on window focus for desktop app
    refetchOnWindowFocus: false
  }
}
