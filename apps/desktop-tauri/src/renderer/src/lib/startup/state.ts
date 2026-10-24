/** The value the Rust side published before first paint, when there is one. */
export function readStartupState(): Window['__MEMRY_STARTUP__'] {
  return typeof window === 'undefined' ? undefined : window.__MEMRY_STARTUP__
}
