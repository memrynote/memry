/**
 * Plumbing every protocol vector class shares.
 *
 * A class module exports one `build*` function returning a plain object. The
 * entry point decides where it lands, so `--check` can write to a temporary
 * directory without any class knowing about it.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import sodium from 'libsodium-wrappers-sumo'

export const VECTORS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test-vectors')

/** The `meta` block every file carries, mirroring `crypto-vectors.json`. */
export function meta(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    spec: '002-native-foundation-ios',
    sodiumVersion: sodium.SODIUM_VERSION_STRING,
    encoding:
      'hex unless the field name says otherwise; *Base64/*B64 are standard base64 with padding',
    ...extra
  }
}

/**
 * Write one vector file. Trailing newline and two-space indent, matching the
 * committed `crypto-vectors.json`, so a regeneration is a no-op diff.
 */
export function writeVectorFile(root: string, relativePath: string, value: unknown): string {
  const target = join(root, relativePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return target
}
