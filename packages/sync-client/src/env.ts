/**
 * Safe env access for a package compiled without node types; RN's Metro
 * provides a process shim, browsers may not.
 */
export function readEnv(name: string): string | undefined {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- this package compiles without node types, so globalThis has no `process` member to read
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env
  return env?.[name]
}
