/// <reference types="vite/client" />

import type { StartupState } from '../../generated/bindings'

declare global {
  interface Window {
    /** Published by the Rust init script of the main window before first paint. */
    __MEMRY_STARTUP__?: Readonly<StartupState>
  }
}
