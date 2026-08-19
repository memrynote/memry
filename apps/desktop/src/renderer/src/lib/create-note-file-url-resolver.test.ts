import { describe, it, expect, vi } from 'vitest'
import { createNoteFileUrlResolver } from './create-note-file-url-resolver'

const NOTE = 'People (1)/Person.md'
const VAULT = '/Users/me/vault'
const REF = '../Images/Media/a.png'
const RESOLVED = 'memry-file://local/Users/me/vault/Images/Media/a.png'

/** A vault lookup that has not answered yet — the state every editor mounts in. */
function deferred() {
  let settle!: (value: string | null) => void
  const promise = new Promise<string | null>((resolve) => {
    settle = resolve
  })
  return { promise, settle }
}

describe('createNoteFileUrlResolver', () => {
  // The regression this exists for: reading the vault path off a hook meant it
  // was still null when BlockNote made its one and only call, so the image
  // stayed broken even though the path arrived milliseconds later.
  it('waits for a vault path that has not arrived yet', async () => {
    const vault = deferred()
    const resolve = createNoteFileUrlResolver(
      () => NOTE,
      () => vault.promise
    )

    const pending = resolve(REF)
    vault.settle(VAULT)

    expect(await pending).toBe(RESOLVED)
  })

  it('looks the vault up once no matter how many images a note has', async () => {
    const fetchVaultPath = vi.fn(async () => VAULT)
    const resolve = createNoteFileUrlResolver(() => NOTE, fetchVaultPath)

    const urls = await Promise.all([resolve(REF), resolve(REF), resolve('b.png')])

    expect(fetchVaultPath).toHaveBeenCalledTimes(1)
    expect(urls[0]).toBe(RESOLVED)
    expect(urls[2]).toBe('memry-file://local/Users/me/vault/People%20(1)/b.png')
  })

  it('hands the url back untouched when the vault lookup fails', async () => {
    const resolve = createNoteFileUrlResolver(
      () => NOTE,
      async () => {
        throw new Error('vault closed')
      }
    )

    expect(await resolve(REF)).toBe(REF)
  })

  it('hands the url back untouched before a note path is known', async () => {
    const fetchVaultPath = vi.fn(async () => VAULT)
    const resolve = createNoteFileUrlResolver(() => undefined, fetchVaultPath)

    expect(await resolve(REF)).toBe(REF)
    expect(fetchVaultPath).not.toHaveBeenCalled()
  })

  it('picks up a note path that arrives after the editor mounted', async () => {
    let notePath: string | undefined
    const resolve = createNoteFileUrlResolver(
      () => notePath,
      async () => VAULT
    )

    expect(await resolve(REF)).toBe(REF)
    notePath = NOTE
    expect(await resolve(REF)).toBe(RESOLVED)
  })
})

describe('createNoteFileUrlResolver without a note path prop', () => {
  // Only pages/note.tsx passes `notePath`. The journal, canvas cards and a
  // project's home note mount the editor knowing only the note's id — and
  // attachments are written relative to their note on every one of those
  // surfaces, so without the fallback the image a user just dropped into their
  // journal resolves against the renderer's own base URL and 404s.
  it('falls back to the looked-up path', async () => {
    const resolve = createNoteFileUrlResolver(
      () => undefined,
      async () => VAULT,
      async () => NOTE
    )

    expect(await resolve(REF)).toBe(RESOLVED)
  })

  it('prefers the prop and never looks anything up when it is there', async () => {
    const fetchNotePath = vi.fn(async () => 'Other/Note.md')
    const resolve = createNoteFileUrlResolver(
      () => NOTE,
      async () => VAULT,
      fetchNotePath
    )

    expect(await resolve(REF)).toBe(RESOLVED)
    expect(fetchNotePath).not.toHaveBeenCalled()
  })

  it('hands the URL back untouched when the lookup fails', async () => {
    const resolve = createNoteFileUrlResolver(
      () => undefined,
      async () => VAULT,
      async () => {
        throw new Error('no such note')
      }
    )

    expect(await resolve(REF)).toBe(REF)
  })
})
