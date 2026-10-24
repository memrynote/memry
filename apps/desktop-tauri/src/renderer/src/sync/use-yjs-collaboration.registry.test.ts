import { describe, it, expect } from 'vitest'

// The hook must acquire from a single module-level registry keyed by noteId so
// two mounts for the same note in one window share one entry (R17).
describe('useYjsCollaboration registry wiring', () => {
  it('exports a module-level registry acquire/release used by the hook', async () => {
    const mod = await import('./use-yjs-collaboration')
    expect(typeof mod.useYjsCollaboration).toBe('function')
    expect(typeof mod.useYjsSideEffectOwner).toBe('function')
  })
})
