type Sodium = typeof import('libsodium-wrappers-sumo').default

let sodiumPromise: Promise<Sodium> | null = null

/**
 * libsodium is ~370KB of WebAssembly-carrying JS and is only reachable from the
 * signed-in surfaces (device identity, login, account). A static import pulled it
 * into the entry graph via auth-context, so every marketing page paid for it before
 * first paint. Importing here keeps the module out of the initial download and the
 * `ready` await unchanged for callers.
 */
export async function getSodium(): Promise<Sodium> {
  sodiumPromise ??= import('libsodium-wrappers-sumo').then(async ({ default: sodium }) => {
    await sodium.ready
    return sodium
  })

  return sodiumPromise
}
