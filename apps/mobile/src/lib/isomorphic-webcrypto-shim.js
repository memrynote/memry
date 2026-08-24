// Shim for `isomorphic-webcrypto/src/react-native`, which lib0 (a yjs dep)
// requires under Metro's react-native export condition. That package is
// unmaintained and drags in its own native modules; everything lib0 actually
// touches (`default.ensureSecure()`, `default.subtle`,
// `default.getRandomValues`) is served here from the app's libsodium-backed
// crypto polyfill (src/lib/crypto-polyfill.ts, the root layout's first
// import). Wired up via `resolveRequest` in metro.config.js.
//
// Properties read lazily so this module never races the polyfill's install.
module.exports = {
  ensureSecure() {},
  get subtle() {
    // Hermes has no SubtleCrypto; yjs never touches it. Anything that does
    // should fail loudly rather than get a broken stub.
    return globalThis.crypto ? globalThis.crypto.subtle : undefined
  },
  getRandomValues(array) {
    return globalThis.crypto.getRandomValues(array)
  }
}
