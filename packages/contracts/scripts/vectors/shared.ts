/**
 * Plumbing every protocol vector class shares.
 *
 * A class module exports one `build*` function returning a plain object. The
 * entry point decides where it lands, so `--check` can write to a temporary
 * directory without any class knowing about it.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

/**
 * A class whose bytes come from an oracle that cannot run here (the Electron
 * converter, `apps/desktop/scripts/markdown-oracle`) is registered as its own
 * committed file: `vectors:check` then proves the file is present and
 * byte-stable, `@memry/desktop vectors:markdown-convert:check` proves it still
 * matches the oracle, and a regeneration here is a no-op.
 */
export function committedVector(relativePath: string): unknown {
  return JSON.parse(readFileSync(join(VECTORS_DIR, relativePath), 'utf8'))
}
