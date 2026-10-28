/** What the shell's init script publishes before any page script runs (`windows/scripts.rs`). */
export interface ShellGlobals {
  maximizable: boolean
  /** `http://127.0.0.1:<port>` of the loopback media server. */
  loopbackOrigin: string
  loopbackToken: string
}

declare global {
  interface Window {
    __MEMRY_SHELL__?: ShellGlobals
  }
}

export const shellGlobals = (): ShellGlobals | undefined => window.__MEMRY_SHELL__
