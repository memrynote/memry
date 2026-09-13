/**
 * The one way a verifier reads a committed vector file.
 *
 * Verification is a SEPARATE PROGRAM from generation: a verifier reads the
 * committed JSON and recomputes, and never imports a builder from
 * `scripts/vectors/`. A verifier that called the generator would pass whenever
 * the generator and the implementation drifted together, which is the failure
 * mode the two-halved gate exists to catch.
 */
import { readFileSync } from 'node:fs'

export function loadVectorFile<T>(relativePath: string): T {
  return JSON.parse(
    readFileSync(new URL(`../../test-vectors/${relativePath}`, import.meta.url), 'utf8')
  ) as T
}

export const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')
export const fromHex = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, 'hex'))
