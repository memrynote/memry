import { net } from 'electron'

const SYNC_SERVER_URL = process.env.SYNC_SERVER_URL || 'http://localhost:8787'

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
  token?: string
): Promise<T> => {
  const url = `${SYNC_SERVER_URL}${path}`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json'
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  let response: Response
  try {
    response = await net.fetch(url, {
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
    return undefined as T
  }

  if (!response.ok) {
    const errorBody = responseBody as ServerErrorResponse
    const message = errorBody?.error || errorBody?.message || `Server error (${response.status})`
    throw new SyncServerError(message, response.status, message)
  }

  return responseBody as T
}

export const postToServer = async <T>(path: string, body?: unknown, token?: string): Promise<T> => {
  return syncFetch<T>('POST', path, body, token)
}

export const getFromServer = async <T>(path: string, token?: string): Promise<T> => {
  return syncFetch<T>('GET', path, undefined, token)
}

export const deleteFromServer = async <T>(path: string, token?: string): Promise<T> => {
  return syncFetch<T>('DELETE', path, undefined, token)
}

export const putToServer = async <T>(path: string, body?: unknown, token?: string): Promise<T> => {
  return syncFetch<T>('PUT', path, body, token)
}

export const patchToServer = async <T>(
  path: string,
  body?: unknown,
  token?: string
): Promise<T> => {
  return syncFetch<T>('PATCH', path, body, token)
}
