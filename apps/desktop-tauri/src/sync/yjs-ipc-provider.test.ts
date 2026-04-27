import { describe, expect, it } from 'vitest'
import { YjsTauriProvider } from '@/lib/crdt/yjs-tauri-provider'
import { YjsIpcProvider } from './yjs-ipc-provider'

describe('YjsIpcProvider compatibility export', () => {
  it('points old imports at the Rust-backed Tauri provider', () => {
    expect(YjsIpcProvider).toBe(YjsTauriProvider)
  })
})
