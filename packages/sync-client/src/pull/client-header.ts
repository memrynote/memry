import type { DevicePlatform } from '../adapters/device-registration.ts'

export const CLIENT_HEADER = 'x-memry-client'

/**
 * Build the `x-memry-client` header value (contracts/sync-protocol-additions.md
 * §1): `<platform>/<major>.<minor>.<patch>[+<build>]`, e.g. `ios/1.0.0+42`.
 *
 * The server treats anything that does not match its regex as absent (legacy),
 * so a malformed version here silently opts the client out of the write gate —
 * worth a warning, never a throw. Pre-release identifiers are rejected by the
 * server ON PURPOSE (a beta must not satisfy a floor its release does not), so
 * this builder does not try to smuggle them through.
 */
export function buildClientHeaderValue(platform: DevicePlatform, appVersion: string): string {
  return `${platform}/${appVersion}`
}

const SERVER_CLIENT_HEADER_REGEX = /^[a-z]+\/\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/

/** True when the server-side parser will accept the value (not treat it as legacy). */
export function isParseableClientHeader(value: string): boolean {
  return SERVER_CLIENT_HEADER_REGEX.test(value)
}
