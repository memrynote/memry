import type * as VelopackModule2 from 'velopack'
export type VelopackModule = typeof VelopackModule2

/**
 * velopack's loader requires the platform `.node` binary at import time and packaging
 * prunes every non-target binary, so the module is only ever required on Windows, and
 * only from here. Tests mock this module instead of the package.
 */
export function loadVelopack(): VelopackModule {
  // oxlint-disable-next-line typescript/no-require-imports, typescript/no-unsafe-type-assertion -- lazy: the native binary only exists on the target platform; require() is untyped and VelopackModule mirrors its public surface
  return require('velopack') as VelopackModule
}
