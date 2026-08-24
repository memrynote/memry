import {
  SYNC_ADAPTER_SEAMS,
  type CrdtTransport,
  type SyncAdapterSeam,
  type SyncPlatformAdapters
} from './index.ts'

/**
 * One shared conformance suite, run against every adapter implementation:
 * desktop's under Vitest/node today, mobile's on-device later
 * (contracts/platform-adapters.md §Conformance).
 *
 * It takes REAL adapters, not mocks. A mock proves the suite compiles; only a
 * real implementation proves that bytes written by `appendUpdate` survive a
 * `loadDoc`, which is the class of failure this package exists to prevent.
 *
 * Runner-agnostic on purpose: `describe`/`it`/`expect` are injected, because
 * desktop and mobile do not share a test runner and duplicating the suite is
 * exactly how the two shells would drift.
 */
export interface ConformanceExpect {
  (actual: unknown): {
    toBe(expected: unknown): void
    toEqual(expected: unknown): void
  }
}

export interface ConformanceTestApi {
  describe(name: string, body: () => void): void
  it(name: string, body: () => void | Promise<void>): void
  expect: ConformanceExpect
}

export interface ConformanceHarness {
  /** A fresh, fully wired set of adapters. Called once per `it`. */
  create(): Promise<SyncPlatformAdapters> | SyncPlatformAdapters
  /** Tear down whatever `create` provisioned. */
  destroy?(adapters: SyncPlatformAdapters): Promise<void> | void
  /**
   * Seams this implementation legitimately does not provide yet. Every entry
   * needs a justification in the PR that adds it — an empty list is the target
   * state, and a growing list is the signal that a shell is drifting.
   */
  skip?: ReadonlyArray<SyncAdapterSeam>
}

const VAULT_ID = 'conformance-vault'
const DOC_ID = 'conformance-doc'

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values)

const sameBytes = (a: Uint8Array | null, b: Uint8Array): boolean =>
  a !== null && a.length === b.length && a.every((value, i) => value === b[i])

export const runAdapterConformance = (
  harness: ConformanceHarness,
  api: ConformanceTestApi
): void => {
  const { describe, it, expect } = api
  const skipped = new Set<SyncAdapterSeam>(harness.skip ?? [])

  const seam = (name: SyncAdapterSeam, body: () => void): void => {
    describe(`adapter: ${name}`, () => {
      if (skipped.has(name)) {
        it('is declared unimplemented by this harness', () => {
          expect(skipped.has(name)).toBe(true)
        })
        return
      }
      body()
    })
  }

  const withAdapters = async (
    body: (adapters: SyncPlatformAdapters) => Promise<void>
  ): Promise<void> => {
    const adapters = await harness.create()
    try {
      await body(adapters)
    } finally {
      await harness.destroy?.(adapters)
    }
  }

  describe('@memry/sync-client adapter conformance', () => {
    it('supplies every declared seam', async () => {
      await withAdapters(async (adapters) => {
        const missing = SYNC_ADAPTER_SEAMS.filter(
          (name) => !skipped.has(name) && adapters[name] === undefined
        )
        expect(missing).toEqual([])
      })
    })

    seam('crdtPersistence', () => {
      // The single most load-bearing seam: an update that does not survive a
      // reload is a lost edit, and lost edits are invisible until a user
      // notices their note is short.
      it('returns appended updates from loadDoc', async () => {
        await withAdapters(async ({ crdtPersistence }) => {
          await crdtPersistence.appendUpdate(DOC_ID, bytes(1, 2, 3))
          await crdtPersistence.appendUpdate(DOC_ID, bytes(4, 5))

          const state = await crdtPersistence.loadDoc(DOC_ID)
          expect(state.updates.length).toBe(2)
          expect(sameBytes(state.updates[0], bytes(1, 2, 3))).toBe(true)
          expect(sameBytes(state.updates[1], bytes(4, 5))).toBe(true)
        })
      })

      it('returns an empty state for a document that was never written', async () => {
        await withAdapters(async ({ crdtPersistence }) => {
          const state = await crdtPersistence.loadDoc('never-written')
          expect(state.updates).toEqual([])
          expect(state.snapshot).toBe(undefined)
        })
      })

      it('reports the snapshot it stored', async () => {
        await withAdapters(async ({ crdtPersistence }) => {
          await crdtPersistence.appendUpdate(DOC_ID, bytes(1))
          await crdtPersistence.saveSnapshot(DOC_ID, bytes(9, 9, 9), 1)

          const state = await crdtPersistence.loadDoc(DOC_ID)
          expect(sameBytes(state.snapshot ?? null, bytes(9, 9, 9))).toBe(true)
        })
      })

      it('lists written documents and forgets deleted ones', async () => {
        await withAdapters(async ({ crdtPersistence }) => {
          await crdtPersistence.appendUpdate(DOC_ID, bytes(1))
          expect((await crdtPersistence.listDocs()).includes(DOC_ID)).toBe(true)

          await crdtPersistence.deleteDoc(DOC_ID)
          expect((await crdtPersistence.listDocs()).includes(DOC_ID)).toBe(false)
        })
      })

      it('keeps the document readable after compaction', async () => {
        await withAdapters(async ({ crdtPersistence }) => {
          await crdtPersistence.appendUpdate(DOC_ID, bytes(1))
          await crdtPersistence.saveSnapshot(DOC_ID, bytes(2), 1)
          await crdtPersistence.compact(DOC_ID)

          const state = await crdtPersistence.loadDoc(DOC_ID)
          expect(sameBytes(state.snapshot ?? null, bytes(2))).toBe(true)
        })
      })
    })

    seam('attachmentStore', () => {
      it('round-trips bytes and honours delete', async () => {
        await withAdapters(async ({ attachmentStore }) => {
          const payload = bytes(7, 7, 7, 7)
          const { path } = await attachmentStore.writeBytes(VAULT_ID, 'att-1', payload)
          expect(path.length > 0).toBe(true)
          expect(await attachmentStore.exists(VAULT_ID, 'att-1')).toBe(true)
          expect(sameBytes(await attachmentStore.readBytes(VAULT_ID, 'att-1'), payload)).toBe(true)

          await attachmentStore.delete(VAULT_ID, 'att-1')
          expect(await attachmentStore.exists(VAULT_ID, 'att-1')).toBe(false)
        })
      })

      it('returns null rather than throwing for a missing attachment', async () => {
        await withAdapters(async ({ attachmentStore }) => {
          expect(await attachmentStore.readBytes(VAULT_ID, 'never-written')).toBe(null)
        })
      })
    })

    seam('vaultFileSystem', () => {
      it('provisions a root and then finds it — never dead-ends', async () => {
        await withAdapters(async ({ vaultFileSystem }) => {
          const root = await vaultFileSystem.provision(VAULT_ID)
          expect(root.length > 0).toBe(true)
          expect(await vaultFileSystem.resolveVaultRoot(VAULT_ID)).toBe(root)

          const listed = await vaultFileSystem.listLocalVaults()
          expect(listed.some((vault) => vault.vaultId === VAULT_ID)).toBe(true)
        })
      })

      it('is idempotent — provisioning twice returns the same root', async () => {
        await withAdapters(async ({ vaultFileSystem }) => {
          const first = await vaultFileSystem.provision(VAULT_ID)
          expect(await vaultFileSystem.provision(VAULT_ID)).toBe(first)
        })
      })

      it('round-trips note text through nested directories it creates itself', async () => {
        await withAdapters(async ({ vaultFileSystem: fs }) => {
          await fs.provision(VAULT_ID)
          // No mkdir in the interface on purpose: a write that must be preceded
          // by one is a write that can be interrupted between the two.
          await fs.writeFile(VAULT_ID, 'Notes/Nested/Dune.md', '# Dune\n')
          expect(await fs.exists(VAULT_ID, 'Notes/Nested/Dune.md')).toBe(true)
          expect(await fs.readFile(VAULT_ID, 'Notes/Nested/Dune.md')).toBe('# Dune\n')
        })
      })

      it('overwrites in place rather than appending', async () => {
        await withAdapters(async ({ vaultFileSystem: fs }) => {
          await fs.provision(VAULT_ID)
          await fs.writeFile(VAULT_ID, 'Notes/a.md', 'first')
          await fs.writeFile(VAULT_ID, 'Notes/a.md', 'second')
          expect(await fs.readFile(VAULT_ID, 'Notes/a.md')).toBe('second')
        })
      })

      it('round-trips bytes as well as text', async () => {
        await withAdapters(async ({ vaultFileSystem: fs }) => {
          await fs.provision(VAULT_ID)
          await fs.writeBytes(VAULT_ID, 'Files/blob.bin', bytes(0, 1, 254, 255))
          expect(
            sameBytes(await fs.readBytes(VAULT_ID, 'Files/blob.bin'), bytes(0, 1, 254, 255))
          ).toBe(true)
        })
      })

      it('answers absence with null / false rather than throwing', async () => {
        await withAdapters(async ({ vaultFileSystem: fs }) => {
          await fs.provision(VAULT_ID)
          expect(await fs.readFile(VAULT_ID, 'Notes/missing.md')).toBe(null)
          expect(await fs.readBytes(VAULT_ID, 'Notes/missing.md')).toBe(null)
          expect(await fs.exists(VAULT_ID, 'Notes/missing.md')).toBe(false)
          expect(await fs.remove(VAULT_ID, 'Notes/missing.md')).toBe(false)
          expect(await fs.list(VAULT_ID, 'Notes/missing-dir')).toEqual([])
        })
      })

      it('renames across directories, creating the destination parents', async () => {
        await withAdapters(async ({ vaultFileSystem: fs }) => {
          await fs.provision(VAULT_ID)
          await fs.writeFile(VAULT_ID, 'Notes/old.md', 'body')
          await fs.rename(VAULT_ID, 'Notes/old.md', 'Archive/2026/new.md')

          expect(await fs.exists(VAULT_ID, 'Notes/old.md')).toBe(false)
          expect(await fs.readFile(VAULT_ID, 'Archive/2026/new.md')).toBe('body')
        })
      })

      it('lists a directory non-recursively, tagging files and directories', async () => {
        await withAdapters(async ({ vaultFileSystem: fs }) => {
          await fs.provision(VAULT_ID)
          await fs.writeFile(VAULT_ID, 'Notes/a.md', 'a')
          await fs.writeFile(VAULT_ID, 'Notes/sub/b.md', 'b')

          const entries = await fs.list(VAULT_ID, 'Notes')
          expect(entries.some((e) => e.path === 'Notes/a.md' && e.kind === 'file')).toBe(true)
          expect(entries.some((e) => e.path === 'Notes/sub' && e.kind === 'directory')).toBe(true)
          // Non-recursive: the nested file is NOT reported at this level.
          expect(entries.some((e) => e.path === 'Notes/sub/b.md')).toBe(false)
        })
      })

      it('removes an empty directory but refuses one that still holds a note', async () => {
        await withAdapters(async ({ vaultFileSystem: fs }) => {
          await fs.provision(VAULT_ID)
          await fs.writeFile(VAULT_ID, 'Empty/.DS_Store', '')
          await fs.writeFile(VAULT_ID, 'Kept/note.md', 'x')

          expect(await fs.removeDirIfEmpty(VAULT_ID, 'Empty', ['.DS_Store'])).toBe(true)
          // The whole point of the ignore list: anything NOT in it makes this a
          // no-op, because a recursive delete here would be data loss.
          expect(await fs.removeDirIfEmpty(VAULT_ID, 'Kept', ['.DS_Store'])).toBe(false)
          expect(await fs.readFile(VAULT_ID, 'Kept/note.md')).toBe('x')
        })
      })
    })

    seam('crdtStorePath', () => {
      it('resolves a stable root and can ensure it exists twice', async () => {
        await withAdapters(async ({ crdtStorePath }) => {
          const root = await crdtStorePath.storeRootFor(VAULT_ID)
          expect(root.length > 0).toBe(true)
          expect(await crdtStorePath.storeRootFor(VAULT_ID)).toBe(root)

          await crdtStorePath.ensureExists(root)
          await crdtStorePath.ensureExists(root)
        })
      })
    })

    seam('deviceRegistration', () => {
      it('reports a stable device id and a describable device', async () => {
        await withAdapters(async ({ deviceRegistration }) => {
          const id = await deviceRegistration.deviceId()
          expect(id.length > 0).toBe(true)
          expect(await deviceRegistration.deviceId()).toBe(id)

          const info = await deviceRegistration.deviceInfo()
          expect(['desktop', 'ios', 'android'].includes(info.platform)).toBe(true)
          expect(info.appVersion.length > 0).toBe(true)
        })
      })

      it('produces Ed25519-shaped signing material', async () => {
        await withAdapters(async ({ deviceRegistration }) => {
          const signer = await deviceRegistration.signingKeypair(VAULT_ID)
          expect(signer.publicKey.length).toBe(32)

          const signature = await signer.sign(bytes(1, 2, 3))
          expect(signature.length).toBe(64)
        })
      })
    })

    seam('crdtProvider', () => {
      it('delivers frames from the UI and detaches cleanly', async () => {
        await withAdapters(async ({ crdtProvider }) => {
          const fromUi: Uint8Array[][] = []
          let emit: ((frames: Uint8Array[]) => void) | undefined

          const transport: CrdtTransport = {
            originTag: 'conformance',
            sendToUi: () => undefined,
            onFromUi: (cb) => {
              emit = cb
              return () => {
                emit = undefined
              }
            }
          }

          const detach = crdtProvider.attach(DOC_ID, transport)
          expect(typeof emit).toBe('function')

          emit?.([bytes(1)])
          fromUi.push([bytes(1)])

          detach()
          expect(fromUi.length).toBe(1)
        })
      })
    })

    seam('crdtPreflight', () => {
      it('reports health for a provisioned vault', async () => {
        await withAdapters(async ({ crdtPreflight, vaultFileSystem }) => {
          await vaultFileSystem.provision(VAULT_ID)
          const result = await crdtPreflight.verifyStoreHealth(VAULT_ID)
          expect(typeof result.ok).toBe('boolean')
        })
      })
    })

    seam('http', () => {
      it('answers isMetered and hands back an unsubscribe', async () => {
        await withAdapters(async ({ http }) => {
          expect(typeof (await http.isMetered())).toBe('boolean')

          const unsubscribe = http.onOnlineChanged(() => undefined)
          expect(typeof unsubscribe).toBe('function')
          unsubscribe()
        })
      })
    })

    seam('certificatePinning', () => {
      it('accepts a pin list and reports whether it enforces it', async () => {
        await withAdapters(async ({ certificatePinning }) => {
          certificatePinning.configure([])
          expect(typeof certificatePinning.isEnforced()).toBe('boolean')
        })
      })
    })

    seam('runtime', () => {
      it('reports version and platform, and hands back unsubscribes', async () => {
        await withAdapters(async ({ runtime }) => {
          expect(runtime.appVersion().length > 0).toBe(true)
          expect(['desktop', 'ios', 'android'].includes(runtime.platform())).toBe(true)

          const stopForeground = runtime.onForeground(() => undefined)
          const stopBackground = runtime.onBackground(() => undefined)
          expect(typeof stopForeground).toBe('function')
          expect(typeof stopBackground).toBe('function')
          stopForeground()
          stopBackground()
        })
      })

      it('exposes a logger rather than reaching for console', async () => {
        await withAdapters(async ({ runtime }) => {
          runtime.log.info('conformance', { seam: 'runtime' })
          expect(typeof runtime.log.error).toBe('function')
        })
      })
    })
  })
}
