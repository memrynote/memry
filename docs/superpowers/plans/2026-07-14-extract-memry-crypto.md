# Extract @memry/crypto Implementation Plan

> Agentic workers: use the **superpowers:subagent-driven-development** sub-skill to execute this plan. Every step below is a checkbox; check it off only when its exact verification evidence is green. Do NOT check off a task whose tests are not passing.

**Goal:** Move the pure client-crypto surface out of `apps/desktop/src/main/crypto` into a new zero-Electron workspace package `@memry/crypto`, behind three injectable seams (`SodiumProvider`, `SecretStore`, `CryptoLogger`), re-exporting from every old desktop path so all 36 consumer files stay byte-for-byte unchanged.

**Architecture:** `@memry/crypto` holds the encryption / keys / signatures / primitives / recovery / cbor / vault-key-state / crypto-errors / memory-lock logic as a host-agnostic library. It never imports `libsodium-wrappers-sumo`, `keytar`, or `electron-log` directly — it calls `getSodium()`, `getSecretStore()`, `getCryptoLogger()`, which the host wires once via `setSodium()` / `setSecretStore()` / `setCryptoLogger()`. Desktop injects `libsodium-wrappers-sumo`, its existing `keychain.ts` (keytar, which STAYS in desktop), and `createLogger('CryptoMemLock')`. Every moved file keeps a thin re-export shim at its old desktop path; the moved tests are the red→green extraction gate and desktop stays green throughout.

**Tech Stack:** TypeScript (ESM, `type: module`), libsodium-wrappers-sumo `^0.8.2` (desktop-injected), bip39 `^3.1.0`, cborg `^4.5.8`, drizzle-orm `^0.45.2`, `@memry/contracts` (workspace), `@memry/db-schema` (workspace), Vitest `4.1.8` (run through the desktop `shared` project).

## Global Constraints

Copy these project-wide constraints verbatim; they bind every task:

- Backward compatibility is MANDATORY for production installs: every change must work for existing installs, no DB resets, sync protocol / IPC contracts / vault file formats / settings shapes must tolerate data written by older app versions.
- DB schema changes go through additive, hand-written D1/data-DB migrations that preserve existing rows (Drizzle snapshots broken past 0021; data-DB migrations are hand-written).
- Sync-server deploys BEFORE desktop/mobile clients for every additive change (D6 sync item types, D8 settings-push, entitlement_grants).
- **Crypto parameters are IMMUTABLE and byte-identical across clients:** Argon2id v1.3 ops=3, mem=64 MiB, parallelism=1; BLAKE2b `crypto_kdf_derive_from_key` with exact 8-char contexts (`memryvlt`/`memrysgn`/`memryvrf`/`memrykve`/`memrylnk`/`memrymac`/`memrysas`); base64 = `sodium.base64_variants.ORIGINAL` (standard alphabet, padded); cryptoVersion=1; canonical CBOR in `CBOR_FIELD_ORDER`. This extraction is a **pure move** — no logic edits, no parameter changes. The `SodiumProvider` seam must not alter them.
- E2E-encrypted: server never sees plaintext; it verifies Ed25519 via WebCrypto and validates envelope lengths only.
- Offline-first: SQLite local storage is canonical on mobile; CRDT (Yjs) for note/journal bodies, field-level vector clocks for tasks/projects/calendar; correctness never depends on background execution.
- `@blocknote/*`, `yjs`, and `zod` pinned IDENTICALLY to desktop across clients; a CI check fails the mobile build on drift.
- `@memry/contracts` is the single wire-format source of truth; mobile MUST import, never copy (copying breaks cross-device crypto/signature interop).
- No Co-Authored-By trailer on commit messages.
- Prettier: single quotes, no semicolons, 100-char width, no trailing commas.
- RTL safety: new code uses logical props; RN uses `I18nManager.forceRTL`. (No UI in this workstream.)
- **Extraction principle:** move files, re-export from old paths, tests move with the code, desktop consumes the new package first — each extraction keeps desktop green, verified by the existing suite before mobile exists.
- Logging via a `CryptoLogger` seam (never raw `console.*`, never `electron-log` inside the package); user-facing errors via `extractErrorMessage(err, fallback)` at the host layer.
- WCAG AA + reduced-motion + RTL accessibility per PRODUCT.md. (No UI in this workstream.)

**Version pins used here:** `libsodium-wrappers-sumo ^0.8.2` (+ `@types/libsodium-wrappers-sumo ^0.8.2`), `bip39 ^3.1.0`, `cborg ^4.5.8`, `drizzle-orm ^0.45.2`, `zod ^4.3.4` (transitively via `@memry/contracts`).

**Gate:** This workstream depends on Phase-0 spike #1 (libsodium byte-compat) being GREEN. That spike validates the _mobile_ provider; this plan is the _desktop_ extraction and does not itself change any crypto bytes.

---

## File Structure

### Created — `packages/crypto/`

| Path                                                                          | Single responsibility                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/crypto/package.json`                                                | `@memry/crypto` manifest: private, `type: module`, exports map (`.` + one subpath per module + the three seams), deps `libsodium-wrappers-sumo`/`bip39`/`cborg`/`drizzle-orm`/`@memry/contracts`/`@memry/db-schema`, devDeps `@memry/typescript-config`/`@types/libsodium-wrappers-sumo`/`better-sqlite3`/`@types/better-sqlite3`/`vitest`. NO keytar, NO electron, NO electron-log. |
| `packages/crypto/tsconfig.json`                                               | Extends `@memry/typescript-config/node.json`; `include: ["src/**/*"]`; excludes test files.                                                                                                                                                                                                                                                                                          |
| `packages/crypto/src/sodium-provider.ts`                                      | `SodiumProvider` seam: module singleton, `setSodium`/`getSodium`. Type = the `libsodium-wrappers-sumo` default-export type.                                                                                                                                                                                                                                                          |
| `packages/crypto/src/secret-store.ts`                                         | `SecretStore` seam: `{ storeKey, retrieveKey, deleteKey }` keyed by `KeychainEntry`; `setSecretStore`/`getSecretStore`.                                                                                                                                                                                                                                                              |
| `packages/crypto/src/logger.ts`                                               | `CryptoLogger` seam `{ warn }`; default no-op; `setCryptoLogger`/`getCryptoLogger`.                                                                                                                                                                                                                                                                                                  |
| `packages/crypto/src/crypto-errors.ts`                                        | `CryptoError` class + `CryptoErrorCode` type (pure, moved verbatim).                                                                                                                                                                                                                                                                                                                 |
| `packages/crypto/src/cbor.ts`                                                 | `encodeCbor` + re-export `CBOR_FIELD_ORDER` (cborg, no sodium; moved verbatim).                                                                                                                                                                                                                                                                                                      |
| `packages/crypto/src/encryption.ts`                                           | XChaCha20-Poly1305 encrypt/decrypt/wrap/linking; sodium via `getSodium()`.                                                                                                                                                                                                                                                                                                           |
| `packages/crypto/src/memory-lock.ts`                                          | `lockKeyMaterial`/`unlockKeyMaterial`; sodium via `getSodium()`, warnings via `getCryptoLogger()`.                                                                                                                                                                                                                                                                                   |
| `packages/crypto/src/primitives.ts`                                           | `generateFileKey`/`secureCleanup`; sodium via `getSodium()`, unlock via `./memory-lock`.                                                                                                                                                                                                                                                                                             |
| `packages/crypto/src/signatures.ts`                                           | `signPayload`/`verifySignature` over canonical CBOR; sodium via `getSodium()`.                                                                                                                                                                                                                                                                                                       |
| `packages/crypto/src/keys.ts`                                                 | KDF / Argon2id / device / X25519 / linking keys; sodium via `getSodium()`, keychain via `getSecretStore()`.                                                                                                                                                                                                                                                                          |
| `packages/crypto/src/recovery.ts`                                             | bip39 recovery phrase → master key; sodium via `getSodium()`.                                                                                                                                                                                                                                                                                                                        |
| `packages/crypto/src/vault-key-state.ts`                                      | Vault-key verifier binding; sodium via `getSodium()`, keychain via `getSecretStore()`, `db` param generalized to `BaseSQLiteDatabase`.                                                                                                                                                                                                                                               |
| `packages/crypto/src/index.ts`                                                | Package barrel: owns `constantTimeEqual` + `initCrypto`, re-exports every module symbol + `CBOR_FIELD_ORDER`, exports the three seams. Does NOT export keychain.                                                                                                                                                                                                                     |
| `packages/crypto/src/__fixtures__/*.ts`                                       | RFC test vectors + `load-vectors` loader (moved verbatim).                                                                                                                                                                                                                                                                                                                           |
| `packages/crypto/src/*.test.ts`, `packages/crypto/src/__fixtures__/*.test.ts` | Moved test suites — the extraction gate.                                                                                                                                                                                                                                                                                                                                             |

### Modified — `apps/desktop/`

| Path                                                                                                                              | Change                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/main/crypto/index.ts`                                                                                           | Becomes the desktop compat barrel: wires the three seams at module load (`setSodium(libsodiumSumo)`, `setSecretStore({storeKey,retrieveKey,deleteKey})`, `setCryptoLogger(createLogger('CryptoMemLock'))`), re-exports all moved symbols from `@memry/crypto`, keeps local `keychain` re-exports. |
| `apps/desktop/src/main/crypto/{crypto-errors,cbor,encryption,memory-lock,primitives,signatures,keys,recovery,vault-key-state}.ts` | Each replaced by a re-export shim to the matching `@memry/crypto/<sub>` subpath (preserves deep-path imports + `vi.mock` targets).                                                                                                                                                                |
| `apps/desktop/src/main/crypto/keychain.ts`                                                                                        | STAYS (keytar). No move. Adapted into `SecretStore` shape by `index.ts` (its signatures already match).                                                                                                                                                                                           |
| `apps/desktop/src/main/crypto/index.test.ts`                                                                                      | Repurposed as the regression gate: asserts the old `../crypto` barrel still re-exports every moved symbol + keychain and that the seams are wired.                                                                                                                                                |
| `apps/desktop/tests/setup.ts`                                                                                                     | Adds a global `beforeAll` that wires `setSodium(realSodium)` + a default no-op `SecretStore` + no-op `CryptoLogger`, so every desktop test file has the seams populated.                                                                                                                          |
| `apps/desktop/src/main/index.ts`                                                                                                  | Adds a top-of-file side-effect import of `'./crypto'` so the desktop seam wiring runs before any deep-path crypto call at runtime.                                                                                                                                                                |
| `apps/desktop/config/vitest.config.ts`                                                                                            | Adds `'../../packages/crypto/src/**/*.{test,spec}.{ts,tsx}'` to the `shared` project include and to the coverage `include`.                                                                                                                                                                       |
| `apps/desktop/tsconfig.node.json`, `apps/desktop/tsconfig.json`                                                                   | Add `@memry/crypto` + `@memry/crypto/*` path aliases and `../../packages/crypto/src/**/*` to `include`.                                                                                                                                                                                           |
| `apps/desktop/electron.vite.config.ts`                                                                                            | Adds `@memry/crypto` → `packages/crypto/src` to the shared alias map.                                                                                                                                                                                                                             |
| `apps/desktop/package.json`                                                                                                       | Adds `"@memry/crypto": "workspace:*"`; drops `bip39`/`cborg` iff no other desktop consumer remains (keeps `libsodium-wrappers-sumo`, `keytar`).                                                                                                                                                   |
| `package.json` (root)                                                                                                             | Adds `--filter=@memry/crypto` to the `typecheck` turbo command.                                                                                                                                                                                                                                   |

---

## Task 1: Scaffold `@memry/crypto` and wire it into the desktop build

**Files:**

- Create: `packages/crypto/package.json`
- Create: `packages/crypto/tsconfig.json`
- Create: `packages/crypto/src/index.ts` (placeholder, filled in Task 10)
- Create: `packages/crypto/src/placeholder.test.ts` (deleted in Task 3)
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/tsconfig.node.json`, `apps/desktop/tsconfig.json`
- Modify: `apps/desktop/electron.vite.config.ts`
- Modify: `apps/desktop/config/vitest.config.ts`
- Modify: `package.json` (root)

**Interfaces:**

- Produces: workspace package `@memry/crypto` resolvable via `@memry/crypto` (barrel) and `@memry/crypto/<sub>` subpaths.

Steps:

- [ ] **Step 1: Write the failing test.** Create `packages/crypto/src/placeholder.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest'

  describe('@memry/crypto scaffold', () => {
    it('package barrel is importable', async () => {
      const mod = await import('./index')
      expect(mod).toBeDefined()
    })
  })
  ```

- [ ] **Step 2: Run it, expect FAIL.** The glob is not yet in the vitest config, so the file is not collected:

  ```bash
  pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared packages/crypto
  ```

  Expected: `No test files found` (glob absent) — a red gate for "package not wired".

- [ ] **Step 3: Minimal implementation.** Create `packages/crypto/package.json`:

  ```json
  {
    "name": "@memry/crypto",
    "version": "0.1.0",
    "private": true,
    "license": "AGPL-3.0-only",
    "type": "module",
    "exports": {
      ".": "./src/index.ts",
      "./sodium-provider": "./src/sodium-provider.ts",
      "./secret-store": "./src/secret-store.ts",
      "./logger": "./src/logger.ts",
      "./crypto-errors": "./src/crypto-errors.ts",
      "./cbor": "./src/cbor.ts",
      "./encryption": "./src/encryption.ts",
      "./memory-lock": "./src/memory-lock.ts",
      "./primitives": "./src/primitives.ts",
      "./signatures": "./src/signatures.ts",
      "./keys": "./src/keys.ts",
      "./recovery": "./src/recovery.ts",
      "./vault-key-state": "./src/vault-key-state.ts"
    },
    "types": "./src/index.ts",
    "scripts": {
      "typecheck": "tsc --noEmit -p tsconfig.json"
    },
    "dependencies": {
      "@memry/contracts": "workspace:*",
      "@memry/db-schema": "workspace:*",
      "bip39": "^3.1.0",
      "cborg": "^4.5.8",
      "drizzle-orm": "^0.45.2",
      "libsodium-wrappers-sumo": "^0.8.2"
    },
    "devDependencies": {
      "@memry/typescript-config": "workspace:*",
      "@types/better-sqlite3": "^7.6.13",
      "@types/libsodium-wrappers-sumo": "^0.8.2",
      "better-sqlite3": "^12.5.0"
    }
  }
  ```

  Create `packages/crypto/tsconfig.json` (copy of `packages/shared/tsconfig.json`):

  ```json
  {
    "extends": "@memry/typescript-config/node.json",
    "include": ["src/**/*"],
    "exclude": ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"]
  }
  ```

  Create `packages/crypto/src/index.ts` (placeholder):

  ```ts
  export {}
  ```

  In `apps/desktop/package.json` add to `dependencies` (alphabetical, next to `@memry/shared`):

  ```json
  "@memry/crypto": "workspace:*",
  ```

  In `apps/desktop/config/vitest.config.ts`, add to the `shared` project `include` array (after the `contracts` line):

  ```ts
  '../../packages/crypto/src/**/*.{test,spec}.{ts,tsx}',
  ```

  and to the coverage `include` array:

  ```ts
  '../../packages/crypto/src/**/*.ts',
  ```

  In `apps/desktop/config/vitest.config.ts` `resolve.alias`, add:

  ```ts
  '@memry/crypto': resolve(workspaceRoot, 'packages/crypto/src'),
  ```

  In `apps/desktop/tsconfig.node.json` `compilerOptions.paths`, add (next to `@memry/shared`):

  ```json
  "@memry/crypto": ["../../packages/crypto/src/index.ts"],
  "@memry/crypto/*": ["../../packages/crypto/src/*"],
  ```

  and to `include`:

  ```json
  "../../packages/crypto/src/**/*",
  ```

  Mirror the same two `paths` entries in `apps/desktop/tsconfig.json` `compilerOptions.paths`.
  In `apps/desktop/electron.vite.config.ts`, add to the shared alias object (next to the other `@memry/*` entries):

  ```ts
  '@memry/crypto': resolve(workspaceRoot, 'packages/crypto/src'),
  ```

  In root `package.json` `scripts.typecheck`, add `--filter=@memry/crypto` to the turbo filter list (next to `--filter=@memry/shared`).
  Install:

  ```bash
  pnpm install
  ```

- [ ] **Step 4: Run tests, expect PASS.**

  ```bash
  pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared packages/crypto
  ```

  Expected: `1 passed` (placeholder.test.ts). Then confirm the alias resolves for the type layer:

  ```bash
  pnpm --filter @memry/crypto typecheck
  ```

  Expected: exit 0.

- [ ] **Step 5: Commit.**
  ```bash
  git add packages/crypto apps/desktop/package.json apps/desktop/tsconfig.node.json apps/desktop/tsconfig.json apps/desktop/electron.vite.config.ts apps/desktop/config/vitest.config.ts package.json pnpm-lock.yaml
  git commit -m "chore(crypto): scaffold @memry/crypto package and wire desktop build"
  ```

---

## Task 2: Introduce the three seams (SodiumProvider, SecretStore, CryptoLogger)

**Files:**

- Create: `packages/crypto/src/sodium-provider.ts`
- Create: `packages/crypto/src/secret-store.ts`
- Create: `packages/crypto/src/logger.ts`
- Create: `packages/crypto/src/seams.test.ts`
- Modify: `packages/crypto/src/index.ts` (export the seams)

**Interfaces:**

- Produces:
  - `type SodiumProvider` (= `libsodium-wrappers-sumo` default-export type); `setSodium(p: SodiumProvider): void`; `getSodium(): SodiumProvider` (throws if unset).
  - `interface SecretStore { storeKey(entry: KeychainEntry, key: Uint8Array): Promise<void>; retrieveKey(entry: KeychainEntry): Promise<Uint8Array | null>; deleteKey(entry: KeychainEntry): Promise<void> }`; `setSecretStore(s): void`; `getSecretStore(): SecretStore` (throws if unset).
  - `interface CryptoLogger { warn(msg: string, ...args: unknown[]): void }`; `setCryptoLogger(l): void`; `getCryptoLogger(): CryptoLogger` (defaults to no-op).
- Consumes: `KeychainEntry` from `@memry/contracts/crypto`.

Steps:

- [ ] **Step 1: Write the failing test.** Create `packages/crypto/src/seams.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest'

  import { getSodium, setSodium } from './sodium-provider'
  import { getSecretStore, setSecretStore } from './secret-store'
  import { getCryptoLogger, setCryptoLogger } from './logger'

  describe('SodiumProvider seam', () => {
    it('getSodium throws before setSodium', () => {
      expect(() => getSodium()).toThrow(/SodiumProvider not set/)
    })

    it('returns the injected provider after setSodium', () => {
      const fake = { crypto_pwhash: () => new Uint8Array(0) } as never
      setSodium(fake)
      expect(getSodium()).toBe(fake)
    })
  })

  describe('SecretStore seam', () => {
    it('getSecretStore throws before setSecretStore', () => {
      expect(() => getSecretStore()).toThrow(/SecretStore not set/)
    })

    it('returns the injected store after setSecretStore', async () => {
      const store = {
        storeKey: async () => {},
        retrieveKey: async () => null,
        deleteKey: async () => {}
      }
      setSecretStore(store)
      expect(getSecretStore()).toBe(store)
      await expect(getSecretStore().retrieveKey({ service: 's', account: 'a' })).resolves.toBeNull()
    })
  })

  describe('CryptoLogger seam', () => {
    it('defaults to a no-op logger that does not throw', () => {
      expect(() => getCryptoLogger().warn('hello')).not.toThrow()
    })

    it('uses the injected logger after setCryptoLogger', () => {
      const calls: string[] = []
      setCryptoLogger({ warn: (m) => calls.push(m) })
      getCryptoLogger().warn('warned')
      expect(calls).toEqual(['warned'])
    })
  })
  ```

- [ ] **Step 2: Run it, expect FAIL.**

  ```bash
  pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared packages/crypto/src/seams.test.ts
  ```

  Expected: FAIL — `Cannot find module './sodium-provider'` (and the sibling seam modules).

- [ ] **Step 3: Minimal implementation.** Create `packages/crypto/src/sodium-provider.ts`:

  ```ts
  type SodiumModule = typeof import('libsodium-wrappers-sumo')
  export type SodiumProvider = SodiumModule['default']

  let provider: SodiumProvider | null = null

  export const setSodium = (p: SodiumProvider): void => {
    provider = p
  }

  export const getSodium = (): SodiumProvider => {
    if (!provider) {
      throw new Error(
        'SodiumProvider not set — call setSodium(...) before using @memry/crypto ' +
          '(desktop wires it in main/crypto/index.ts; tests wire it in beforeAll).'
      )
    }
    return provider
  }
  ```

  Create `packages/crypto/src/secret-store.ts`:

  ```ts
  import type { KeychainEntry } from '@memry/contracts/crypto'

  export interface SecretStore {
    storeKey(entry: KeychainEntry, key: Uint8Array): Promise<void>
    retrieveKey(entry: KeychainEntry): Promise<Uint8Array | null>
    deleteKey(entry: KeychainEntry): Promise<void>
  }

  let store: SecretStore | null = null

  export const setSecretStore = (s: SecretStore): void => {
    store = s
  }

  export const getSecretStore = (): SecretStore => {
    if (!store) {
      throw new Error(
        'SecretStore not set — call setSecretStore(...) before using @memry/crypto key APIs.'
      )
    }
    return store
  }
  ```

  Create `packages/crypto/src/logger.ts`:

  ```ts
  export interface CryptoLogger {
    warn(msg: string, ...args: unknown[]): void
  }

  let logger: CryptoLogger = { warn: () => {} }

  export const setCryptoLogger = (l: CryptoLogger): void => {
    logger = l
  }

  export const getCryptoLogger = (): CryptoLogger => logger
  ```

  Replace `packages/crypto/src/index.ts` placeholder with the seam exports:

  ```ts
  export { getSodium, setSodium } from './sodium-provider'
  export type { SodiumProvider } from './sodium-provider'
  export { getSecretStore, setSecretStore } from './secret-store'
  export type { SecretStore } from './secret-store'
  export { getCryptoLogger, setCryptoLogger } from './logger'
  export type { CryptoLogger } from './logger'
  ```

- [ ] **Step 4: Run tests, expect PASS.**

  ```bash
  pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared packages/crypto/src/seams.test.ts
  pnpm --filter @memry/crypto typecheck
  ```

  Expected: `6 passed`; typecheck exit 0.

- [ ] **Step 5: Commit.**
  ```bash
  git add packages/crypto/src
  git commit -m "feat(crypto): add SodiumProvider, SecretStore, CryptoLogger seams"
  ```

---

## Task 3: Move the pure modules — crypto-errors + cbor

**Files:**

- Create: `packages/crypto/src/crypto-errors.ts`
- Create: `packages/crypto/src/cbor.ts`
- Create: `packages/crypto/src/crypto-errors.test.ts` (moved)
- Create: `packages/crypto/src/cbor.test.ts` (moved)
- Modify (→ shim): `apps/desktop/src/main/crypto/crypto-errors.ts`
- Modify (→ shim): `apps/desktop/src/main/crypto/cbor.ts`
- Delete: `apps/desktop/src/main/crypto/crypto-errors.test.ts`, `apps/desktop/src/main/crypto/cbor.test.ts`, `packages/crypto/src/placeholder.test.ts`

**Interfaces:**

- Produces: `class CryptoError extends Error { code: CryptoErrorCode }`; `type CryptoErrorCode = 'INVALID_KEY_LENGTH' | 'INVALID_NONCE_LENGTH' | 'DECRYPTION_FAILED' | 'ENCRYPTION_FAILED'`; `encodeCbor(data: Record<string, unknown>, fieldOrder: readonly string[]): Uint8Array`; re-export `CBOR_FIELD_ORDER`.

Steps:

- [ ] **Step 1: Move the tests with the code.** Move both test files verbatim (they are pure — no sodium, no keychain):

  ```bash
  git mv apps/desktop/src/main/crypto/crypto-errors.test.ts packages/crypto/src/crypto-errors.test.ts
  git mv apps/desktop/src/main/crypto/cbor.test.ts packages/crypto/src/cbor.test.ts
  git rm packages/crypto/src/placeholder.test.ts
  ```

  These import `./crypto-errors` and `./cbor` which do not exist yet in the package.

- [ ] **Step 2: Run it, expect FAIL.**

  ```bash
  pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared packages/crypto/src/crypto-errors.test.ts packages/crypto/src/cbor.test.ts
  ```

  Expected: FAIL — `Cannot find module './crypto-errors'` / `'./cbor'`.

- [ ] **Step 3: Move the source and add shims.** Move both source files verbatim (their bodies are already Electron-free and sodium-free):

  ```bash
  git mv apps/desktop/src/main/crypto/crypto-errors.ts packages/crypto/src/crypto-errors.ts
  git mv apps/desktop/src/main/crypto/cbor.ts packages/crypto/src/cbor.ts
  ```

  (`packages/crypto/src/cbor.ts` keeps `import { encode } from 'cborg'` and `import { CBOR_FIELD_ORDER } from '@memry/contracts/cbor-ordering'` unchanged.)
  Recreate `apps/desktop/src/main/crypto/crypto-errors.ts` as a shim:

  ```ts
  export { CryptoError } from '@memry/crypto/crypto-errors'
  export type { CryptoErrorCode } from '@memry/crypto/crypto-errors'
  ```

  Recreate `apps/desktop/src/main/crypto/cbor.ts` as a shim:

  ```ts
  export { CBOR_FIELD_ORDER, encodeCbor } from '@memry/crypto/cbor'
  ```

- [ ] **Step 4: Run tests, expect PASS.** Moved package tests first:

  ```bash
  pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared packages/crypto/src/crypto-errors.test.ts packages/crypto/src/cbor.test.ts
  ```

  Expected: all green. Then confirm desktop deep-path consumers (`sync/sync-errors.ts`, `sync/decrypt-item.ts`) still resolve `../crypto/crypto-errors` through the shim:

  ```bash
  pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project main src/main/sync/sync-errors.test.ts
  ```

  Expected: green.

- [ ] **Step 5: Commit.**
  ```bash
  git add packages/crypto apps/desktop/src/main/crypto
  git commit -m "refactor(crypto): move crypto-errors and cbor to @memry/crypto with desktop shims"
  ```

---

## Task 4: Wire desktop host seams and move encryption

**Files:**

- Create: `packages/crypto/src/encryption.ts`
- Create: `packages/crypto/src/encryption.test.ts` (moved)
- Modify (→ shim): `apps/desktop/src/main/crypto/encryption.ts`
- Modify: `apps/desktop/src/main/crypto/index.ts` (add seam wiring side-effects; still keeps its own local exports for now)
- Modify: `apps/desktop/tests/setup.ts` (global seam wiring for tests)
- Modify: `apps/desktop/src/main/index.ts` (side-effect import of `'./crypto'` at top)
- Delete: `apps/desktop/src/main/crypto/encryption.test.ts`

**Interfaces:**

- Consumes: `getSodium()` (Task 2); `CryptoError` (Task 3); `XCHACHA20_PARAMS` from `@memry/contracts/crypto`.
- Produces: `generateNonce(): Uint8Array`; `encrypt(plaintext, key, associatedData?): { ciphertext: Uint8Array; nonce: Uint8Array }`; `decrypt(ciphertext, nonce, key, associatedData?): Uint8Array`; `wrapFileKey(fileKey, vaultKey): { wrappedKey, nonce }`; `unwrapFileKey(wrappedKey, nonce, vaultKey): Uint8Array`; `encryptMasterKeyForLinking(masterKey, encKey): { ciphertext, nonce }`; `decryptMasterKeyFromLinking(ciphertext, nonce, encKey): Uint8Array`.

Steps:

- [ ] **Step 1: Move the test with the code.** `encryption.test.ts` uses real libsodium via `import sodium ... beforeAll(await sodium.ready)`. The global test seam wiring (added below in this task) calls `setSodium(sodium)`, so the moved test runs unchanged:

  ```bash
  git mv apps/desktop/src/main/crypto/encryption.test.ts packages/crypto/src/encryption.test.ts
  ```

- [ ] **Step 2: Run it, expect FAIL.**

  ```bash
  pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared packages/crypto/src/encryption.test.ts
  ```

  Expected: FAIL — `Cannot find module './encryption'`.

- [ ] **Step 3: Move the source, add the shim, and wire the seams.**
      Move and rewrite the sodium import in `packages/crypto/src/encryption.ts` — the ONLY change is the sodium source; all logic and error handling stay byte-identical:

  ```ts
  import { XCHACHA20_PARAMS } from '@memry/contracts/crypto'
  import { CryptoError } from './crypto-errors'
  import { getSodium } from './sodium-provider'

  export const generateNonce = (): Uint8Array => {
    const sodium = getSodium()
    const nonce = sodium.randombytes_buf(XCHACHA20_PARAMS.NONCE_LENGTH)

    if (nonce.length !== XCHACHA20_PARAMS.NONCE_LENGTH) {
      throw new Error(
        `Nonce length mismatch: expected ${XCHACHA20_PARAMS.NONCE_LENGTH}, got ${nonce.length}`
      )
    }

    return nonce
  }

  export const encrypt = (
    plaintext: Uint8Array,
    key: Uint8Array,
    associatedData?: Uint8Array
  ): { ciphertext: Uint8Array; nonce: Uint8Array } => {
    const sodium = getSodium()
    if (key.length !== XCHACHA20_PARAMS.KEY_LENGTH) {
      throw new CryptoError(
        'INVALID_KEY_LENGTH',
        `Expected key length ${XCHACHA20_PARAMS.KEY_LENGTH}, got ${key.length}`
      )
    }

    const nonce = generateNonce()

    try {
      const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        plaintext,
        associatedData ?? null,
        null,
        nonce,
        key
      )
      return { ciphertext, nonce }
    } catch (err) {
      throw new CryptoError(
        'ENCRYPTION_FAILED',
        err instanceof Error ? err.message : 'Encryption failed'
      )
    }
  }

  export const decrypt = (
    ciphertext: Uint8Array,
    nonce: Uint8Array,
    key: Uint8Array,
    associatedData?: Uint8Array
  ): Uint8Array => {
    const sodium = getSodium()
    if (key.length !== XCHACHA20_PARAMS.KEY_LENGTH) {
      throw new CryptoError(
        'INVALID_KEY_LENGTH',
        `Expected key length ${XCHACHA20_PARAMS.KEY_LENGTH}, got ${key.length}`
      )
    }
    if (nonce.length !== XCHACHA20_PARAMS.NONCE_LENGTH) {
      throw new CryptoError(
        'INVALID_NONCE_LENGTH',
        `Expected nonce length ${XCHACHA20_PARAMS.NONCE_LENGTH}, got ${nonce.length}`
      )
    }

    try {
      return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        ciphertext,
        associatedData ?? null,
        nonce,
        key
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Decryption failed'
      throw new CryptoError(
        'DECRYPTION_FAILED',
        msg.toLowerCase().includes('ciphertext') || msg.toLowerCase().includes('mac')
          ? `Ciphertext authentication failed: ${msg}`
          : msg
      )
    }
  }

  export const wrapFileKey = (
    fileKey: Uint8Array,
    vaultKey: Uint8Array
  ): { wrappedKey: Uint8Array; nonce: Uint8Array } => {
    const result = encrypt(fileKey, vaultKey)
    return { wrappedKey: result.ciphertext, nonce: result.nonce }
  }

  export const unwrapFileKey = (
    wrappedKey: Uint8Array,
    nonce: Uint8Array,
    vaultKey: Uint8Array
  ): Uint8Array => {
    const sodium = getSodium()
    const fileKey = decrypt(wrappedKey, nonce, vaultKey)

    try {
      return new Uint8Array(fileKey)
    } finally {
      sodium.memzero(fileKey)
    }
  }

  export const encryptMasterKeyForLinking = (
    masterKey: Uint8Array,
    encKey: Uint8Array
  ): { ciphertext: Uint8Array; nonce: Uint8Array } => {
    return encrypt(masterKey, encKey)
  }

  export const decryptMasterKeyFromLinking = (
    ciphertext: Uint8Array,
    nonce: Uint8Array,
    encKey: Uint8Array
  ): Uint8Array => {
    return decrypt(ciphertext, nonce, encKey)
  }
  ```

  ```bash
  git rm apps/desktop/src/main/crypto/encryption.ts
  ```

  Recreate `apps/desktop/src/main/crypto/encryption.ts` as a shim:

  ```ts
  export {
    decrypt,
    decryptMasterKeyFromLinking,
    encrypt,
    encryptMasterKeyForLinking,
    generateNonce,
    unwrapFileKey,
    wrapFileKey
  } from '@memry/crypto/encryption'
  ```

  In `apps/desktop/src/main/crypto/index.ts`, add the desktop seam wiring at the TOP of the module (before its existing re-exports), reusing the local `keychain` functions and `libsodium-wrappers-sumo` it already imports. Insert after the existing `import sodium from 'libsodium-wrappers-sumo'` line:

  ```ts
  import { setCryptoLogger, setSecretStore, setSodium } from '@memry/crypto'
  import { createLogger } from '../lib/logger'
  import { deleteKey, retrieveKey, storeKey } from './keychain'

  // Wire the platform seams for the desktop host at module load, before any
  // synchronous crypto call (encrypt/decrypt/signPayload/generateNonce) runs.
  setSodium(sodium)
  setSecretStore({ storeKey, retrieveKey, deleteKey })
  setCryptoLogger(createLogger('CryptoMemLock'))
  ```

  (Keep the file's existing `export { deleteKey, retrieveKey, storeKey } from './keychain'` — the local import above is additive; remove the now-duplicate later `import { ... } from './keychain'` only if one already existed, otherwise leave the single import.)
  In `apps/desktop/tests/setup.ts`, add the global wiring so every test file has the seams populated (after the existing `vi.mock('keytar', ...)` block):

  ```ts
  import sodium from 'libsodium-wrappers-sumo'
  import { setCryptoLogger, setSecretStore, setSodium } from '@memry/crypto'

  beforeAll(async () => {
    await sodium.ready
    setSodium(sodium)
    setSecretStore({
      storeKey: async () => {},
      retrieveKey: async () => null,
      deleteKey: async () => {}
    })
    setCryptoLogger({ warn: () => {} })
  })
  ```

  In `apps/desktop/src/main/index.ts`, add a side-effect import at the very top of the import block so runtime wiring runs before any deep-path crypto call:

  ```ts
  import './crypto' // wires SodiumProvider/SecretStore/CryptoLogger for the desktop host
  ```

- [ ] **Step 4: Run tests, expect PASS.**

  ```bash
  pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared packages/crypto/src/encryption.test.ts
  ```

  Expected: all encryption tests green (proves the SodiumProvider seam is wired by `tests/setup.ts`). Then the desktop deep-path consumers:

  ```bash
  pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project main src/main/sync/encrypt.test.ts src/main/sync/attachments.test.ts
  ```

  Expected: green (they deep-import `../crypto/encryption` / `../crypto/signatures` etc.; encryption now resolves through the shim).

- [ ] **Step 5: Commit.**
  ```bash
  git add packages/crypto apps/desktop/src/main/crypto apps/desktop/tests/setup.ts apps/desktop/src/main/index.ts
  git commit -m "refactor(crypto): move encryption behind SodiumProvider and wire desktop seams"
  ```

---

## Task 5: Move memory-lock + primitives

**Files:**

- Create: `packages/crypto/src/memory-lock.ts`, `packages/crypto/src/primitives.ts`
- Create: `packages/crypto/src/memory-lock.test.ts`, `packages/crypto/src/primitives.test.ts` (moved)
- Modify (→ shim): `apps/desktop/src/main/crypto/memory-lock.ts`, `apps/desktop/src/main/crypto/primitives.ts`
- Delete: `apps/desktop/src/main/crypto/memory-lock.test.ts`, `apps/desktop/src/main/crypto/primitives.test.ts`

**Interfaces:**

- Consumes: `getSodium()`, `getCryptoLogger()`.
- Produces: `lockKeyMaterial(buffer: Uint8Array): boolean`; `unlockKeyMaterial(buffer: Uint8Array): boolean`; `generateFileKey(): Uint8Array`; `secureCleanup(...buffers: Uint8Array[]): void`.

Steps:

- [ ] **Step 1: Move the tests.** Both use only real libsodium (wired by `tests/setup.ts`); move verbatim:

  ```bash
  git mv apps/desktop/src/main/crypto/memory-lock.test.ts packages/crypto/src/memory-lock.test.ts
  git mv apps/desktop/src/main/crypto/primitives.test.ts packages/crypto/src/primitives.test.ts
  ```

- [ ] **Step 2: Run it, expect FAIL.**

  ```bash
  pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared packages/crypto/src/memory-lock.test.ts packages/crypto/src/primitives.test.ts
  ```

  Expected: FAIL — `Cannot find module './memory-lock'` / `'./primitives'`.

- [ ] **Step 3: Move the source, cut the electron-log import, add shims.** Create `packages/crypto/src/memory-lock.ts` (the `../lib/logger` electron import is replaced by the `getCryptoLogger()` seam; every warn string is kept verbatim):

  ```ts
  import { getCryptoLogger } from './logger'
  import { getSodium } from './sodium-provider'

  type SodiumLockApi = Record<string, unknown> & {
    sodium_mlock?: (buf: Uint8Array) => void
    sodium_munlock?: (buf: Uint8Array) => void
  }

  let warnedMissingMlock = false
  let warnedMissingMunlock = false

  const getLockFunction = (
    name: 'sodium_mlock' | 'sodium_munlock'
  ): ((buf: Uint8Array) => void) | null => {
    const fn = (getSodium() as unknown as SodiumLockApi)[name]
    return typeof fn === 'function' ? fn : null
  }

  export function lockKeyMaterial(buffer: Uint8Array): boolean {
    if (buffer.byteLength === 0) return false
    const log = getCryptoLogger()

    const mlock = getLockFunction('sodium_mlock')
    if (!mlock) {
      if (!warnedMissingMlock) {
        warnedMissingMlock = true
        log.warn(
          'sodium_mlock unavailable in WASM build. Key material will not be pinned to RAM. ' +
            'This is expected in Electron/Node.js — OS-level FDE provides equivalent swap protection.'
        )
      }
      return false
    }

    try {
      mlock(buffer)
      return true
    } catch (err) {
      log.warn('sodium_mlock failed — key material may be swappable:', err)
      return false
    }
  }

  export function unlockKeyMaterial(buffer: Uint8Array): boolean {
    if (buffer.byteLength === 0) return false
    const log = getCryptoLogger()

    const munlock = getLockFunction('sodium_munlock')
    if (!munlock) {
      if (!warnedMissingMunlock) {
        warnedMissingMunlock = true
        log.warn('sodium_munlock unavailable in WASM build. Cleanup will continue without munlock.')
      }
      return false
    }

    try {
      munlock(buffer)
      return true
    } catch (err) {
      log.warn('sodium_munlock failed:', err)
      return false
    }
  }
  ```

  Create `packages/crypto/src/primitives.ts`:

  ```ts
  import { unlockKeyMaterial } from './memory-lock'
  import { getSodium } from './sodium-provider'

  export const generateFileKey = (): Uint8Array => {
    return getSodium().randombytes_buf(32)
  }

  export const secureCleanup = (...buffers: Uint8Array[]): void => {
    const sodium = getSodium()
    for (const buffer of buffers) {
      try {
        unlockKeyMaterial(buffer)
      } finally {
        sodium.memzero(buffer)
      }
    }
  }
  ```

  ```bash
  git rm apps/desktop/src/main/crypto/memory-lock.ts apps/desktop/src/main/crypto/primitives.ts
  ```

  Recreate `apps/desktop/src/main/crypto/memory-lock.ts`:

  ```ts
  export { lockKeyMaterial, unlockKeyMaterial } from '@memry/crypto/memory-lock'
  ```

  Recreate `apps/desktop/src/main/crypto/primitives.ts`:

  ```ts
  export { generateFileKey, secureCleanup } from '@memry/crypto/primitives'
  ```

- [ ] **Step 4: Run tests, expect PASS.**

  ```bash
  pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared packages/crypto/src/memory-lock.test.ts packages/crypto/src/primitives.test.ts
  ```

  Expected: green. Then the desktop `vi.mock('../crypto/primitives')` consumer suite:

  ```bash
  pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project main src/main/sync/worker.test.ts
  ```

  Expected: green (the shim path `../crypto/primitives` still exists for the mock to target).

- [ ] **Step 5: Commit.**
  ```bash
  git add packages/crypto apps/desktop/src/main/crypto
  git commit -m "refactor(crypto): move memory-lock and primitives, drop electron-log via CryptoLogger seam"
  ```

---

## Task 6: Move signatures

**Files:**

- Create: `packages/crypto/src/signatures.ts`, `packages/crypto/src/signatures.test.ts` (moved)
- Modify (→ shim): `apps/desktop/src/main/crypto/signatures.ts`
- Delete: `apps/desktop/src/main/crypto/signatures.test.ts`

**Interfaces:**

- Consumes: `getSodium()`; `encodeCbor` (Task 3).
- Produces: `signPayload(payload: Record<string, unknown>, fieldOrder: readonly string[], secretKey: Uint8Array): Uint8Array`; `verifySignature(payload, fieldOrder, signature: Uint8Array, publicKey: Uint8Array): boolean`.

Steps:

- [ ] **Step 1: Move the test.**

  ```bash
  git mv apps/desktop/src/main/crypto/signatures.test.ts packages/crypto/src/signatures.test.ts
  ```

- [ ] **Step 2: Run it, expect FAIL.**

  ```bash
  pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared packages/crypto/src/signatures.test.ts
  ```

  Expected: FAIL — `Cannot find module './signatures'`.

- [ ] **Step 3: Move the source, add the shim.** Create `packages/crypto/src/signatures.ts`:

  ```ts
  import { encodeCbor } from './cbor'
  import { getSodium } from './sodium-provider'

  export const signPayload = (
    payload: Record<string, unknown>,
    fieldOrder: readonly string[],
    secretKey: Uint8Array
  ): Uint8Array => {
    const message = encodeCbor(payload, fieldOrder)
    return getSodium().crypto_sign_detached(message, secretKey)
  }

  export const verifySignature = (
    payload: Record<string, unknown>,
    fieldOrder: readonly string[],
    signature: Uint8Array,
    publicKey: Uint8Array
  ): boolean => {
    const message = encodeCbor(payload, fieldOrder)
    return getSodium().crypto_sign_verify_detached(signature, message, publicKey)
  }
  ```

  ```bash
  git rm apps/desktop/src/main/crypto/signatures.ts
  ```

  Recreate `apps/desktop/src/main/crypto/signatures.ts`:

  ```ts
  export { signPayload, verifySignature } from '@memry/crypto/signatures'
  ```

- [ ] **Step 4: Run tests, expect PASS.**

  ```bash
  pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared packages/crypto/src/signatures.test.ts
  ```

  Expected: green. Consumer check:

  ```bash
  pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project main src/main/sync/decrypt.test.ts
  ```

  Expected: green.

- [ ] **Step 5: Commit.**
  ```bash
  git add packages/crypto apps/desktop/src/main/crypto
  git commit -m "refactor(crypto): move signatures behind SodiumProvider"
  ```

---

## Task 7: Move keys (SecretStore inversion)

**Files:**

- Create: `packages/crypto/src/keys.ts`, `packages/crypto/src/keys.test.ts` (moved + inverted)
- Modify (→ shim): `apps/desktop/src/main/crypto/keys.ts`
- Delete: `apps/desktop/src/main/crypto/keys.test.ts`

**Interfaces:**

- Consumes: `getSodium()`; `getSecretStore()`; `encodeCbor`; `lockKeyMaterial`/`unlockKeyMaterial`; `generateFileKey`; contracts `ARGON2_PARAMS`, `KEY_DERIVATION_CONTEXTS`, `KEYCHAIN_ENTRIES`, `LINKING_HKDF_CONTEXTS`, `X25519_PARAMS`, types `DeviceSigningKeyPair`/`EphemeralKeyPair`/`MasterKeyMaterial`; `CBOR_FIELD_ORDER`.
- Produces: `deriveKey(masterKey, context, length): Promise<Uint8Array>`; `deriveMasterKey(seed, salt): Promise<MasterKeyMaterial>`; `generateDeviceSigningKeyPair(): Promise<DeviceSigningKeyPair>`; `getDevicePublicKey(secretKey): Uint8Array`; `getOrCreateSigningKeyPair(): Promise<DeviceSigningKeyPair>` [SecretStore]; `generateKeyVerifier(masterKey): Promise<string>`; `generateSalt(): Uint8Array`; `getOrDeriveVaultKey(): Promise<Uint8Array>` [SecretStore]; `generateX25519KeyPair()`; `computeSharedSecret()`; `deriveLinkingKeys()`; `computeVerificationCode()`; `computeLinkingProof()`; `computeKeyConfirm()`; `computeProviderAuthConfirm()`; `computeVaultTransferConfirm()`; re-export `generateFileKey`.

Steps:

- [ ] **Step 1: Move the test and invert its keychain mock to the SecretStore seam.** Move the file, then replace its keytar mock with a `SecretStore` fake driven directly in `Uint8Array` (no base64 round-trip):

  ```bash
  git mv apps/desktop/src/main/crypto/keys.test.ts packages/crypto/src/keys.test.ts
  ```

  In `packages/crypto/src/keys.test.ts`, delete the `import keytar from 'keytar'` line and the `vi.mock('keytar', ...)` block, and replace the top-of-file wiring with a controllable `SecretStore`:

  ```ts
  import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
  import sodium from 'libsodium-wrappers-sumo'

  import {
    ARGON2_PARAMS,
    KEYCHAIN_ENTRIES,
    KEY_DERIVATION_CONTEXTS,
    LINKING_HKDF_CONTEXTS,
    X25519_PARAMS
  } from '@memry/contracts/crypto'

  import { setSecretStore } from './secret-store'
  import { setSodium } from './sodium-provider'

  const retrieveKey = vi.fn<(entry: unknown) => Promise<Uint8Array | null>>(async () => null)
  const storeKey = vi.fn<(entry: unknown, key: Uint8Array) => Promise<void>>(async () => {})
  const deleteKey = vi.fn<(entry: unknown) => Promise<void>>(async () => {})

  import {
    computeKeyConfirm,
    computeLinkingProof,
    computeSharedSecret,
    computeVerificationCode,
    deriveKey,
    deriveLinkingKeys,
    deriveMasterKey,
    generateDeviceSigningKeyPair,
    generateKeyVerifier,
    generateSalt,
    generateX25519KeyPair,
    getDevicePublicKey,
    getOrCreateSigningKeyPair,
    getOrDeriveVaultKey
  } from './keys'

  beforeAll(async () => {
    await sodium.ready
    setSodium(sodium)
  })

  beforeEach(() => {
    retrieveKey.mockReset().mockResolvedValue(null)
    storeKey.mockReset()
    deleteKey.mockReset()
    setSecretStore({ storeKey, retrieveKey, deleteKey })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })
  ```

  Then in the keychain-driving test bodies, replace `vi.mocked(keytar.getPassword).mockResolvedValueOnce(sodium.to_base64(bytes, ORIGINAL))` with `retrieveKey.mockResolvedValueOnce(bytes)` (raw `Uint8Array`), and `vi.mocked(keytar.getPassword).mockResolvedValueOnce(null)` with `retrieveKey.mockResolvedValueOnce(null)`. For `getOrDeriveVaultKey`'s per-entry branch, replace the `keytar.getPassword` implementation with:

  ```ts
  retrieveKey.mockImplementation(async (entry) =>
    entry === KEYCHAIN_ENTRIES.MASTER_KEY ? FIXED_MASTER_KEY : null
  )
  ```

  (`getOrCreateSigningKeyPair` / `getOrDeriveVaultKey` call `getSecretStore().retrieveKey(KEYCHAIN_ENTRIES.X)` with the exact entry object, so identity `entry === KEYCHAIN_ENTRIES.MASTER_KEY` holds.) All non-keychain tests (`deriveMasterKey` golden snapshot, `deriveKey`, `generateSalt`, X25519, linking) move verbatim.

- [ ] **Step 2: Run it, expect FAIL.**

  ```bash
  pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared packages/crypto/src/keys.test.ts
  ```

  Expected: FAIL — `Cannot find module './keys'`.

- [ ] **Step 3: Move the source (sodium + keychain inversion), add the shim.** Create `packages/crypto/src/keys.ts` — identical to the desktop original except `import sodium ...` becomes `getSodium()` inside each function, `import { retrieveKey } from './keychain'` becomes `getSecretStore()`, and the `KDF_CONTEXT_MAP` (the byte-compat core) is copied verbatim:

  ```ts
  import {
    ARGON2_PARAMS,
    KEY_DERIVATION_CONTEXTS,
    KEYCHAIN_ENTRIES,
    LINKING_HKDF_CONTEXTS,
    X25519_PARAMS,
    type DeviceSigningKeyPair,
    type EphemeralKeyPair,
    type MasterKeyMaterial
  } from '@memry/contracts/crypto'
  import { CBOR_FIELD_ORDER } from '@memry/contracts/cbor-ordering'

  import { encodeCbor } from './cbor'
  import { lockKeyMaterial, unlockKeyMaterial } from './memory-lock'
  import { getSecretStore } from './secret-store'
  import { getSodium } from './sodium-provider'

  const KDF_CONTEXT_MAP: Record<string, { ctx: string; id: number }> = {
    'memry-vault-key-v1': { ctx: 'memryvlt', id: 1 },
    'memry-signing-key-v1': { ctx: 'memrysgn', id: 2 },
    'memry-verify-key-v1': { ctx: 'memryvrf', id: 3 },
    'memry-key-verifier-v1': { ctx: 'memrykve', id: 4 },
    [LINKING_HKDF_CONTEXTS.ENCRYPTION]: { ctx: 'memrylnk', id: 5 },
    [LINKING_HKDF_CONTEXTS.MAC]: { ctx: 'memrymac', id: 6 },
    [LINKING_HKDF_CONTEXTS.SAS]: { ctx: 'memrysas', id: 7 }
  }

  export const deriveKey = async (
    masterKey: Uint8Array,
    context: string,
    length: number
  ): Promise<Uint8Array> => {
    const sodium = getSodium()
    await sodium.ready

    const mapping = KDF_CONTEXT_MAP[context]
    if (!mapping) {
      throw new Error(`Unknown key derivation context: ${context}`)
    }
    return sodium.crypto_kdf_derive_from_key(length, mapping.id, mapping.ctx, masterKey)
  }

  export const deriveMasterKey = async (
    seed: Uint8Array,
    salt: Uint8Array
  ): Promise<MasterKeyMaterial> => {
    const sodium = getSodium()
    await sodium.ready

    const masterKey = sodium.crypto_pwhash(
      32,
      seed,
      salt,
      ARGON2_PARAMS.OPS_LIMIT,
      ARGON2_PARAMS.MEMORY_LIMIT,
      sodium.crypto_pwhash_ALG_ARGON2ID13
    )

    lockKeyMaterial(masterKey)

    try {
      const keyVerifier = await generateKeyVerifier(masterKey)
      return {
        masterKey,
        kdfSalt: sodium.to_base64(salt, sodium.base64_variants.ORIGINAL),
        keyVerifier
      }
    } catch (error) {
      unlockKeyMaterial(masterKey)
      sodium.memzero(masterKey)
      throw error
    }
  }

  export { generateFileKey } from './primitives'

  export const generateDeviceSigningKeyPair = async (): Promise<DeviceSigningKeyPair> => {
    const sodium = getSodium()
    await sodium.ready

    const keyPair = sodium.crypto_sign_keypair()
    const deviceId = sodium.to_hex(sodium.crypto_generichash(16, keyPair.publicKey, null))

    const secretKey = new Uint8Array(keyPair.privateKey)
    sodium.memzero(keyPair.privateKey)

    return { deviceId, publicKey: keyPair.publicKey, secretKey }
  }

  export const getDevicePublicKey = (secretKey: Uint8Array): Uint8Array => {
    return getSodium().crypto_sign_ed25519_sk_to_pk(secretKey)
  }

  export const getOrCreateSigningKeyPair = async (): Promise<DeviceSigningKeyPair> => {
    const sodium = getSodium()
    await sodium.ready

    const existing = await getSecretStore().retrieveKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY)
    if (existing) {
      const publicKey = sodium.crypto_sign_ed25519_sk_to_pk(existing)
      const deviceId = sodium.to_hex(sodium.crypto_generichash(16, publicKey, null))
      return { deviceId, publicKey, secretKey: existing }
    }

    return generateDeviceSigningKeyPair()
  }

  export const generateKeyVerifier = async (masterKey: Uint8Array): Promise<string> => {
    const sodium = getSodium()
    const verifierKey = await deriveKey(masterKey, 'memry-key-verifier-v1', 32)
    try {
      return sodium.to_base64(verifierKey, sodium.base64_variants.ORIGINAL)
    } finally {
      sodium.memzero(verifierKey)
    }
  }

  export const generateSalt = (): Uint8Array => {
    return getSodium().randombytes_buf(ARGON2_PARAMS.SALT_LENGTH)
  }

  export const getOrDeriveVaultKey = async (): Promise<Uint8Array> => {
    const sodium = getSodium()
    const masterKey = await getSecretStore().retrieveKey(KEYCHAIN_ENTRIES.MASTER_KEY)
    if (!masterKey) {
      throw new Error('Master key not found in keychain — cannot derive vault key')
    }

    try {
      const vaultKey = await deriveKey(masterKey, KEY_DERIVATION_CONTEXTS.VAULT_KEY, 32)
      lockKeyMaterial(vaultKey)
      return vaultKey
    } finally {
      unlockKeyMaterial(masterKey)
      sodium.memzero(masterKey)
    }
  }

  export const generateX25519KeyPair = async (): Promise<EphemeralKeyPair> => {
    const sodium = getSodium()
    await sodium.ready
    const keyPair = sodium.crypto_box_keypair()
    return { publicKey: keyPair.publicKey, secretKey: keyPair.privateKey }
  }

  export const computeSharedSecret = async (
    myPrivateKey: Uint8Array,
    theirPublicKey: Uint8Array
  ): Promise<Uint8Array> => {
    const sodium = getSodium()
    await sodium.ready

    if (myPrivateKey.length !== X25519_PARAMS.SECRET_KEY_LENGTH) {
      throw new Error(`X25519 private key must be ${X25519_PARAMS.SECRET_KEY_LENGTH} bytes`)
    }
    if (theirPublicKey.length !== X25519_PARAMS.PUBLIC_KEY_LENGTH) {
      throw new Error(`X25519 public key must be ${X25519_PARAMS.PUBLIC_KEY_LENGTH} bytes`)
    }

    return sodium.crypto_scalarmult(myPrivateKey, theirPublicKey)
  }

  export const deriveLinkingKeys = async (
    sharedSecret: Uint8Array
  ): Promise<{ encKey: Uint8Array; macKey: Uint8Array }> => {
    const encKey = await deriveKey(sharedSecret, LINKING_HKDF_CONTEXTS.ENCRYPTION, 32)
    const macKey = await deriveKey(sharedSecret, LINKING_HKDF_CONTEXTS.MAC, 32)
    return { encKey, macKey }
  }

  export const computeVerificationCode = async (sharedSecret: Uint8Array): Promise<string> => {
    const sodium = getSodium()
    await sodium.ready

    const sasKey = await deriveKey(sharedSecret, LINKING_HKDF_CONTEXTS.SAS, 32)
    const hash = sodium.crypto_generichash(4, sasKey, null)
    sodium.memzero(sasKey)

    const uint32 = (hash[0] << 24) | (hash[1] << 16) | (hash[2] << 8) | hash[3]
    const code = (uint32 >>> 0) % 1000000
    return code.toString().padStart(6, '0')
  }

  export const computeLinkingProof = (
    macKey: Uint8Array,
    sessionId: string,
    devicePublicKey: string
  ): Uint8Array => {
    const payload = encodeCbor({ sessionId, devicePublicKey }, CBOR_FIELD_ORDER.LINKING_PROOF)
    return getSodium().crypto_auth(payload, macKey)
  }

  export const computeKeyConfirm = (
    macKey: Uint8Array,
    sessionId: string,
    encryptedMasterKey: string
  ): Uint8Array => {
    const payload = encodeCbor({ sessionId, encryptedMasterKey }, CBOR_FIELD_ORDER.KEY_CONFIRM)
    return getSodium().crypto_auth(payload, macKey)
  }

  export const computeProviderAuthConfirm = (
    macKey: Uint8Array,
    sessionId: string,
    encryptedProviderAuth: string
  ): Uint8Array => {
    const payload = encodeCbor(
      { sessionId, encryptedProviderAuth },
      CBOR_FIELD_ORDER.PROVIDER_AUTH_CONFIRM
    )
    return getSodium().crypto_auth(payload, macKey)
  }

  export const computeVaultTransferConfirm = (
    macKey: Uint8Array,
    sessionId: string,
    encryptedVaultTransfer: string
  ): Uint8Array => {
    const payload = encodeCbor(
      { sessionId, encryptedVaultTransfer },
      CBOR_FIELD_ORDER.VAULT_TRANSFER_CONFIRM
    )
    return getSodium().crypto_auth(payload, macKey)
  }
  ```

  ```bash
  git rm apps/desktop/src/main/crypto/keys.ts
  ```

  Recreate `apps/desktop/src/main/crypto/keys.ts` as a shim (all symbols, so `vi.mock('../crypto/keys')` in `sync/vault-directory.test.ts` and deep imports in `sync/attachments.ts`/`sync/vault-directory.ts` keep working):

  ```ts
  export {
    computeKeyConfirm,
    computeLinkingProof,
    computeProviderAuthConfirm,
    computeVaultTransferConfirm,
    computeSharedSecret,
    computeVerificationCode,
    deriveKey,
    deriveLinkingKeys,
    deriveMasterKey,
    generateDeviceSigningKeyPair,
    generateFileKey,
    generateKeyVerifier,
    generateSalt,
    generateX25519KeyPair,
    getDevicePublicKey,
    getOrCreateSigningKeyPair,
    getOrDeriveVaultKey
  } from '@memry/crypto/keys'
  ```

- [ ] **Step 4: Run tests, expect PASS.**

  ```bash
  pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared packages/crypto/src/keys.test.ts
  ```

  Expected: green, including the `deriveMasterKey` inline-snapshot `05e691d50fc4043e5b38f12fbe2f4bbba7a1669a1421795b0d5f445e86e617a3` (the Argon2id p=1 byte-compat lock — MUST NOT change). Consumer check:

  ```bash
  pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project main src/main/sync/vault-directory.test.ts
  ```

  Expected: green.

- [ ] **Step 5: Commit.**
  ```bash
  git add packages/crypto apps/desktop/src/main/crypto
  git commit -m "refactor(crypto): move keys behind SodiumProvider and SecretStore seams"
  ```

---

## Task 8: Move recovery

**Files:**

- Create: `packages/crypto/src/recovery.ts`, `packages/crypto/src/recovery.test.ts` (moved)
- Modify (→ shim): `apps/desktop/src/main/crypto/recovery.ts`
- Delete: `apps/desktop/src/main/crypto/recovery.test.ts`

**Interfaces:**

- Consumes: `getSodium()`; `deriveMasterKey` (Task 7); `bip39`; `RecoveryPhraseResult` from `@memry/contracts/crypto`.
- Produces: `generateRecoveryPhrase(): Promise<RecoveryPhraseResult>`; `validateRecoveryPhrase(phrase): boolean`; `phraseToSeed(phrase): Promise<Uint8Array>`; `recoverMasterKeyFromPhrase(phrase, kdfSalt): Promise<RecoveredKeyMaterial>`; `validateKeyVerifier(derived, server): boolean`; `interface RecoveredKeyMaterial { masterKey: Uint8Array; keyVerifier: string; kdfSalt: string }`.

Steps:

- [ ] **Step 1: Move the test.**

  ```bash
  git mv apps/desktop/src/main/crypto/recovery.test.ts packages/crypto/src/recovery.test.ts
  ```

- [ ] **Step 2: Run it, expect FAIL.**

  ```bash
  pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared packages/crypto/src/recovery.test.ts
  ```

  Expected: FAIL — `Cannot find module './recovery'`.

- [ ] **Step 3: Move the source, add the shim.** Create `packages/crypto/src/recovery.ts` (only sodium source changes):

  ```ts
  import * as bip39 from 'bip39'

  import type { RecoveryPhraseResult } from '@memry/contracts/crypto'

  import { deriveMasterKey } from './keys'
  import { getSodium } from './sodium-provider'

  export const generateRecoveryPhrase = async (): Promise<RecoveryPhraseResult> => {
    const phrase = bip39.generateMnemonic(256)
    const seedBuffer = await bip39.mnemonicToSeed(phrase)
    const seed = new Uint8Array(seedBuffer.buffer, seedBuffer.byteOffset, seedBuffer.byteLength)
    return { phrase, seed }
  }

  export const validateRecoveryPhrase = (phrase: string): boolean => {
    return bip39.validateMnemonic(phrase)
  }

  export const phraseToSeed = async (phrase: string): Promise<Uint8Array> => {
    const seedBuffer = await bip39.mnemonicToSeed(phrase)
    return new Uint8Array(seedBuffer.buffer, seedBuffer.byteOffset, seedBuffer.byteLength)
  }

  export interface RecoveredKeyMaterial {
    masterKey: Uint8Array
    keyVerifier: string
    kdfSalt: string
  }

  export const recoverMasterKeyFromPhrase = async (
    phrase: string,
    kdfSalt: string
  ): Promise<RecoveredKeyMaterial> => {
    const sodium = getSodium()
    const seed = await phraseToSeed(phrase)
    const saltBytes = sodium.from_base64(kdfSalt, sodium.base64_variants.ORIGINAL)

    try {
      return await deriveMasterKey(seed, saltBytes)
    } finally {
      sodium.memzero(seed)
      sodium.memzero(saltBytes)
    }
  }

  export const validateKeyVerifier = (derivedVerifier: string, serverVerifier: string): boolean => {
    const sodium = getSodium()
    const derivedBytes = new TextEncoder().encode(derivedVerifier)
    const serverBytes = new TextEncoder().encode(serverVerifier)
    if (derivedBytes.length !== serverBytes.length) {
      return false
    }
    return sodium.memcmp(derivedBytes, serverBytes)
  }
  ```

  ```bash
  git rm apps/desktop/src/main/crypto/recovery.ts
  ```

  Recreate `apps/desktop/src/main/crypto/recovery.ts`:

  ```ts
  export {
    generateRecoveryPhrase,
    phraseToSeed,
    recoverMasterKeyFromPhrase,
    validateKeyVerifier,
    validateRecoveryPhrase
  } from '@memry/crypto/recovery'
  export type { RecoveredKeyMaterial } from '@memry/crypto/recovery'
  ```

- [ ] **Step 4: Run tests, expect PASS.**

  ```bash
  pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared packages/crypto/src/recovery.test.ts
  ```

  Expected: green.

- [ ] **Step 5: Commit.**
  ```bash
  git add packages/crypto apps/desktop/src/main/crypto
  git commit -m "refactor(crypto): move recovery behind SodiumProvider"
  ```

---

## Task 9: Move vault-key-state (db generalization + SecretStore inversion)

**Files:**

- Create: `packages/crypto/src/vault-key-state.ts`, `packages/crypto/src/vault-key-state.test.ts` (moved + inverted)
- Modify (→ shim): `apps/desktop/src/main/crypto/vault-key-state.ts`
- Delete: `apps/desktop/src/main/crypto/vault-key-state.test.ts`

**Interfaces:**

- Consumes: `getSodium()`; `getSecretStore()`; `deriveKey`; `lockKeyMaterial`; `secureCleanup`; `@memry/db-schema/data-schema`; `drizzle-orm`; `KEYCHAIN_ENTRIES`, `KEY_DERIVATION_CONTEXTS`.
- Produces: `const VAULT_KEY_VERIFIER_SETTING = 'vault.crypto.verifier.v1'`; `computeVaultKeyVerifier(vaultKey, vaultId): string`; `storeVaultKeyVerifier(db, vaultId, vaultKey): void`; `bindLocalVaultToMasterKey(db, vaultId, masterKey): Promise<void>`; `getOrInitializeLocalVaultKey(db, vaultId): Promise<Uint8Array>`. The `db` param type is `DataDbLike = BaseSQLiteDatabase<'sync' | 'async', unknown, typeof import('@memry/db-schema/data-schema')>` (generalized off desktop's `BetterSQLite3Database` so op-sqlite works later).

Steps:

- [ ] **Step 1: Move the test and invert its keychain mock.** Move the file (it keeps `better-sqlite3` + `@memry/db-schema` — the package has both as deps); replace the keytar mock with a `SecretStore` fake:

  ```bash
  git mv apps/desktop/src/main/crypto/vault-key-state.test.ts packages/crypto/src/vault-key-state.test.ts
  ```

  In `packages/crypto/src/vault-key-state.test.ts`, remove `import keytar from 'keytar'` and the `vi.mock('keytar', ...)` block; add the seam wiring:

  ```ts
  import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
  import Database from 'better-sqlite3'
  import { eq } from 'drizzle-orm'
  import { drizzle } from 'drizzle-orm/better-sqlite3'
  import sodium from 'libsodium-wrappers-sumo'

  import * as schema from '@memry/db-schema/data-schema'
  import { KEYCHAIN_ENTRIES, KEY_DERIVATION_CONTEXTS } from '@memry/contracts/crypto'

  import { deriveKey } from './keys'
  import { setSecretStore } from './secret-store'
  import { setSodium } from './sodium-provider'
  import {
    VAULT_KEY_VERIFIER_SETTING,
    bindLocalVaultToMasterKey,
    computeVaultKeyVerifier,
    getOrInitializeLocalVaultKey
  } from './vault-key-state'

  const secretStore = new Map<unknown, Uint8Array>()
  const retrieveKey = vi.fn(async (entry: unknown) => secretStore.get(entry) ?? null)
  const storeKey = vi.fn(async (entry: unknown, key: Uint8Array) => {
    secretStore.set(entry, key)
  })
  const deleteKey = vi.fn(async (entry: unknown) => {
    secretStore.delete(entry)
  })

  beforeAll(async () => {
    await sodium.ready
    setSodium(sodium)
  })

  beforeEach(() => {
    secretStore.clear()
    retrieveKey.mockClear()
    storeKey.mockClear()
    deleteKey.mockClear()
    setSecretStore({ storeKey, retrieveKey, deleteKey })
  })
  ```

  Rewrite the keychain assertions: `vi.mocked(keytar.getPassword).mockResolvedValue(null)` → the empty `secretStore` (already null by default); `expect(keytar.setPassword).toHaveBeenCalledWith(service, account, base64)` → `expect(storeKey).toHaveBeenCalledWith(KEYCHAIN_ENTRIES.MASTER_KEY, expect.any(Uint8Array))`; `expect(keytar.setPassword).not.toHaveBeenCalled()` → `expect(storeKey).not.toHaveBeenCalled()`; the per-account `mockImplementation` branch → seed `secretStore.set(KEYCHAIN_ENTRIES.MASTER_KEY, <32-byte key>)` before the call. The `freshDb()` helper (raw `CREATE TABLE` DDL) and all DB-level assertions move verbatim.

- [ ] **Step 2: Run it, expect FAIL.**

  ```bash
  pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared packages/crypto/src/vault-key-state.test.ts
  ```

  Expected: FAIL — `Cannot find module './vault-key-state'`.

- [ ] **Step 3: Move the source (db generalize + SecretStore), add the shim.** Create `packages/crypto/src/vault-key-state.ts`. Change vs. desktop original: drop `import sodium ...` (use `getSodium()`), drop `import type { DataDb } from '../database/types'` (use the generalized `DataDbLike`), swap `import { retrieveKey, storeKey } from './keychain'` for `getSecretStore()`. Everything else — the settings key, verifier context string, agent-data reset, and control flow — is byte-identical:

  ```ts
  import { and, eq, isNull } from 'drizzle-orm'
  import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'

  import * as schema from '@memry/db-schema/data-schema'
  import { KEYCHAIN_ENTRIES, KEY_DERIVATION_CONTEXTS } from '@memry/contracts/crypto'

  import { deriveKey } from './keys'
  import { lockKeyMaterial } from './memory-lock'
  import { secureCleanup } from './primitives'
  import { getSecretStore } from './secret-store'
  import { getSodium } from './sodium-provider'

  // Generalized off desktop's BetterSQLite3Database DataDb so op-sqlite (mobile)
  // satisfies the same contract. Desktop's DataDb stays assignable to this.
  type DataDbLike = BaseSQLiteDatabase<'sync' | 'async', unknown, typeof schema>

  export const VAULT_KEY_VERIFIER_SETTING = 'vault.crypto.verifier.v1'

  const VERIFIER_CONTEXT = 'memry/vault-key-verifier/v1'

  export function computeVaultKeyVerifier(vaultKey: Uint8Array, vaultId: string): string {
    const sodium = getSodium()
    const input = new TextEncoder().encode(`${VERIFIER_CONTEXT}/${vaultId}`)
    const verifier = sodium.crypto_generichash(32, input, vaultKey)
    try {
      return sodium.to_base64(verifier, sodium.base64_variants.ORIGINAL)
    } finally {
      sodium.memzero(verifier)
    }
  }

  export function storeVaultKeyVerifier(
    db: DataDbLike,
    vaultId: string,
    vaultKey: Uint8Array
  ): void {
    setVaultKeyVerifier(db, computeVaultKeyVerifier(vaultKey, vaultId))
  }

  export async function bindLocalVaultToMasterKey(
    db: DataDbLike,
    vaultId: string,
    masterKey: Uint8Array
  ): Promise<void> {
    const sodium = getSodium()
    await sodium.ready

    const vaultKey = await deriveKey(masterKey, KEY_DERIVATION_CONTEXTS.VAULT_KEY, 32)
    lockKeyMaterial(vaultKey)
    try {
      const current = getVaultKeyVerifier(db)
      const next = computeVaultKeyVerifier(vaultKey, vaultId)
      if (current === next) return

      resetLegacyUnboundAgentData(db, vaultId)
      setVaultKeyVerifier(db, next)
    } finally {
      secureCleanup(vaultKey)
    }
  }

  export async function getOrInitializeLocalVaultKey(
    db: DataDbLike,
    vaultId: string
  ): Promise<Uint8Array> {
    const sodium = getSodium()
    await sodium.ready
    const store = getSecretStore()

    const expectedVerifier = getVaultKeyVerifier(db)
    let masterKey = await store.retrieveKey(KEYCHAIN_ENTRIES.MASTER_KEY)
    if (!masterKey) {
      if (await hasSyncCredentials()) {
        throw new Error(
          'Master key not found in keychain — cannot create a local vault key while sync credentials exist'
        )
      }
      if (expectedVerifier) {
        throw new Error('Vault key verifier exists but master key is missing')
      }
      resetLegacyUnboundAgentData(db, vaultId)

      masterKey = sodium.randombytes_buf(32)
      lockKeyMaterial(masterKey)
      try {
        await store.storeKey(KEYCHAIN_ENTRIES.MASTER_KEY, masterKey)
      } catch (error) {
        secureCleanup(masterKey)
        throw error
      }
    }

    try {
      const vaultKey = await deriveKey(masterKey, KEY_DERIVATION_CONTEXTS.VAULT_KEY, 32)
      lockKeyMaterial(vaultKey)
      let keepVaultKey = false
      try {
        bindOrVerifyVaultKey(db, vaultId, vaultKey, expectedVerifier)
        keepVaultKey = true
        return vaultKey
      } finally {
        if (!keepVaultKey) secureCleanup(vaultKey)
      }
    } finally {
      secureCleanup(masterKey)
    }
  }

  function bindOrVerifyVaultKey(
    db: DataDbLike,
    vaultId: string,
    vaultKey: Uint8Array,
    expected: string | null
  ): void {
    const actual = computeVaultKeyVerifier(vaultKey, vaultId)

    if (!expected) {
      resetLegacyUnboundAgentData(db, vaultId)
      setVaultKeyVerifier(db, actual)
      return
    }

    if (expected !== actual) {
      throw new Error('Current master key does not match this vault')
    }
  }

  function resetLegacyUnboundAgentData(db: DataDbLike, vaultId: string): void {
    if (!hasEncryptedAgentData(db, vaultId)) return

    db.delete(schema.agentMessages).run()
    db.delete(schema.agentConversations).where(eq(schema.agentConversations.vaultId, vaultId)).run()
  }

  function getVaultKeyVerifier(db: DataDbLike): string | null {
    const row = db
      .select({ value: schema.settings.value })
      .from(schema.settings)
      .where(eq(schema.settings.key, VAULT_KEY_VERIFIER_SETTING))
      .get()
    return row?.value ?? null
  }

  function setVaultKeyVerifier(db: DataDbLike, value: string): void {
    db.insert(schema.settings)
      .values({ key: VAULT_KEY_VERIFIER_SETTING, value })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
      .run()
  }

  function hasEncryptedAgentData(db: DataDbLike, vaultId: string): boolean {
    const conversation = db
      .select({ id: schema.agentConversations.id })
      .from(schema.agentConversations)
      .where(
        and(
          eq(schema.agentConversations.vaultId, vaultId),
          isNull(schema.agentConversations.deletedAt)
        )
      )
      .limit(1)
      .get()
    if (conversation) return true

    const message = db
      .select({ id: schema.agentMessages.id })
      .from(schema.agentMessages)
      .where(isNull(schema.agentMessages.deletedAt))
      .limit(1)
      .get()
    return Boolean(message)
  }

  async function hasSyncCredentials(): Promise<boolean> {
    const sodium = getSodium()
    const store = getSecretStore()
    const refreshToken = await store.retrieveKey(KEYCHAIN_ENTRIES.REFRESH_TOKEN)
    const signingKey = await store.retrieveKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY)

    try {
      return refreshToken !== null || signingKey !== null
    } finally {
      if (refreshToken) sodium.memzero(refreshToken)
      if (signingKey) sodium.memzero(signingKey)
    }
  }
  ```

  ```bash
  git rm apps/desktop/src/main/crypto/vault-key-state.ts
  ```

  Recreate `apps/desktop/src/main/crypto/vault-key-state.ts` as a shim (preserves `sync/vault-adoption.ts`, `test-hooks.ts` deep imports + `vi.mock('./crypto/vault-key-state')` in `test-hooks.test.ts`):

  ```ts
  export {
    VAULT_KEY_VERIFIER_SETTING,
    bindLocalVaultToMasterKey,
    computeVaultKeyVerifier,
    getOrInitializeLocalVaultKey,
    storeVaultKeyVerifier
  } from '@memry/crypto/vault-key-state'
  ```

- [ ] **Step 4: Run tests, expect PASS.** Package test first:

  ```bash
  pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared packages/crypto/src/vault-key-state.test.ts
  ```

  Expected: green. Then confirm desktop's `DataDb` is still assignable to `DataDbLike` at the shim boundary and consumers pass:

  ```bash
  pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project main src/main/test-hooks.test.ts
  pnpm --filter @memry/desktop typecheck:node
  ```

  Expected: green; typecheck exit 0 (if `DataDb` is NOT assignable, fall back to leaving `vault-key-state.test.ts` in desktop per the risks note — but keep the source in the package).

- [ ] **Step 5: Commit.**
  ```bash
  git add packages/crypto apps/desktop/src/main/crypto
  git commit -m "refactor(crypto): move vault-key-state, generalize db type and invert SecretStore"
  ```

---

## Task 10: Complete the package barrel and move the cross-module + golden suites

**Files:**

- Modify: `packages/crypto/src/index.ts` (full barrel: `constantTimeEqual` + `initCrypto` + re-exports)
- Create: `packages/crypto/src/__fixtures__/{argon2id-rfc9106,ed25519-rfc8032,xchacha20-rfc8439,encryption-extras,load-vectors}.ts` (moved)
- Create: `packages/crypto/src/__fixtures__/load-vectors.test.ts`, `packages/crypto/src/foundation.test.ts`, `packages/crypto/src/crypto.test.ts` (moved)
- Delete: `apps/desktop/src/main/crypto/__fixtures__/*`, `apps/desktop/src/main/crypto/{foundation,crypto}.test.ts`

**Interfaces:**

- Consumes: every module produced in Tasks 3–9; `getSodium()`.
- Produces: `constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean`; `initCrypto(): Promise<void>`; the full re-export surface listed in `index.test.ts` (Task 11).

Steps:

- [ ] **Step 1: Move the fixtures and suites.** Move the fixture dir and the two broad suites:

  ```bash
  git mv apps/desktop/src/main/crypto/__fixtures__ packages/crypto/src/__fixtures__
  git mv apps/desktop/src/main/crypto/foundation.test.ts packages/crypto/src/foundation.test.ts
  git mv apps/desktop/src/main/crypto/crypto.test.ts packages/crypto/src/crypto.test.ts
  ```

  `foundation.test.ts` uses real libsodium + `vi.mock('keytar')`. Delete its `import keytar` line and `vi.mock('keytar', ...)` block (the package has no keytar); the real SodiumProvider is wired by `tests/setup.ts`, and it imports symbols from `./index` / the module files verbatim otherwise.
  `crypto.test.ts` mocks libsodium and bip39. Replace `vi.mock('libsodium-wrappers-sumo', () => ({ default: mockSodium }))` and the `vi.mock('keytar', ...)` block with seam injection: keep the `vi.hoisted(() => ...)` `mockSodium`/`mockBip39` factory, keep `vi.mock('bip39', ...)`, and add after the imports:

  ```ts
  import { setSecretStore } from './secret-store'
  import { setSodium } from './sodium-provider'

  beforeEach(() => {
    setSodium(mockSodium as never)
    setSecretStore({
      storeKey: async () => {},
      retrieveKey: async () => null,
      deleteKey: async () => {}
    })
  })
  ```

  (The `beforeEach` override wins over `tests/setup.ts`'s real-sodium `beforeAll`, so the call-param assertions on `mockSodium` hold.)

- [ ] **Step 2: Run it, expect FAIL.**

  ```bash
  pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared packages/crypto/src/crypto.test.ts packages/crypto/src/foundation.test.ts packages/crypto/src/__fixtures__/load-vectors.test.ts
  ```

  Expected: FAIL — `./index` does not yet export `constantTimeEqual`/`initCrypto`/the module symbols.

- [ ] **Step 3: Complete the barrel.** Replace `packages/crypto/src/index.ts` with the full barrel (owns `constantTimeEqual` + `initCrypto`, re-exports every module symbol + seams; does NOT export keychain):

  ```ts
  import { getSodium } from './sodium-provider'

  export {
    computeKeyConfirm,
    computeLinkingProof,
    computeProviderAuthConfirm,
    computeVaultTransferConfirm,
    computeSharedSecret,
    computeVerificationCode,
    deriveKey,
    deriveLinkingKeys,
    deriveMasterKey,
    generateDeviceSigningKeyPair,
    generateFileKey,
    generateKeyVerifier,
    generateSalt,
    generateX25519KeyPair,
    getDevicePublicKey,
    getOrCreateSigningKeyPair,
    getOrDeriveVaultKey
  } from './keys'

  export {
    generateRecoveryPhrase,
    phraseToSeed,
    recoverMasterKeyFromPhrase,
    validateKeyVerifier,
    validateRecoveryPhrase
  } from './recovery'
  export type { RecoveredKeyMaterial } from './recovery'

  export {
    decrypt,
    decryptMasterKeyFromLinking,
    encrypt,
    encryptMasterKeyForLinking,
    generateNonce,
    unwrapFileKey,
    wrapFileKey
  } from './encryption'

  export { signPayload, verifySignature } from './signatures'

  export { encodeCbor } from './cbor'
  export { CBOR_FIELD_ORDER } from '@memry/contracts/cbor-ordering'

  export {
    bindLocalVaultToMasterKey,
    computeVaultKeyVerifier,
    getOrInitializeLocalVaultKey,
    storeVaultKeyVerifier,
    VAULT_KEY_VERIFIER_SETTING
  } from './vault-key-state'

  export { secureCleanup } from './primitives'
  export { lockKeyMaterial, unlockKeyMaterial } from './memory-lock'

  export { getSodium, setSodium } from './sodium-provider'
  export type { SodiumProvider } from './sodium-provider'
  export { getSecretStore, setSecretStore } from './secret-store'
  export type { SecretStore } from './secret-store'
  export { getCryptoLogger, setCryptoLogger } from './logger'
  export type { CryptoLogger } from './logger'
  export { CryptoError } from './crypto-errors'
  export type { CryptoErrorCode } from './crypto-errors'

  /**
   * Constant-time comparison via libsodium memcmp.
   * Callers MUST ensure a.length === b.length for timing-safety; the early-return
   * on mismatched lengths leaks only the fact that lengths differ, which is
   * acceptable for fixed-size keys/MACs.
   */
  export const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
    if (a.length !== b.length) {
      return false
    }
    return getSodium().memcmp(a, b)
  }

  export const initCrypto = async (): Promise<void> => {
    await getSodium().ready
  }
  ```

- [ ] **Step 4: Run tests, expect PASS.** Run the whole moved crypto suite as the extraction gate:

  ```bash
  pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project shared packages/crypto
  ```

  Expected: every moved suite green — `crypto.test.ts`, `foundation.test.ts` (RFC golden vectors: Argon2id / Ed25519 / XChaCha20 — the byte-compat gate), `load-vectors.test.ts`, and all per-module tests. Then:

  ```bash
  pnpm --filter @memry/crypto typecheck
  ```

  Expected: exit 0.

- [ ] **Step 5: Commit.**
  ```bash
  git add packages/crypto apps/desktop/src/main/crypto
  git commit -m "feat(crypto): complete @memry/crypto barrel and move golden + cross-module suites"
  ```

---

## Task 11: Convert the desktop compat barrel and repurpose the regression gate

**Files:**

- Modify: `apps/desktop/src/main/crypto/index.ts` (re-export from `@memry/crypto`, keep keychain + seam wiring)
- Modify: `apps/desktop/src/main/crypto/index.test.ts` (regression gate: barrel completeness + seam wiring)

**Interfaces:**

- Consumes: the full `@memry/crypto` barrel; local `keychain.ts` (`storeKey`/`retrieveKey`/`deleteKey`).
- Produces: unchanged desktop `../crypto` surface (all 40+ named exports + `keychain` + `constantTimeEqual` + `initCrypto` + `CBOR_FIELD_ORDER`).

Steps:

- [ ] **Step 1: Update the regression test to assert seam wiring + package-backed barrel.** In `apps/desktop/src/main/crypto/index.test.ts`, keep the existing `expectedFunctions` completeness table and add two assertions that the desktop barrel wired the host seams at import (proving `index.ts` is not just re-exporting but also injecting the platform impls):

  ```ts
  import { getSecretStore, getSodium } from '@memry/crypto'

  describe('crypto/index desktop seam wiring', () => {
    it('wires a SodiumProvider whose base64 uses the ORIGINAL variant', () => {
      // #given the desktop barrel imported (module side-effect runs setSodium)
      // #then getSodium is populated and exposes the ORIGINAL base64 variant
      expect(() => getSodium()).not.toThrow()
      expect(getSodium().base64_variants.ORIGINAL).toBeDefined()
    })

    it('wires a SecretStore backed by the desktop keychain', () => {
      // #given the desktop barrel imported (module side-effect runs setSecretStore)
      // #then getSecretStore is populated with the three keychain methods
      const store = getSecretStore()
      expect(typeof store.storeKey).toBe('function')
      expect(typeof store.retrieveKey).toBe('function')
      expect(typeof store.deleteKey).toBe('function')
    })
  })
  ```

  (The existing `expectedFunctions` list already covers every moved symbol + `deleteKey`/`retrieveKey`/`storeKey` + `constantTimeEqual`/`initCrypto` + `CBOR_FIELD_ORDER`, so a missed re-export fails loudly here.)

- [ ] **Step 2: Run it, expect FAIL.** The current `index.ts` (from Task 4) still declares its OWN `constantTimeEqual`/`initCrypto` and re-exports from local `./keys` etc. — it imports `getSecretStore`/`getSodium` are not yet re-exported through this barrel path used by the test:

  ```bash
  pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project main src/main/crypto/index.test.ts
  ```

  Expected: FAIL on the new seam-wiring assertions (barrel not yet package-backed) — or a duplicate-export TS error once you start editing. This is the red gate.

- [ ] **Step 3: Rewrite `apps/desktop/src/main/crypto/index.ts` as the package-backed compat barrel.**

  ```ts
  import sodium from 'libsodium-wrappers-sumo'

  import { setCryptoLogger, setSecretStore, setSodium } from '@memry/crypto'

  import { createLogger } from '../lib/logger'
  import { deleteKey, retrieveKey, storeKey } from './keychain'

  // Wire the desktop platform seams at module load, before any synchronous crypto
  // call (encrypt/decrypt/signPayload/generateNonce/constantTimeEqual) can run.
  setSodium(sodium)
  setSecretStore({ storeKey, retrieveKey, deleteKey })
  setCryptoLogger(createLogger('CryptoMemLock'))

  export {
    computeKeyConfirm,
    computeLinkingProof,
    computeProviderAuthConfirm,
    computeVaultTransferConfirm,
    computeSharedSecret,
    computeVerificationCode,
    deriveKey,
    deriveLinkingKeys,
    deriveMasterKey,
    generateDeviceSigningKeyPair,
    generateFileKey,
    generateKeyVerifier,
    generateSalt,
    generateX25519KeyPair,
    getDevicePublicKey,
    getOrCreateSigningKeyPair,
    getOrDeriveVaultKey,
    generateRecoveryPhrase,
    phraseToSeed,
    recoverMasterKeyFromPhrase,
    validateKeyVerifier,
    validateRecoveryPhrase,
    decrypt,
    decryptMasterKeyFromLinking,
    encrypt,
    encryptMasterKeyForLinking,
    generateNonce,
    unwrapFileKey,
    wrapFileKey,
    signPayload,
    verifySignature,
    encodeCbor,
    CBOR_FIELD_ORDER,
    bindLocalVaultToMasterKey,
    computeVaultKeyVerifier,
    getOrInitializeLocalVaultKey,
    storeVaultKeyVerifier,
    VAULT_KEY_VERIFIER_SETTING,
    secureCleanup,
    lockKeyMaterial,
    unlockKeyMaterial,
    constantTimeEqual,
    initCrypto
  } from '@memry/crypto'
  export type { RecoveredKeyMaterial } from '@memry/crypto'

  // keychain stays desktop-local (keytar). Not exported by @memry/crypto.
  export { deleteKey, retrieveKey, storeKey } from './keychain'
  ```

  (Note: `VAULT_KEY_VERIFIER_SETTING` and `CBOR_FIELD_ORDER` are added to the re-export vs. the original barrel — they are consumed via the old barrel path by `sync/*` and tests. Confirm the `expectedFunctions` list in `index.test.ts` still matches; `VAULT_KEY_VERIFIER_SETTING`/`CBOR_FIELD_ORDER` are value/object exports asserted separately, not in the function list.)

- [ ] **Step 4: Run tests, expect PASS.**

  ```bash
  pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project main src/main/crypto/index.test.ts
  ```

  Expected: green — completeness table + both seam-wiring assertions pass. Then the full desktop main + shared suites as the desktop-stays-green gate:

  ```bash
  pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project main --project shared
  ```

  Expected: green.

- [ ] **Step 5: Commit.**
  ```bash
  git add apps/desktop/src/main/crypto/index.ts apps/desktop/src/main/crypto/index.test.ts
  git commit -m "refactor(crypto): make desktop crypto barrel package-backed with seam wiring"
  ```

---

## Task 12: Prune desktop-only deps and run the full extraction gate

**Files:**

- Modify: `apps/desktop/package.json` (drop `bip39`/`cborg` iff unused)

**Interfaces:** none new.

Steps:

- [ ] **Step 1: Prove `bip39`/`cborg` have no remaining desktop consumers.** These moved to `@memry/crypto`; verify nothing else in desktop imports them directly:

  ```bash
  rtk grep -rn "from 'bip39'\|from \"bip39\"\|from 'cborg'\|from \"cborg\"" apps/desktop/src
  ```

  Expected: no matches (the only importers — `recovery.ts`, `cbor.ts` — are now shims to the package). If there ARE matches, leave those deps in place and skip their removal.

- [ ] **Step 2: Run it, expect FAIL (before pruning is irrelevant here — this task's gate is the full suite).** Remove `"bip39"` and `"cborg"` from `apps/desktop/package.json` `dependencies` ONLY if Step 1 was empty. Keep `"libsodium-wrappers-sumo"` (still used by `keychain.ts` base64) and `"keytar"`. Reinstall:

  ```bash
  pnpm install
  ```

- [ ] **Step 3: Minimal implementation.** No code — this task is the consolidated verification gate.

- [ ] **Step 4: Run the full extraction gate, expect PASS.**

  ```bash
  pnpm --filter @memry/crypto typecheck
  pnpm typecheck
  pnpm --filter @memry/desktop test
  pnpm ipc:check
  pnpm lint
  git diff --check
  ```

  Expected: all green. `pnpm --filter @memry/desktop test` runs every project (shared incl. the moved crypto suites, main, preload, renderer) — desktop stays green consuming `@memry/crypto`. If a `better-sqlite3` `ERR_DLOPEN_FAILED` appears, run `pnpm --filter @memry/desktop rebuild:node` first, then re-run.

- [ ] **Step 5: Commit.**
  ```bash
  git add apps/desktop/package.json pnpm-lock.yaml
  git commit -m "chore(crypto): drop desktop-only bip39/cborg deps now owned by @memry/crypto"
  ```

---

## Verification Summary

- **Byte-compat gate (immutable crypto):** `packages/crypto/src/foundation.test.ts` (RFC 9106 / 8032 / 8439 golden vectors) and the `deriveMasterKey` inline-snapshot `05e691d5…617a3` in `keys.test.ts` must stay green with no value change — proof the move altered zero bytes (Argon2id p=1, BLAKE2b 8-char contexts, base64 ORIGINAL, canonical CBOR).
- **Desktop-stays-green gate:** `pnpm --filter @memry/desktop test` (all projects) after each task.
- **Barrel-completeness gate:** `apps/desktop/src/main/crypto/index.test.ts` `expectedFunctions` table + seam-wiring assertions — a missed re-export or unset seam fails loudly.
- **Electron-free package gate:** `@memry/crypto` has no `keytar`, no `electron`, no `electron-log` import (memory-lock now uses the `CryptoLogger` seam) — enforced by `pnpm --filter @memry/crypto typecheck` (electron types absent) and the absence of those deps in `packages/crypto/package.json`.
- **Deep-path + `vi.mock` preservation:** every old `apps/desktop/src/main/crypto/<module>.ts` remains as a re-export shim, so `sync/*` deep imports and `vi.mock('../crypto/{primitives,keys}')` / `vi.mock('./crypto/vault-key-state')` targets keep resolving.
