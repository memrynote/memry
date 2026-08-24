export const MEMRY_SERVERS = {
  staging: 'https://sync-staging.memrynote.com',
  production: 'https://sync.memrynote.com'
} as const

export type MemryServer = keyof typeof MEMRY_SERVERS

/**
 * Which sync server this build talks to. `EXPO_PUBLIC_MEMRY_SERVER=staging`
 * at build time flips it; default is production (the shipping default — G2
 * drills run against staging builds with the env set).
 */
export function activeServer(): MemryServer {
  return process.env.EXPO_PUBLIC_MEMRY_SERVER === 'staging' ? 'staging' : 'production'
}

export function syncBaseUrl(): string {
  return MEMRY_SERVERS[activeServer()]
}
