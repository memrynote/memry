import { net } from 'electron'

function getSyncServerUrl(): string {
  const url = process.env.SYNC_SERVER_URL
  if (url) return url
  if (process.env.NODE_ENV === 'development') return 'http://localhost:8787'
  throw new Error('SYNC_SERVER_URL environment variable is not configured')
}

export type FetchFn = typeof globalThis.fetch

export class SyncServerError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly serverError?: string
  ) {
    super(message)
    this.name = 'SyncServerError'
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NetworkError'
  }
}

export class RateLimitError extends SyncServerError {
  constructor(public readonly retryAfter?: number) {
    super('Too many requests. Please try again later.', 429)
    this.name = 'RateLimitError'
  }
}

interface ServerErrorResponse {
  error?: string
  message?: string
}

export const syncFetch = async <T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
  path: string,
  body?: unknown,
  token?: string,
  fetchFn?: FetchFn
): Promise<T> => {
  const url = `${getSyncServerUrl()}${path}`
  const fetchImpl = fetchFn ?? net.fetch

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json'
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  let response: Response
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined
    })
  } catch {
    throw new NetworkError(
      `Unable to connect to sync server. Please check your internet connection.`
    )
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After')
    throw new RateLimitError(retryAfter ? parseInt(retryAfter, 10) : undefined)
  }

  let responseBody: unknown
  try {
    responseBody = await response.json()
  } catch {
    if (!response.ok) {
      throw new SyncServerError(`Server returned ${response.status}`, response.status)
    }
    throw new SyncServerError('Invalid response body', response.status)
  }

  if (!response.ok) {
    const errorBody = responseBody as ServerErrorResponse
    const message = errorBody?.error || errorBody?.message || `Server error (${response.status})`
    throw new SyncServerError(message, response.status, message)
  }

  return responseBody as T
}

export const postToServer = async <T>(
  path: string,
  body?: unknown,
  token?: string,
  fetchFn?: FetchFn
): Promise<T> => {
  return syncFetch<T>('POST', path, body, token, fetchFn)
}

export const getFromServer = async <T>(
  path: string,
  token?: string,
  fetchFn?: FetchFn
): Promise<T> => {
  return syncFetch<T>('GET', path, undefined, token, fetchFn)
}

export const deleteFromServer = async <T>(
  path: string,
  token?: string,
  fetchFn?: FetchFn
): Promise<T> => {
  return syncFetch<T>('DELETE', path, undefined, token, fetchFn)
}
