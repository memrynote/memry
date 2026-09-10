import { net } from 'electron'

export const NET_FETCH_TIMEOUT_MS = 30_000

/**
 * net.fetch with an abort deadline. A request that is in flight when
 * Chromium's network service dies never settles on its own, and a flush loop
 * awaiting it stalls for the rest of the run while every later batch queues
 * behind it.
 */
export const boundedNetFetch = (
  input: string | URL,
  init?: RequestInit,
  timeoutMs: number = NET_FETCH_TIMEOUT_MS
): Promise<Response> =>
  net.fetch(input.toString(), { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) })
