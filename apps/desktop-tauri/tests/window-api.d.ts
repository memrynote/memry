// Test-only type augmentation. Production Tauri code never touches
// `window.api`; it calls `invoke(...)` instead. But the ported Electron test
// suite mocks through `window.api.X.Y = vi.fn()`, so tsc needs to know the
// shape of `window.api` to typecheck those test files. `tests/setup-dom.ts`
// installs the runtime mock.
import type { API } from '@/types/preload-types'

declare global {
  interface Window {
    api: API
    electron: {
      ipcRenderer: {
        send: (...args: unknown[]) => void
        invoke: (...args: unknown[]) => Promise<unknown>
        on: (...args: unknown[]) => () => void
        removeListener: (...args: unknown[]) => void
      }
    }
  }
}

export {}
