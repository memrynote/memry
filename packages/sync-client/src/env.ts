/**
 * Safe env access for a package compiled without node types; RN's Metro
 * provides a process shim, browsers may not.
 */
export function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env
  return env?.[name]
}
