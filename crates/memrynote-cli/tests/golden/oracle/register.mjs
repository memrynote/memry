// Loaded with `--import`: points the desktop registry adapter's `../store` at the JSON-file shim.
import { registerHooks } from 'node:module'

const shim = new URL('./store-shim.mjs', import.meta.url).href

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '../store' && context.parentURL?.endsWith('/main/cli/vault-registry.ts')) {
      return { url: shim, shortCircuit: true }
    }
    return next(specifier, context)
  }
})
