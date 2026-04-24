/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MOCK_IPC?: 'true' | 'false'
  readonly TAURI_ENV_PLATFORM?: string
  readonly TAURI_ENV_ARCH?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
