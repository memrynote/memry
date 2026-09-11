export type VelopackModule = typeof import('velopack')

/**
 * velopack's loader requires the platform `.node` binary at import time and packaging
 * prunes every non-target binary, so the module is only ever required on Windows, and
 * only from here. Tests mock this module instead of the package.
 */
export function loadVelopack(): VelopackModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy: the native binary only exists on the target platform
  return require('velopack') as VelopackModule
}
