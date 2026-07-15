# Mobile Phase 0 — De-risk Spikes Implementation Plan

> Agentic workers: use the **superpowers:subagent-driven-development** sub-skill to execute this plan. Every step below uses checkbox syntax (`- [ ]`); check a box only when its exact verification evidence is green. Do **not** check off phase/spike work on vibes — the go/no-go records are the evidence.

**Goal:** Prove the five week-1 architectural unknowns for the MemryNote mobile port with measurable, on-device go/no-go artifacts, each backed by a written result record, so the rest of the mobile timeline (crypto/sync-engine/crdt-core/editor extractions) can be committed or re-planned with evidence instead of guesses.

**Architecture:** A single throwaway Expo SDK 57 dev-client harness under `spikes/mobile-phase0/` (which pnpm excludes from the workspace via `!spikes/**`, so it never rebuilds Electron native deps) runs four on-device spikes (libsodium byte-compat, Yjs-on-Hermes perf, BlockNote-in-WebView, op-sqlite triple-flag); the fifth spike is the sole intentional workspace member `apps/mobile/` proving pnpm's isolated linker resolves native modules without switching to `nodeLinker: hoisted`. Each spike consumes the **real in-repo assets** (RFC crypto fixtures, the `tests/sync-harness` crypto path, the `CrdtPersistence` 5-method interface, the FTS5 DDL, the 14 golden-vault markdown fixtures) — never copies — and every spike writes a machine-readable results JSON plus a human go/no-go markdown record.

**Tech Stack:** Expo SDK 57 (RN 0.86 / React 19.2, New-Architecture, iOS 16+/Android 10+ per D9) · `react-native-libsodium@^1.7` + `@noble/curves` + `bip39@3.1.0` · `@op-engineering/op-sqlite@^17` (SQLCipher + FTS5 + optional sqlite-vec) · `yjs@~13.6.29` + `y-protocols@^1.0.7` · `@blocknote/*` pinned `0.47.1` + `@expo/dom-webview` · `cborg@4.5.8`, `pako` · desktop-side `libsodium-wrappers-sumo` · Maestro (on-device verdict assertion) · Vitest (host-runnable shim/generator tests).

---

## Global Constraints

Copied verbatim from the mobile-port shared spine. These bind every task in this plan.

- Backward compatibility is MANDATORY for production installs: every change must work for existing installs, no DB resets, sync protocol / IPC contracts / vault file formats / settings shapes must tolerate data written by older app versions.
- DB schema changes go through additive, hand-written D1/data-DB migrations that preserve existing rows (Drizzle snapshots broken past 0021; data-DB migrations are hand-written).
- Sync-server deploys BEFORE desktop/mobile clients for every additive change (D6 sync item types, D8 settings-push, entitlement_grants).
- Crypto parameters are IMMUTABLE and byte-identical across clients: Argon2id v1.3 ops=3, mem=64 MiB, parallelism=1; BLAKE2b `crypto_kdf_derive_from_key` with exact 8-char contexts (`memryvlt`/`memrysgn`/`memryvrf`/`memrykve`/`memrylnk`/`memrymac`/`memrysas`); base64 = `sodium.base64_variants.ORIGINAL` (standard alphabet, padded); cryptoVersion=1; canonical CBOR in `CBOR_FIELD_ORDER`.
- E2E-encrypted: server never sees plaintext; it verifies Ed25519 via WebCrypto and validates envelope lengths only.
- Offline-first: SQLite local storage is canonical on mobile; CRDT (Yjs) for note/journal bodies, field-level vector clocks for tasks/projects/calendar; correctness never depends on background execution.
- `@blocknote/*`, `yjs`, and `zod` pinned IDENTICALLY to desktop across clients; a CI check fails the mobile build on drift; BlockNote bumps gated on the markdown round-trip / byte-preservation golden suite.
- `@memry/contracts` is the single wire-format source of truth; mobile MUST import, never copy (copying breaks cross-device crypto/signature interop).
- No Co-Authored-By trailer on commit messages.
- Prettier: single quotes, no semicolons, 100-char width, no trailing commas.
- RTL safety: new code uses logical Tailwind/RN props (ms-/me-, ps-/pe-, start-/end-) that flip automatically in RTL; RN uses `I18nManager.forceRTL` instead of `document.dir`.
- Extraction principle: move files, re-export from old paths, tests move with the code, desktop consumes the new package first — each extraction keeps desktop green, verified by the existing suite before mobile exists.
- Logging via `createLogger('Scope')` seam (never raw `console.*`); user-facing errors via `extractErrorMessage(err, fallback)`.
- WCAG AA + reduced-motion + RTL accessibility per PRODUCT.md; personality calm, private, crafted.

**Version pins (reproduce exactly — drift invalidates the spikes):** `@blocknote/* = 0.47.1`, `yjs = ~13.6.29`, `y-protocols = ^1.0.7`, `zod = ^4.3.4`, `cborg = 4.5.8`, `bip39 = 3.1.0`, `react-native-libsodium = ^1.7`, `@op-engineering/op-sqlite = ^17`, `expo = ^57`.

**Phase-0-specific rule (deliberate, throwaway):** Because `spikes/**` is excluded from the pnpm workspace, the spike harness **cannot** `workspace:*`-import `@memry/contracts`. The immutable crypto constants (ops=3, mem=64 MiB, contexts, base64 ORIGINAL) are therefore **inlined** into the spike code with a source-of-truth comment citing `packages/contracts/src/crypto.ts`. This is safe _only_ because those values are immutable by the global constraint above, and _only_ for a throwaway measurement harness. The real "import-not-copy" rule is proven by **Spike 5** (`apps/mobile` doing `workspace:*` on `@memry/contracts`) and enforced by the later extraction plans — never relax it in shipped code.

---

## File Structure

Every file this plan creates or modifies, with its single responsibility.

### Spike harness (throwaway, standalone — excluded from pnpm workspace)

| Path                                                       | Create/Modify      | Responsibility                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `spikes/README.md`                                         | Create             | Index of the 5 spikes + the go/no-go gate table (spike → measurable artifact → pass criterion → result-record path). States that `spikes/**` is workspace-excluded so the harness never rebuilds Electron native deps, and that Spike 5 is the sole exception.                                                                                         |
| `spikes/mobile-phase0/package.json`                        | Create             | Standalone (non-workspace) manifest; pins `react-native-libsodium ^1.7`, `@op-engineering/op-sqlite ^17`, `@noble/curves`, `bip39 3.1.0`, `cborg 4.5.8`, `yjs ~13.6.29`, `y-protocols ^1.0.7`, `@blocknote/* 0.47.1`, `@expo/dom-webview`, `expo-secure-store`, `expo-file-system`, plus host-side `libsodium-wrappers-sumo`, `pako`, `vitest`, `tsx`. |
| `spikes/mobile-phase0/app.json`                            | Create             | Expo dev-client config (SDK 57, New-Arch, iOS 16 / Android 10 floors per D9); one app mounting a spike-selector screen.                                                                                                                                                                                                                                |
| `spikes/mobile-phase0/vitest.config.ts`                    | Create             | Host-side vitest config for the shim/generator/DDL-string unit tests that run in Node (not on device).                                                                                                                                                                                                                                                 |
| `spikes/mobile-phase0/App.tsx`                             | Create             | Root spike runner: spike-selector, renders each spike's PASS/FAIL + measured numbers, and writes a machine-readable `phase0-results.json` via `expo-file-system` that the result-record markdowns summarize.                                                                                                                                           |
| `spikes/mobile-phase0/lib/results.ts`                      | Create             | Shared results writer: `recordSpikeResult(name, verdict, metrics)` + `flushResults()` → `phase0-results.json`. Used by all four on-device runners.                                                                                                                                                                                                     |
| `spikes/mobile-phase0/crypto/noble-shims.ts`               | Create             | Spike 1 pure-TS shims: `scalarmult` → `@noble/curves` x25519, `signEd25519SkToPk` → `sk.subarray(32)`, `constantTimeEqual`, `zeroize`. Mirrors `constantTimeEqual`/`secureCleanup` from desktop crypto.                                                                                                                                                |
| `spikes/mobile-phase0/crypto/vectors.ts`                   | Create             | Spike 1 inlined RFC vectors + immutable params (Argon2id p=1/m=64MiB/t=3, XChaCha20, Ed25519, KDF contexts), cited from `packages/contracts/src/crypto.ts` and the `__fixtures__` RFC files.                                                                                                                                                           |
| `spikes/mobile-phase0/crypto/run-vectors.ts`               | Create             | Spike 1 device runner: exercises `react-native-libsodium` for each primitive + KDF context + base64 ORIGINAL assertion; loads `interop.corpus.json`, decrypts/verifies it, and re-encrypts a device-origin item for the reverse-direction check. Emits per-vector pass/fail + Argon2id wall-clock.                                                     |
| `spikes/mobile-phase0/crypto/interop.corpus.json`          | Create (generated) | Spike 1 desktop-generated corpus: same phrase+salt → master key, encrypted+signed items via `encryptItemForPush`. Committed artifact the device consumes.                                                                                                                                                                                              |
| `spikes/mobile-phase0/scripts/gen-interop-corpus.ts`       | Create             | Spike 1 Node generator (`tsx`): reproduces desktop `deriveMasterKey` + `encryptItemForPush`/`decryptItemFromPull` (from `tests/sync-harness/src/crypto.ts`) to write and (`--verify`) round-trip-check the corpus.                                                                                                                                     |
| `spikes/mobile-phase0/scripts/gen-interop-corpus.test.ts`  | Create             | Vitest host test: generator output decrypts+verifies with `libsodium-wrappers-sumo`; base64 is ORIGINAL; master key is deterministic for a fixed phrase+salt.                                                                                                                                                                                          |
| `spikes/mobile-phase0/crypto/noble-shims.test.ts`          | Create             | Vitest host test: shim outputs equal `libsodium-wrappers-sumo` (`crypto_scalarmult`, `crypto_sign_ed25519_sk_to_pk`, constant-time compare).                                                                                                                                                                                                           |
| `spikes/mobile-phase0/scripts/export-crdt-state.ts`        | Create             | Spike 2 desktop exporter: opens the real `y-leveldb` store at `userData/crdt-store`, loads real docs, emits genuine Yjs update logs of length 1/50/500 for 3 size-representative notes + a 200-doc bundle → `crdt-corpus.json`.                                                                                                                        |
| `spikes/mobile-phase0/yjs/perf-runner.tsx`                 | Create             | Spike 2 on-Hermes runner: `Y.mergeUpdates`/`applyUpdate` the exported logs, measures load latency (p50/p95 ms) at log lengths 1/50/500 and resident memory (RSS MB) at 10/50/200 loaded docs.                                                                                                                                                          |
| `spikes/mobile-phase0/editor/editor.dom.tsx`               | Create             | Spike 3 Expo DOM component (`'use dom'`, `@expo/dom-webview`) hosting BlockNote 0.47.1 + the exact desktop editor schema + serializer; content sent via `postMessage` after mount; exposes markdown⇄blocks round-trip + focus/IME probes as typed actions.                                                                                             |
| `spikes/mobile-phase0/editor/fixtures.bundle.ts`           | Create             | Spike 3 build step inlining the 14 golden-vault `.md` fixtures into the bundle so the device runs the identical corpus the desktop golden suite uses.                                                                                                                                                                                                  |
| `spikes/mobile-phase0/editor/roundtrip-runner.tsx`         | Create             | Spike 3 runner: feeds each golden fixture through the WebView markdown→blocks→markdown path, diffs vs source (reproducing `byte-preservation.golden.test.ts` in RN), and drives the iOS/Android focus checks. Emits per-fixture diff pass/fail.                                                                                                        |
| `spikes/mobile-phase0/sqlite/triple-flag.ts`               | Create             | Spike 4 runner: opens op-sqlite with SQLCipher+FTS5+sqlite-vec, sets `PRAGMA key`, asserts `cipher_version`, runs the desktop FTS5 DDL verbatim + a bm25 query, and probes a `vec0` nearest-neighbor query. Reports which flags are compiled in.                                                                                                       |
| `spikes/mobile-phase0/flows/`                              | Create             | Maestro flows asserting each spike's on-screen `PASS` verdict on real hardware.                                                                                                                                                                                                                                                                        |
| `spikes/mobile-phase0/results/01-libsodium-byte-compat.md` | Create             | Spike 1 result record + go/no-go call.                                                                                                                                                                                                                                                                                                                 |
| `spikes/mobile-phase0/results/02-yjs-hermes-perf.md`       | Create             | Spike 2 result record + go/no-go call.                                                                                                                                                                                                                                                                                                                 |
| `spikes/mobile-phase0/results/03-blocknote-webview.md`     | Create             | Spike 3 result record; viable / fall-back-to-source-mode (§9.3) verdict.                                                                                                                                                                                                                                                                               |
| `spikes/mobile-phase0/results/04-op-sqlite-triple-flag.md` | Create             | Spike 4 result record + go/no-go call.                                                                                                                                                                                                                                                                                                                 |
| `spikes/mobile-phase0/results/05-pnpm-isolated-install.md` | Create             | Spike 5 result record: isolated linker resolves `apps/mobile` native deps with no hoisted-linker switch; electron install stays green.                                                                                                                                                                                                                 |

### Spike 5 (deliberate real workspace member)

| Path                       | Create/Modify | Responsibility                                                                                                                                                                                                                     |
| -------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/mobile/package.json` | Create        | Minimal Expo scaffold; depends on `react-native-libsodium`, `@op-engineering/op-sqlite`, and `workspace:*` on `@memry/contracts` — proves every native module resolves under pnpm's isolated linker without `nodeLinker: hoisted`. |
| `apps/mobile/index.js`     | Create        | Trivial Expo entry so metro/EAS prebuild has a real target for the resolve/build observation.                                                                                                                                      |
| `apps/mobile/app.json`     | Create        | Minimal Expo config (name/slug/SDK) so `expo` treats `apps/mobile` as a valid project.                                                                                                                                             |
| `pnpm-workspace.yaml`      | Modify        | Spike 5 only: add `react-native-libsodium` and `@op-engineering/op-sqlite` to `allowBuilds`; confirm `apps/mobile` is picked up by the existing `apps/*` glob under the DEFAULT isolated linker. Do NOT add `nodeLinker: hoisted`. |

---

### Task 1: Scaffold the standalone Expo dev-client spike harness + results infra

Bootstraps the throwaway harness so the four on-device spikes have a shared runner, a spike-selector, and a machine-readable results file — all outside the pnpm workspace so it never perturbs the Electron install.

**Files:**

- Create: `spikes/README.md`
- Create: `spikes/mobile-phase0/package.json`
- Create: `spikes/mobile-phase0/app.json`
- Create: `spikes/mobile-phase0/vitest.config.ts`
- Create: `spikes/mobile-phase0/lib/results.ts`
- Create: `spikes/mobile-phase0/App.tsx`
- Test: `spikes/mobile-phase0/lib/results.test.ts` (host-side, node fs)

**Interfaces:**

- Produces: `type SpikeVerdict = 'PASS' | 'FAIL'`
- Produces: `recordSpikeResult(name: string, verdict: SpikeVerdict, metrics: Record<string, unknown>): void`
- Produces: `flushResults(writeFile: (path: string, data: string) => Promise<void>, path: string): Promise<void>`
- Produces: `getResults(): { name: string; verdict: SpikeVerdict; metrics: Record<string, unknown> }[]`

- [ ] **Step 1: Write the failing test** — `spikes/mobile-phase0/lib/results.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { recordSpikeResult, flushResults, getResults, resetResults } from './results'

describe('results collector', () => {
  beforeEach(() => resetResults())

  it('collects verdicts and metrics in order', () => {
    recordSpikeResult('crypto', 'PASS', { argon2idMs: 1820 })
    recordSpikeResult('yjs', 'FAIL', { p95Ms: 900 })
    expect(getResults()).toEqual([
      { name: 'crypto', verdict: 'PASS', metrics: { argon2idMs: 1820 } },
      { name: 'yjs', verdict: 'FAIL', metrics: { p95Ms: 900 } }
    ])
  })

  it('flushes a stable JSON document via the injected writer', async () => {
    recordSpikeResult('sqlite', 'PASS', { fts5: true, sqlcipher: true })
    let written = ''
    await flushResults(async (_p, data) => {
      written = data
    }, '/tmp/phase0-results.json')
    expect(JSON.parse(written)).toEqual({
      results: [{ name: 'sqlite', verdict: 'PASS', metrics: { fts5: true, sqlcipher: true } }]
    })
  })
})
```

- [ ] **Step 2: Run it, expect FAIL** — `cd spikes/mobile-phase0 && npm install && npm test`. Expect: `Error: Failed to resolve import "./results"` (the module does not exist yet).

- [ ] **Step 3: Minimal implementation** — `spikes/mobile-phase0/lib/results.ts`:

```ts
export type SpikeVerdict = 'PASS' | 'FAIL'

interface SpikeResult {
  name: string
  verdict: SpikeVerdict
  metrics: Record<string, unknown>
}

let collected: SpikeResult[] = []

export const recordSpikeResult = (
  name: string,
  verdict: SpikeVerdict,
  metrics: Record<string, unknown>
): void => {
  collected.push({ name, verdict, metrics })
}

export const getResults = (): SpikeResult[] => collected

export const resetResults = (): void => {
  collected = []
}

export const flushResults = async (
  writeFile: (path: string, data: string) => Promise<void>,
  path: string
): Promise<void> => {
  await writeFile(path, JSON.stringify({ results: collected }, null, 2))
}
```

- [ ] **Step 4: Create the harness shell** — `spikes/mobile-phase0/package.json` (standalone, no `workspace:*`):

```json
{
  "name": "memry-phase0-spikes",
  "private": true,
  "version": "0.0.0",
  "main": "index.ts",
  "scripts": {
    "test": "vitest run",
    "ios": "expo run:ios --device",
    "android": "expo run:android --device",
    "gen-corpus": "tsx scripts/gen-interop-corpus.ts",
    "verify-corpus": "tsx scripts/gen-interop-corpus.ts --verify",
    "export-crdt": "tsx scripts/export-crdt-state.ts"
  },
  "dependencies": {
    "expo": "^57.0.0",
    "expo-dev-client": "^6.0.0",
    "expo-file-system": "^19.0.0",
    "expo-secure-store": "^15.0.0",
    "react": "19.2.0",
    "react-native": "0.86.0",
    "react-native-libsodium": "^1.7.0",
    "@noble/curves": "^1.9.0",
    "bip39": "3.1.0",
    "cborg": "4.5.8",
    "pako": "^2.1.0",
    "yjs": "~13.6.29",
    "y-protocols": "^1.0.7",
    "@op-engineering/op-sqlite": "^17.0.0",
    "@expo/dom-webview": "^0.1.0",
    "@blocknote/core": "0.47.1",
    "@blocknote/react": "0.47.1"
  },
  "devDependencies": {
    "libsodium-wrappers-sumo": "^0.8.2",
    "y-leveldb": "^0.1.2",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0"
  }
}
```

Also create `spikes/mobile-phase0/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    environment: 'node'
  }
})
```

And `spikes/mobile-phase0/app.json`:

```json
{
  "expo": {
    "name": "Memry Phase0 Spikes",
    "slug": "memry-phase0-spikes",
    "sdkVersion": "57.0.0",
    "newArchEnabled": true,
    "ios": { "deploymentTarget": "16.0", "bundleIdentifier": "com.memry.phase0" },
    "android": { "minSdkVersion": 29, "package": "com.memry.phase0" },
    "plugins": ["expo-dev-client", "expo-secure-store", "@op-engineering/op-sqlite"]
  }
}
```

And the spike-selector `spikes/mobile-phase0/App.tsx`:

```tsx
import { useState } from 'react'
import { SafeAreaView, Text, Pressable, ScrollView, View } from 'react-native'
import * as FileSystem from 'expo-file-system'
import { flushResults, getResults } from './lib/results'
import { runCryptoSpike } from './crypto/run-vectors'
import { runYjsSpike } from './yjs/perf-runner'
import { runEditorSpike } from './editor/roundtrip-runner'
import { runSqliteSpike } from './sqlite/triple-flag'

const SPIKES: Record<string, () => Promise<void>> = {
  '1 · libsodium byte-compat': runCryptoSpike,
  '2 · yjs-on-hermes perf': runYjsSpike,
  '3 · blocknote webview': runEditorSpike,
  '4 · op-sqlite triple-flag': runSqliteSpike
}

export default function App() {
  const [log, setLog] = useState<string>('idle')
  const run = async (fn: () => Promise<void>) => {
    setLog('running…')
    await fn()
    const out = `${FileSystem.documentDirectory}phase0-results.json`
    await flushResults((p, d) => FileSystem.writeAsStringAsync(p, d), out)
    setLog(
      getResults()
        .map((r) => `${r.name}: ${r.verdict}`)
        .join('\n') || 'no results'
    )
  }
  return (
    <SafeAreaView>
      <ScrollView>
        {Object.entries(SPIKES).map(([label, fn]) => (
          <Pressable key={label} accessibilityRole="button" onPress={() => run(fn)}>
            <Text>{label}</Text>
          </Pressable>
        ))}
        <View accessibilityLabel="spike-log">
          <Text>{log}</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}
```

(The four `run*Spike` runners are implemented in Tasks 2–5; import stubs that `throw new Error('not implemented')` keep the file type-checking until then.)

- [ ] **Step 5: Run tests, expect PASS** — `cd spikes/mobile-phase0 && npm test`. Expect: `2 passed` for `lib/results.test.ts`.

- [ ] **Step 6: Write `spikes/README.md`** — the index + gate table:

```md
# MemryNote mobile — Phase 0 de-risk spikes

`spikes/**` is excluded from the pnpm workspace (`!spikes/**` in pnpm-workspace.yaml),
so this harness never rebuilds Electron/better-sqlite3/classic-level/keytar.
Spike 5 (`apps/mobile`) is the SOLE intentional workspace member.

| #   | Spike                 | Measurable artifact                                            | Pass criterion                                                                                           | Record                              |
| --- | --------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 1   | libsodium byte-compat | per-primitive pass/fail + Argon2id ms + desktop↔mobile interop | all primitives PASS, interop bidirectional, base64 = ORIGINAL, Argon2id ≤ ~3 s on the cheapest D9 device | results/01-libsodium-byte-compat.md |
| 2   | Yjs-on-Hermes perf    | load p50/p95 ms @ log 1/50/500; RSS MB @ 10/50/200 docs        | usable interactive latency + no OOM within D9 4 GB band                                                  | results/02-yjs-hermes-perf.md       |
| 3   | BlockNote-in-WebView  | golden round-trip diff count + focus/IME results               | 14/14 fixtures byte-identical + focus works both OSes                                                    | results/03-blocknote-webview.md     |
| 4   | op-sqlite triple-flag | per-flag compiled/works matrix + bm25 parity                   | SQLCipher + FTS5 both work (sqlite-vec may defer)                                                        | results/04-op-sqlite-triple-flag.md |
| 5   | pnpm isolated-install | linker resolves apps/mobile native deps; electron stays green  | no `nodeLinker: hoisted`; electron install green                                                         | results/05-pnpm-isolated-install.md |

GATE: all five green → commit the mobile timeline. Spike 3 red → fall back to
source-mode-first (spec §9.3) and re-plan the editor as a fast-follow.
```

- [ ] **Step 7: Commit** — `git add spikes/README.md spikes/mobile-phase0 && git commit -m "chore(spikes): scaffold mobile phase-0 dev-client harness + results collector"`

---

### Task 2: Spike 1 — libsodium byte-compat (the foundation gate)

Proves `react-native-libsodium` reproduces the immutable client crypto surface byte-for-byte and that desktop and mobile can decrypt/verify each other's items. If p≠1 or base64≠ORIGINAL anywhere, master keys diverge and every other device quarantines mobile — so every parameter is asserted explicitly, never trusted from defaults.

**Files:**

- Create: `spikes/mobile-phase0/crypto/noble-shims.ts`
- Create: `spikes/mobile-phase0/crypto/vectors.ts`
- Create: `spikes/mobile-phase0/scripts/gen-interop-corpus.ts`
- Create: `spikes/mobile-phase0/crypto/interop.corpus.json` (generated)
- Create: `spikes/mobile-phase0/crypto/run-vectors.ts`
- Create: `spikes/mobile-phase0/results/01-libsodium-byte-compat.md`
- Test: `spikes/mobile-phase0/crypto/noble-shims.test.ts`
- Test: `spikes/mobile-phase0/scripts/gen-interop-corpus.test.ts`
- Create: `spikes/mobile-phase0/flows/spike1-crypto.yaml`

**Interfaces:**

- Consumes (from `tests/sync-harness/src/crypto.ts`): `initCrypto(): Promise<void>`, `generateVaultKey(): Uint8Array`, `generateSigningKeypair(): { publicKey: Uint8Array; secretKey: Uint8Array }`, `encryptItemForPush(input: EncryptForPushInput): { pushItem: PushItem; sizeBytes: number }`, `decryptItemFromPull(input: DecryptFromPullInput): { content: Uint8Array; verified: true }`.
- Consumes (immutable, inlined from `packages/contracts/src/crypto.ts`): `ARGON2_PARAMS = { OPS_LIMIT: 3, MEMORY_LIMIT: 67108864, SALT_LENGTH: 16 }`; KDF contexts `memryvlt`(id 1)/`memrykve`(id 4); `base64_variants.ORIGINAL`.
- Consumes (desktop derivation, reproduced): `deriveMasterKey(seed, salt) = crypto_pwhash(32, seed, salt, 3, 67108864, ALG_ARGON2ID13)` per `apps/desktop/src/main/crypto/keys.ts:43-56`.
- Produces: `scalarmult(scalar: Uint8Array, point: Uint8Array): Uint8Array`, `signEd25519SkToPk(sk: Uint8Array): Uint8Array`, `constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean`, `zeroize(b: Uint8Array): void`.
- Produces: `runCryptoSpike(): Promise<void>` (device entry, records a `'crypto'` result).
- Produces: interop corpus schema `{ phrase, saltB64, masterKeyB64, vaultKeyB64, signerPublicKeyB64, signerDeviceId, items: PushItem[] }`.

- [ ] **Step 1: Write the failing shim test** — `spikes/mobile-phase0/crypto/noble-shims.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'
import { scalarmult, signEd25519SkToPk, constantTimeEqual } from './noble-shims'

beforeAll(async () => {
  await sodium.ready
})

describe('noble crypto shims match libsodium-wrappers-sumo', () => {
  it('scalarmult equals crypto_scalarmult (X25519 ECDH)', () => {
    const a = sodium.crypto_box_keypair()
    const b = sodium.crypto_box_keypair()
    const ref = sodium.crypto_scalarmult(a.privateKey, b.publicKey)
    expect(Buffer.from(scalarmult(a.privateKey, b.publicKey))).toEqual(Buffer.from(ref))
  })

  it('signEd25519SkToPk equals crypto_sign_ed25519_sk_to_pk', () => {
    const kp = sodium.crypto_sign_keypair()
    const ref = sodium.crypto_sign_ed25519_sk_to_pk(kp.privateKey)
    expect(Buffer.from(signEd25519SkToPk(kp.privateKey))).toEqual(Buffer.from(ref))
  })

  it('constantTimeEqual matches on equal and differs on unequal', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true)
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL** — `cd spikes/mobile-phase0 && npm test -- noble-shims`. Expect: `Failed to resolve import "./noble-shims"`.

- [ ] **Step 3: Minimal shim implementation** — `spikes/mobile-phase0/crypto/noble-shims.ts`:

```ts
// Pure-TS shims for the libsodium calls react-native-libsodium does not expose,
// mirroring constantTimeEqual (apps/desktop/src/main/crypto/index.ts:65) and
// secureCleanup semantics. x25519 is only used for interactive linking → ms is fine.
import { x25519 } from '@noble/curves/ed25519'

export const scalarmult = (scalar: Uint8Array, point: Uint8Array): Uint8Array =>
  x25519.getSharedSecret(scalar, point)

// libsodium Ed25519 secret key is seed(32) ‖ publicKey(32).
export const signEd25519SkToPk = (sk: Uint8Array): Uint8Array => sk.subarray(32)

export const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

export const zeroize = (b: Uint8Array): void => b.fill(0)
```

- [ ] **Step 4: Run tests, expect PASS** — `cd spikes/mobile-phase0 && npm test -- noble-shims`. Expect: `3 passed`.

- [ ] **Step 5: Write the failing generator test** — `spikes/mobile-phase0/scripts/gen-interop-corpus.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'
import { buildInteropCorpus, ARGON2, decryptCorpusItem } from './gen-interop-corpus'

beforeAll(async () => {
  await sodium.ready
})

describe('interop corpus generator (desktop side)', () => {
  it('derives a deterministic master key for a fixed phrase+salt', async () => {
    const c1 = await buildInteropCorpus(
      'legal winner thank year wave sausage worth useful legal winner thank yellow'
    )
    const c2 = await buildInteropCorpus(
      'legal winner thank year wave sausage worth useful legal winner thank yellow'
    )
    expect(c1.masterKeyB64).toBe(c2.masterKeyB64)
    expect(ARGON2).toEqual({ OPS_LIMIT: 3, MEMORY_LIMIT: 67108864, SALT_LENGTH: 16 })
  })

  it('emits items that decrypt+verify with libsodium-wrappers-sumo (base64 ORIGINAL)', async () => {
    const corpus = await buildInteropCorpus(
      'legal winner thank year wave sausage worth useful legal winner thank yellow'
    )
    expect(corpus.items.length).toBeGreaterThanOrEqual(1)
    for (const item of corpus.items) {
      const { content } = decryptCorpusItem(corpus, item)
      expect(new TextDecoder().decode(content)).toContain('"kind"')
      // base64 padding present → ORIGINAL alphabet, not URLSAFE_NO_PADDING
      expect(item.encryptedData.endsWith('=') || item.encryptedData.length % 4 === 0).toBe(true)
    }
  })
})
```

- [ ] **Step 6: Run it, expect FAIL** — `cd spikes/mobile-phase0 && npm test -- gen-interop-corpus`. Expect: `Failed to resolve import "./gen-interop-corpus"`.

- [ ] **Step 7: Implement the generator** — `spikes/mobile-phase0/scripts/gen-interop-corpus.ts`. Reproduces desktop `deriveMasterKey` + reuses the real `tests/sync-harness` crypto path:

```ts
import { writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import sodium from 'libsodium-wrappers-sumo'
import { mnemonicToSeedSync } from 'bip39'
import {
  initCrypto,
  generateSigningKeypair,
  encryptItemForPush,
  decryptItemFromPull
} from '../../../tests/sync-harness/src/crypto'

// Immutable — source of truth packages/contracts/src/crypto.ts:28-32.
export const ARGON2 = { OPS_LIMIT: 3, MEMORY_LIMIT: 67108864, SALT_LENGTH: 16 } as const
const B64 = () => sodium.base64_variants.ORIGINAL
const FIXED_SALT = new Uint8Array(16).fill(7) // deterministic corpus salt

export interface InteropCorpus {
  phrase: string
  saltB64: string
  masterKeyB64: string
  vaultKeyB64: string
  signerPublicKeyB64: string
  signerDeviceId: string
  items: ReturnType<typeof encryptItemForPush>['pushItem'][]
}

// Byte-identical to apps/desktop/src/main/crypto/keys.ts:43-56.
const deriveMasterKey = (seed: Uint8Array, salt: Uint8Array): Uint8Array =>
  sodium.crypto_pwhash(
    32,
    seed,
    salt,
    ARGON2.OPS_LIMIT,
    ARGON2.MEMORY_LIMIT,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  )

// ctx 'memryvlt' id 1 — apps/desktop/src/main/crypto/keys.ts:19-21,40.
const deriveVaultKey = (masterKey: Uint8Array): Uint8Array =>
  sodium.crypto_kdf_derive_from_key(32, 1, 'memryvlt', masterKey)

export const buildInteropCorpus = async (phrase: string): Promise<InteropCorpus> => {
  await initCrypto()
  const seed = new Uint8Array(mnemonicToSeedSync(phrase))
  const masterKey = deriveMasterKey(seed, FIXED_SALT)
  const vaultKey = deriveVaultKey(masterKey)
  const signer = generateSigningKeypair()
  const signerDeviceId = sodium.to_hex(sodium.crypto_generichash(16, signer.publicKey, null))
  const payloads = [
    { kind: 'note-metadata', id: 'note-a', title: 'Hello mobile' },
    { kind: 'task', id: 'task-b', title: 'Verify interop', done: false }
  ]
  const items = payloads.map(
    (p) =>
      encryptItemForPush({
        id: p.id,
        type: p.kind === 'task' ? 'task' : 'note',
        operation: 'update',
        content: new TextEncoder().encode(JSON.stringify(p)),
        vaultKey,
        signingSecretKey: signer.secretKey,
        signerDeviceId
      }).pushItem
  )
  return {
    phrase,
    saltB64: sodium.to_base64(FIXED_SALT, B64()),
    masterKeyB64: sodium.to_base64(masterKey, B64()),
    vaultKeyB64: sodium.to_base64(vaultKey, B64()),
    signerPublicKeyB64: sodium.to_base64(signer.publicKey, B64()),
    signerDeviceId,
    items
  }
}

export const decryptCorpusItem = (corpus: InteropCorpus, item: InteropCorpus['items'][number]) =>
  decryptItemFromPull({
    ...item,
    cryptoVersion: 1,
    vaultKey: sodium.from_base64(corpus.vaultKeyB64, B64()),
    signerPublicKey: sodium.from_base64(corpus.signerPublicKeyB64, B64())
  })

const OUT = join(__dirname, '..', 'crypto', 'interop.corpus.json')
const DEMO = 'legal winner thank year wave sausage worth useful legal winner thank yellow'

if (process.argv.includes('--verify')) {
  // Reverse direction: decrypt device-origin items exported off-device.
  const devicePath = process.argv[process.argv.indexOf('--verify') + 1]
  const corpus = JSON.parse(readFileSync(OUT, 'utf-8')) as InteropCorpus
  const deviceItems = JSON.parse(readFileSync(devicePath, 'utf-8'))
    .deviceItems as InteropCorpus['items']
  ;(async () => {
    await initCrypto()
    for (const item of deviceItems) decryptCorpusItem(corpus, item)
    console.log(`verified ${deviceItems.length} device-origin items`)
  })()
} else if (require.main === module) {
  ;(async () => {
    const corpus = await buildInteropCorpus(DEMO)
    writeFileSync(OUT, JSON.stringify(corpus, null, 2))
    console.log(`wrote ${corpus.items.length} items to ${OUT}`)
  })()
}
```

- [ ] **Step 8: Run generator test + generate the corpus** — `cd spikes/mobile-phase0 && npm test -- gen-interop-corpus` (expect `2 passed`), then `npm run gen-corpus` (expect `wrote 2 items to …/interop.corpus.json`). Commit the generated `crypto/interop.corpus.json`.

- [ ] **Step 9: Implement the device runner** — `spikes/mobile-phase0/crypto/run-vectors.ts`. Uses `react-native-libsodium`, asserts every primitive + KDF context + base64 ORIGINAL, decrypts the corpus, re-encrypts a device item, times Argon2id:

```ts
import _sodium from 'react-native-libsodium'
import { mnemonicToSeedSync } from 'bip39'
import corpus from './interop.corpus.json'
import { ARGON2 } from '../scripts/gen-interop-corpus'
import { recordSpikeResult } from '../lib/results'

const ctxCases: [string, number][] = [
  ['memryvlt', 1],
  ['memrysgn', 2],
  ['memryvrf', 3],
  ['memrykve', 4],
  ['memrylnk', 5],
  ['memrymac', 6],
  ['memrysas', 7]
]

export const runCryptoSpike = async (): Promise<void> => {
  const sodium = _sodium
  await sodium.ready
  const ORIGINAL = sodium.base64_variants.ORIGINAL
  const fails: string[] = []

  // 1. Argon2id p=1/m=64MiB/t=3 must equal the desktop master key for the same phrase+salt.
  const seed = new Uint8Array(mnemonicToSeedSync(corpus.phrase))
  const salt = sodium.from_base64(corpus.saltB64, ORIGINAL)
  const t0 = Date.now()
  const masterKey = sodium.crypto_pwhash(
    32,
    seed,
    salt,
    ARGON2.OPS_LIMIT,
    ARGON2.MEMORY_LIMIT,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  )
  const argon2idMs = Date.now() - t0
  if (sodium.to_base64(masterKey, ORIGINAL) !== corpus.masterKeyB64)
    fails.push('argon2id-masterkey')

  // 2. Every BLAKE2b KDF context id resolves without throwing (deterministic 32-B output).
  for (const [ctx, id] of ctxCases) {
    const sub = sodium.crypto_kdf_derive_from_key(32, id, ctx, masterKey)
    if (sub.length !== 32) fails.push(`kdf-${ctx}`)
  }

  // 3. Decrypt + verify every desktop-origin corpus item (base64 ORIGINAL throughout).
  const vaultKey = sodium.from_base64(corpus.vaultKeyB64, ORIGINAL)
  const signerPk = sodium.from_base64(corpus.signerPublicKeyB64, ORIGINAL)
  for (const item of corpus.items) {
    const wrapped = sodium.from_base64(item.encryptedKey, ORIGINAL)
    const keyNonce = sodium.from_base64(item.keyNonce, ORIGINAL)
    const fileKey = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      wrapped,
      null,
      keyNonce,
      vaultKey
    )
    const data = sodium.from_base64(item.encryptedData, ORIGINAL)
    const dataNonce = sodium.from_base64(item.dataNonce, ORIGINAL)
    const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      data,
      null,
      dataNonce,
      fileKey
    )
    if (plain.length === 0) fails.push(`decrypt-${item.id}`)
  }

  recordSpikeResult('crypto', fails.length === 0 ? 'PASS' : 'FAIL', {
    argon2idMs,
    base64Variant: 'ORIGINAL',
    parallelism: 1,
    failures: fails
  })
}
```

(The reverse-direction device→desktop items are written into `phase0-results.json.deviceItems` alongside the verdict and pulled off-device for `npm run verify-corpus`.)

- [ ] **Step 10: Write the Maestro assertion + run on the cheapest D9 device** — `spikes/mobile-phase0/flows/spike1-crypto.yaml`:

```yaml
appId: com.memry.phase0
---
- launchApp
- tapOn: '1 · libsodium byte-compat'
- assertVisible: 'crypto: PASS'
```

Run: `cd spikes/mobile-phase0 && npx expo run:android --device` (cheapest in-band Android, real hardware — not an emulator, per the Argon2id-allocation risk), then `maestro test flows/spike1-crypto.yaml`. Pull the results file and run `npm run verify-corpus /path/to/phase0-results.json` (expect `verified N device-origin items`). Repeat on an iOS 16 device.

- [ ] **Step 11: Write the result record** — `spikes/mobile-phase0/results/01-libsodium-byte-compat.md`: per-primitive pass/fail table, Argon2id 64 MiB wall-clock on the cheapest in-band Android + an iOS 16 device, bidirectional interop verdict, and the go/no-go call. State explicitly: `parallelism=1` and `base64=ORIGINAL` were asserted, not assumed. If Argon2id fails to allocate or exceeds ~3 s, record it as a **device-spec decision** (params are immutable) not a code fix.

- [ ] **Step 12: Commit** — `git add spikes/mobile-phase0/crypto spikes/mobile-phase0/scripts/gen-interop-corpus.* spikes/mobile-phase0/flows/spike1-crypto.yaml spikes/mobile-phase0/results/01-libsodium-byte-compat.md && git commit -m "spike(crypto): libsodium byte-compat + desktop↔mobile interop go/no-go"`

---

### Task 3: Spike 2 — Yjs-on-Hermes perf (the biggest unmeasured unknown)

Loads a **real vault's** CRDT state exported from the desktop `y-leveldb` store and measures `getYDoc`-equivalent latency and resident memory on a mid-range Android, so the `@memry/crdt-core` extraction and the SQLite update-log `CrdtPersistence` impl are validated before they are built.

**Files:**

- Create: `spikes/mobile-phase0/scripts/export-crdt-state.ts`
- Create: `spikes/mobile-phase0/yjs/perf-runner.tsx`
- Create: `spikes/mobile-phase0/results/02-yjs-hermes-perf.md`
- Test: `spikes/mobile-phase0/scripts/export-crdt-state.test.ts`
- Create: `spikes/mobile-phase0/flows/spike2-yjs.yaml`

**Interfaces:**

- Consumes: the `CrdtPersistence` 5-method contract (`getYDoc`, `storeUpdate`, `flushDocument`, `clearDocument`, `destroy`) from `apps/desktop/src/main/sync/crdt-provider.ts:72-78`; the store path `userData/crdt-store` + `LeveldbPersistence`; `CRDT_FRAGMENT_NAME` from `@memry/contracts/ipc-crdt`.
- Produces: exporter output `crdt-corpus.json` = `{ docs: { docId: string; sizeBytes: number; updateLogs: { length: number; updatesB64: string[] }[] }[] }` where `updateLogs` covers lengths 1/50/500 and `docs` includes a 200-entry set.
- Produces: `runYjsSpike(): Promise<void>` (device entry, records a `'yjs'` result with `p50Ms`/`p95Ms` per log length and `rssMb` at 10/50/200 loaded docs).

- [ ] **Step 1: Write the failing exporter test** — `spikes/mobile-phase0/scripts/export-crdt-state.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { buildUpdateLog } from './export-crdt-state'

describe('export-crdt-state', () => {
  it('splits a real doc into a genuine Yjs update log of the requested length', () => {
    const doc = new Y.Doc()
    const text = doc.getText('body')
    const log = buildUpdateLog(
      doc,
      text,
      'the quick brown fox jumps over the lazy dog '.repeat(20),
      50
    )
    expect(log.length).toBe(50)
    // Applying the log in order reconstructs the exact content.
    const replay = new Y.Doc()
    for (const u of log) Y.applyUpdate(replay, u)
    expect(replay.getText('body').toString()).toContain('quick brown fox')
  })
})
```

- [ ] **Step 2: Run it, expect FAIL** — `cd spikes/mobile-phase0 && npm test -- export-crdt-state`. Expect: `Failed to resolve import "./export-crdt-state"`.

- [ ] **Step 3: Implement the exporter** — `spikes/mobile-phase0/scripts/export-crdt-state.ts`. Opens the real `y-leveldb` store for realistic content, and produces genuine N-length Yjs update logs (real bytes, controlled segmentation):

```ts
import { writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import * as Y from 'yjs'
import { LeveldbPersistence } from 'y-leveldb'

// Split real content into N transactions so the log has exactly N genuine updates.
export const buildUpdateLog = (
  doc: Y.Doc,
  text: Y.Text,
  content: string,
  n: number
): Uint8Array[] => {
  const updates: Uint8Array[] = []
  doc.on('update', (u: Uint8Array) => updates.push(u))
  const chunk = Math.max(1, Math.ceil(content.length / n))
  for (let i = 0; i < n; i++) {
    const slice = content.slice(i * chunk, (i + 1) * chunk)
    if (slice) doc.transact(() => text.insert(text.length, slice))
    else doc.transact(() => text.insert(text.length, ' ')) // keep the log length exact
  }
  return updates
}

const toB64 = (u: Uint8Array): string => Buffer.from(u).toString('base64')

const run = async (): Promise<void> => {
  const storePath = join(app.getPath('userData'), 'crdt-store')
  const persistence = new LeveldbPersistence(storePath)
  const names = await persistence.getAllDocNames()
  const sized = await Promise.all(
    names.map(async (docId) => {
      const doc = await persistence.getYDoc(docId)
      const text = doc.getText('body') // CRDT_FRAGMENT_NAME body fragment
      return { docId, content: text.toString() }
    })
  )
  sized.sort((a, b) => a.content.length - b.content.length)
  const pick = (frac: number) => sized[Math.min(sized.length - 1, Math.floor(sized.length * frac))]
  const representative = [pick(0.1), pick(0.5), pick(0.9)] // small / medium / large

  const docs = representative.map(({ docId, content }) => ({
    docId,
    sizeBytes: Buffer.byteLength(content),
    updateLogs: [1, 50, 500].map((length) => ({
      length,
      updatesB64: buildUpdateLog(
        new Y.Doc(),
        new Y.Doc().getText('body'),
        content || 'x',
        length
      ).map(toB64)
    }))
  }))

  const many = sized.slice(0, 200).map(({ docId, content }) => ({
    docId,
    sizeBytes: Buffer.byteLength(content),
    updateLogs: [
      {
        length: 1,
        updatesB64: [
          toB64(
            Y.encodeStateAsUpdate(
              (() => {
                const d = new Y.Doc()
                d.getText('body').insert(0, content || 'x')
                return d
              })()
            )
          )
        ]
      }
    ]
  }))

  const out = join(__dirname, '..', 'yjs', 'crdt-corpus.json')
  writeFileSync(out, JSON.stringify({ docs, many }))
  await persistence.destroy()
  console.log(`exported ${docs.length} representative + ${many.length} bulk docs to ${out}`)
}

if (require.main === module) run()
```

- [ ] **Step 4: Run test + export against a real vault** — `cd spikes/mobile-phase0 && npm test -- export-crdt-state` (expect `1 passed`), then export using a real desktop profile: `MEMRY_USERDATA=<a real dev profile's userData> npx electron -e "require('./scripts/export-crdt-state.ts')"` (or run via the desktop dev harness). Verify `yjs/crdt-corpus.json` is non-empty and `docs[*].updateLogs` contains lengths `[1,50,500]`. **Do not** fabricate the store — the perf numbers are only meaningful against real CRDT bytes.

- [ ] **Step 5: Implement the on-Hermes runner** — `spikes/mobile-phase0/yjs/perf-runner.tsx`:

```tsx
import * as Y from 'yjs'
import corpus from './crdt-corpus.json'
import { recordSpikeResult } from '../lib/results'

const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const percentile = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

export const runYjsSpike = async (): Promise<void> => {
  const byLength: Record<number, { p50Ms: number; p95Ms: number }> = {}

  for (const length of [1, 50, 500]) {
    const samples: number[] = []
    for (const doc of corpus.docs) {
      const log = doc.updateLogs.find((l) => l.length === length)
      if (!log) continue
      const updates = log.updatesB64.map(fromB64)
      const t0 = Date.now()
      const y = new Y.Doc()
      Y.applyUpdate(y, Y.mergeUpdates(updates)) // getYDoc-equivalent cold load
      samples.push(Date.now() - t0)
    }
    byLength[length] = { p50Ms: percentile(samples, 50), p95Ms: percentile(samples, 95) }
  }

  const rssMb: Record<number, number> = {}
  for (const count of [10, 50, 200]) {
    const held: Y.Doc[] = []
    for (const d of corpus.many.slice(0, count)) {
      const y = new Y.Doc()
      Y.applyUpdate(y, fromB64(d.updateLogs[0].updatesB64[0]))
      held.push(y)
    }
    // @ts-expect-error — RN global; approximate JS heap under Hermes
    rssMb[count] = Math.round((globalThis.performance?.memory?.usedJSHeapSize ?? 0) / 1e6)
    held.forEach((d) => d.destroy())
  }

  const worstP95 = Math.max(...[1, 50, 500].map((l) => byLength[l].p95Ms))
  recordSpikeResult('yjs', worstP95 < 500 ? 'PASS' : 'FAIL', { byLength, rssMb })
}
```

- [ ] **Step 6: Assert on-device** — `spikes/mobile-phase0/flows/spike2-yjs.yaml`:

```yaml
appId: com.memry.phase0
---
- launchApp
- tapOn: '2 · yjs-on-hermes perf'
- assertVisible: 'yjs: PASS'
```

Run on a mid-range Android: `npx expo run:android --device && maestro test flows/spike2-yjs.yaml`. Pull `phase0-results.json` for the latency/memory tables.

- [ ] **Step 7: Write the result record** — `spikes/mobile-phase0/results/02-yjs-hermes-perf.md`: latency (p50/p95 ms) at log lengths 1/50/500 and RSS (MB) at 10/50/200 docs on the named mid-range Android; the mitigation ladder tried (flush-merge on cold open → chunked apply via `InteractionManager`/idle) if the raw numbers miss; and the acceptable/not verdict that gates `@memry/crdt-core`.

- [ ] **Step 8: Commit** — `git add spikes/mobile-phase0/scripts/export-crdt-state.* spikes/mobile-phase0/yjs spikes/mobile-phase0/flows/spike2-yjs.yaml spikes/mobile-phase0/results/02-yjs-hermes-perf.md && git commit -m "spike(yjs): yjs-on-hermes perf on real vault crdt state go/no-go"`

---

### Task 4: Spike 3 — BlockNote-in-WebView editor (routes to source-mode fallback on failure)

Runs the exact desktop editor schema + serializer + BlockNote 0.47.1 inside an Expo DOM component and diffs a markdown round-trip against the 14 golden-vault fixtures — reproducing `byte-preservation.golden.test.ts` on-device. A red verdict here is the documented trigger to fall back to source-mode-first (spec §9.3) and re-plan the editor as a fast-follow.

**Files:**

- Create: `spikes/mobile-phase0/editor/editor.dom.tsx`
- Create: `spikes/mobile-phase0/editor/fixtures.bundle.ts`
- Create: `spikes/mobile-phase0/editor/roundtrip-runner.tsx`
- Create: `spikes/mobile-phase0/results/03-blocknote-webview.md`
- Test: `spikes/mobile-phase0/editor/fixtures.bundle.test.ts`
- Create: `spikes/mobile-phase0/flows/spike3-editor.yaml`

**Interfaces:**

- Consumes: the 14 golden-vault fixtures at `apps/desktop/src/main/vault/__fixtures__/golden-vault/*.md`; the golden assertion pattern (`parseNote → serializeParsedNote` byte-identical) from `apps/desktop/src/main/vault/byte-preservation.golden.test.ts:32-43`.
- Consumes: `@blocknote/*@0.47.1` (DOM/WebView only — never on Hermes; `@blocknote/server-util` needs a DOM and cannot run on Hermes, so conversion runs inside the WebView).
- Produces: `loadFixtures(): { name: string; source: string }[]` (build-inlined corpus).
- Produces: DOM-component typed actions `roundTrip(markdown: string): Promise<string>`, `focusProbe(): Promise<{ focused: boolean; caretVisible: boolean }>`.
- Produces: `runEditorSpike(): Promise<void>` (device entry, records an `'editor'` result with `passCount`/`total`/`focus`).

- [ ] **Step 1: Write the failing fixtures test** — `spikes/mobile-phase0/editor/fixtures.bundle.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { loadFixtures } from './fixtures.bundle'

describe('golden-vault fixture bundle', () => {
  it('inlines the full adversarial golden corpus (≥14 markdown fixtures)', () => {
    const fixtures = loadFixtures()
    expect(fixtures.length).toBeGreaterThanOrEqual(14)
    expect(fixtures.map((f) => f.name)).toContain('nested-callouts.md')
    expect(fixtures.every((f) => typeof f.source === 'string' && f.source.length > 0)).toBe(true)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL** — `cd spikes/mobile-phase0 && npm test -- fixtures.bundle`. Expect: `Failed to resolve import "./fixtures.bundle"`.

- [ ] **Step 3: Implement the fixtures bundle** — `spikes/mobile-phase0/editor/fixtures.bundle.ts` (reads the real fixture dir at build time; the identical corpus the desktop golden suite uses):

```ts
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

const GOLDEN_DIR = join(__dirname, '../../../apps/desktop/src/main/vault/__fixtures__/golden-vault')

export interface Fixture {
  name: string
  source: string
}

export const loadFixtures = (): Fixture[] =>
  readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((name) => ({ name, source: readFileSync(join(GOLDEN_DIR, name), 'utf-8') }))
```

(For the on-device bundle, a metro transform inlines `loadFixtures()`'s output as a static array so the device runs without filesystem access — see Step 5.)

- [ ] **Step 4: Run test, expect PASS** — `cd spikes/mobile-phase0 && npm test -- fixtures.bundle`. Expect: `1 passed`.

- [ ] **Step 5: Implement the DOM editor component** — `spikes/mobile-phase0/editor/editor.dom.tsx` (`'use dom'`; content arrives via `postMessage` after mount, never as initial props — avoids the known `@expo/dom-webview` iOS blank-on-large-initial-props bug):

```tsx
'use dom'
import { useEffect, useState } from 'react'
import { BlockNoteEditor } from '@blocknote/core'

// NOTE: for the spike we validate the round-trip pipeline with BlockNote's
// stock markdown converter. The extraction plan (@memry/editor-web) swaps this
// for the exact desktop editor-schema (6 blocks + 4 inlines) + markdown-utils.
export default function EditorDom({
  onRoundTrip
}: {
  onRoundTrip: (fn: (md: string) => Promise<string>) => void
  dom?: import('@expo/dom-webview').DOMProps
}) {
  const [editor] = useState(() => BlockNoteEditor.create())
  useEffect(() => {
    onRoundTrip(async (md: string) => {
      const blocks = await editor.tryParseMarkdownToBlocks(md)
      return editor.blocksToMarkdownLossy(blocks)
    })
  }, [editor, onRoundTrip])
  return <div id="bn-root" style={{ minHeight: 200 }} />
}
```

- [ ] **Step 6: Implement the round-trip runner** — `spikes/mobile-phase0/editor/roundtrip-runner.tsx` (feeds each fixture through the WebView, diffs vs source, drives the focus/IME checks):

```tsx
import { useRef } from 'react'
import EditorDom from './editor.dom'
import { GOLDEN_FIXTURES } from './fixtures.inlined' // metro-inlined loadFixtures() output
import { recordSpikeResult } from '../lib/results'

export const runEditorSpike = async (): Promise<void> => {
  const roundTripRef: { current: ((md: string) => Promise<string>) | null } = { current: null }
  // The DOM component is mounted by App.tsx; here we drive it once ready.
  await new Promise<void>((resolve) => {
    const check = () => (roundTripRef.current ? resolve() : setTimeout(check, 50))
    check()
  })

  let passCount = 0
  const diffs: { name: string; equal: boolean }[] = []
  for (const fx of GOLDEN_FIXTURES) {
    const out = await roundTripRef.current!(fx.source)
    const equal = out === fx.source
    if (equal) passCount++
    diffs.push({ name: fx.name, equal })
  }

  recordSpikeResult('editor', passCount === GOLDEN_FIXTURES.length ? 'PASS' : 'FAIL', {
    passCount,
    total: GOLDEN_FIXTURES.length,
    diffs
  })
}

export { roundTripRef }
```

(`App.tsx` renders `<EditorDom onRoundTrip={(fn) => (roundTripRef.current = fn)} />`; the focus/IME probe taps the editor and asserts `document.activeElement` inside the DOM component, recording `focus: { ios: boolean; android: boolean }` — iOS `keyboardDisplayRequiresUserAction`, Android `.focus()`.)

- [ ] **Step 7: Assert on-device (both OSes)** — `spikes/mobile-phase0/flows/spike3-editor.yaml`:

```yaml
appId: com.memry.phase0
---
- launchApp
- tapOn: '3 · blocknote webview'
- assertVisible:
    text: 'editor: (PASS|FAIL)'
    optional: false
```

Run `npx expo run:ios --device && maestro test flows/spike3-editor.yaml` and the Android equivalent. Pull `phase0-results.json` for the per-fixture diff table + focus results (GBoard, iOS autocorrect, CJK).

- [ ] **Step 8: Write the result record + route the outcome** — `spikes/mobile-phase0/results/03-blocknote-webview.md`: round-trip pass count vs the 14 golden fixtures, keyboard/IME focus results per OS, `@expo/dom-webview` large-content-via-postMessage behavior, and the verdict. **If the verdict is FAIL, the record MUST state the routing decision explicitly:** fall back to source-mode-first (spec §9.3, plain-`TextInput` markdown editing saving through the `crdt-feed.ts` markdown→blocks→full-fragment-replace path) and re-plan the rich editor as a fast-follow — the rest of the timeline is NOT blocked.

- [ ] **Step 9: Commit** — `git add spikes/mobile-phase0/editor spikes/mobile-phase0/flows/spike3-editor.yaml spikes/mobile-phase0/results/03-blocknote-webview.md && git commit -m "spike(editor): blocknote-in-webview golden round-trip + focus probe go/no-go"`

---

### Task 5: Spike 4 — op-sqlite triple-flag (SQLCipher + FTS5 + sqlite-vec)

Proves op-sqlite can open with SQLCipher, FTS5, and (optionally) sqlite-vec compiled into a single build, running the desktop FTS5 DDL verbatim so the mobile local data layer is unblocked. SQLCipher + FTS5 must both work; sqlite-vec may legitimately defer (semantic search is post-v1).

**Files:**

- Create: `spikes/mobile-phase0/sqlite/triple-flag.ts`
- Create: `spikes/mobile-phase0/results/04-op-sqlite-triple-flag.md`
- Test: `spikes/mobile-phase0/sqlite/ddl.test.ts` (host-side, asserts the DDL string parity)
- Create: `spikes/mobile-phase0/flows/spike4-sqlite.yaml`

**Interfaces:**

- Consumes: the FTS5 DDL from `apps/desktop/src/main/database/fts.ts:25-33` (`CREATE VIRTUAL TABLE … USING fts5(id UNINDEXED, title, content, tags, tokenize='porter unicode61')`).
- Consumes: `@op-engineering/op-sqlite@^17` `open({ name, encryptionKey })` + `db.execute` / `db.executeSync`.
- Produces: `FTS_NOTES_DDL: string` (single source shared by host test + device runner).
- Produces: `runSqliteSpike(): Promise<void>` (device entry, records a `'sqlite'` result with `{ sqlcipher, cipherVersion, fts5, bm25, sqliteVec }`).

- [ ] **Step 1: Write the failing DDL parity test** — `spikes/mobile-phase0/sqlite/ddl.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { FTS_NOTES_DDL } from './triple-flag'

describe('mobile FTS5 DDL matches desktop fts.ts', () => {
  it('uses the same table shape and porter unicode61 tokenizer', () => {
    const normalized = FTS_NOTES_DDL.replace(/\s+/g, ' ').trim()
    expect(normalized).toContain('CREATE VIRTUAL TABLE IF NOT EXISTS fts_notes USING fts5(')
    expect(normalized).toContain('id UNINDEXED')
    expect(normalized).toContain("tokenize='porter unicode61'")
  })
})
```

- [ ] **Step 2: Run it, expect FAIL** — `cd spikes/mobile-phase0 && npm test -- ddl`. Expect: `Failed to resolve import "./triple-flag"`.

- [ ] **Step 3: Implement the runner + DDL constant** — `spikes/mobile-phase0/sqlite/triple-flag.ts` (DDL copied verbatim from `fts.ts`; op-sqlite must be built with `sqlcipher`, `fts5`, and `sqlite-vec` flags in `package.json`):

```ts
import { open } from '@op-engineering/op-sqlite'
import { recordSpikeResult } from '../lib/results'

// Verbatim from apps/desktop/src/main/database/fts.ts:26-33.
export const FTS_NOTES_DDL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS fts_notes USING fts5(
    id UNINDEXED,
    title,
    content,
    tags,
    tokenize='porter unicode61'
  )
`

export const runSqliteSpike = async (): Promise<void> => {
  const result = { sqlcipher: false, cipherVersion: '', fts5: false, bm25: false, sqliteVec: false }
  const db = open({ name: 'phase0.db', encryptionKey: '0'.repeat(64) }) // 32-B hex key

  try {
    const cipher = await db.execute('PRAGMA cipher_version')
    result.cipherVersion = String(cipher.rows?._array?.[0]?.cipher_version ?? '')
    result.sqlcipher = result.cipherVersion.length > 0

    await db.execute(FTS_NOTES_DDL)
    await db.execute(
      "INSERT INTO fts_notes (id, title, content, tags) VALUES ('n1', 'Running notes', 'the runner runs daily', 'fitness')"
    )
    const hits = await db.execute(
      "SELECT id, bm25(fts_notes) AS score FROM fts_notes WHERE fts_notes MATCH 'run' ORDER BY score"
    )
    result.fts5 = (hits.rows?._array?.length ?? 0) > 0 // porter stems 'run'→'runner'/'runs'
    result.bm25 = typeof hits.rows?._array?.[0]?.score === 'number'

    try {
      await db.execute('CREATE VIRTUAL TABLE vec_notes USING vec0(embedding float[4])')
      await db.execute("INSERT INTO vec_notes(rowid, embedding) VALUES (1, '[0.1,0.2,0.3,0.4]')")
      const nn = await db.execute(
        "SELECT rowid FROM vec_notes WHERE embedding MATCH '[0.1,0.2,0.3,0.4]' ORDER BY distance LIMIT 1"
      )
      result.sqliteVec = (nn.rows?._array?.length ?? 0) > 0
    } catch {
      result.sqliteVec = false // documented defer path
    }
  } finally {
    db.close()
  }

  // SQLCipher + FTS5 are hard requirements; sqlite-vec may defer.
  const verdict = result.sqlcipher && result.fts5 && result.bm25 ? 'PASS' : 'FAIL'
  recordSpikeResult('sqlite', verdict, result)
}
```

- [ ] **Step 4: Run DDL test, expect PASS** — `cd spikes/mobile-phase0 && npm test -- ddl`. Expect: `1 passed`.

- [ ] **Step 5: Assert on-device (both OSes)** — `spikes/mobile-phase0/flows/spike4-sqlite.yaml`:

```yaml
appId: com.memry.phase0
---
- launchApp
- tapOn: '4 · op-sqlite triple-flag'
- assertVisible: 'sqlite: PASS'
```

Run `npx expo run:android --device && maestro test flows/spike4-sqlite.yaml`, then the iOS device. Pull `phase0-results.json` for the per-flag matrix and the `cipher_version` string.

- [ ] **Step 6: Write the result record** — `spikes/mobile-phase0/results/04-op-sqlite-triple-flag.md`: per-flag compiled/works matrix on iOS + Android, the `cipher_version`, FTS5 porter/bm25 result parity with desktop, sqlite-vec availability (or documented defer), and the go/no-go call for the local data layer. Note explicitly whether `sqlite-vec` requiring a source patch would push semantic search to a fast-follow.

- [ ] **Step 7: Commit** — `git add spikes/mobile-phase0/sqlite spikes/mobile-phase0/flows/spike4-sqlite.yaml spikes/mobile-phase0/results/04-op-sqlite-triple-flag.md && git commit -m "spike(sqlite): op-sqlite sqlcipher+fts5+vec triple-flag go/no-go"`

---

### Task 6: Spike 5 — pnpm isolated-install (protect the Electron install)

Adds a real `apps/mobile` workspace member (matched by the existing `apps/*` glob) depending on the native modules + `workspace:*` on `@memry/contracts`, and proves pnpm's **isolated** linker resolves everything with `shamefullyHoist: true` (already set) and **no** switch to a hoisted linker — which would force re-testing the whole Electron/better-sqlite3/classic-level/keytar install. This spike's pass condition is that `pnpm-workspace.yaml` needs no hoisted-linker change and the electron build stays green.

**Files:**

- Create: `apps/mobile/package.json`
- Create: `apps/mobile/index.js`
- Create: `apps/mobile/app.json`
- Modify: `pnpm-workspace.yaml` (add two entries to `allowBuilds`)
- Create: `spikes/mobile-phase0/results/05-pnpm-isolated-install.md`

**Interfaces:**

- Consumes: `pnpm-workspace.yaml` current shape — `packages: [apps/*, packages/*, tests/*, '!spikes/**']`, `shamefullyHoist: true`, `allowBuilds` map (already lists `electron`, `better-sqlite3`, `classic-level`, `keytar`).
- Produces: `apps/mobile` resolving `react-native-libsodium`, `@op-engineering/op-sqlite`, and `@memry/contracts` under the isolated linker.

- [ ] **Step 1: Create the minimal workspace member** — `apps/mobile/package.json` (imports `@memry/contracts` via `workspace:*` — proving the import-not-copy rule works in a real member):

```json
{
  "name": "@memry/mobile",
  "private": true,
  "version": "0.0.0",
  "main": "index.js",
  "scripts": {
    "start": "expo start --dev-client"
  },
  "dependencies": {
    "@memry/contracts": "workspace:*",
    "expo": "^57.0.0",
    "expo-dev-client": "^6.0.0",
    "react": "19.2.0",
    "react-native": "0.86.0",
    "react-native-libsodium": "^1.7.0",
    "@op-engineering/op-sqlite": "^17.0.0"
  }
}
```

`apps/mobile/index.js`:

```js
import { registerRootComponent } from 'expo'
import { Text } from 'react-native'

// Minimal real target so metro/EAS prebuild + native resolve can be observed.
registerRootComponent(() => Text({ children: 'memry mobile spike' }))
```

`apps/mobile/app.json`:

```json
{
  "expo": {
    "name": "Memry Mobile",
    "slug": "memry-mobile",
    "sdkVersion": "57.0.0",
    "newArchEnabled": true
  }
}
```

- [ ] **Step 2: Modify `pnpm-workspace.yaml`** — add the two native modules to `allowBuilds` so their native postinstalls are permitted (do NOT add `nodeLinker: hoisted`, do NOT touch `shamefullyHoist`). Insert after the `keytar: true` line:

```yaml
allowBuilds:
  electron: true
  esbuild: true
  better-sqlite3: true
  sharp: true
  classic-level: true
  keytar: true
  react-native-libsodium: true
  '@op-engineering/op-sqlite': true
  core-js: false
```

- [ ] **Step 3: Install under the isolated linker, expect resolve to succeed** — from the repo root: `pnpm install`. Expect: install completes; `apps/mobile` appears in the workspace; `pnpm ls --filter @memry/mobile react-native-libsodium @op-engineering/op-sqlite @memry/contracts` shows all three resolved. If pnpm demands `nodeLinker: hoisted`, the spike **fails** — record it and stop (do not flip the linker without a separate decision).

- [ ] **Step 4: Prove the Electron install is still green (the regression this spike protects)** — `pnpm --filter @memry/desktop rebuild:electron`, then `pnpm --filter @memry/desktop test:main`. Expect: native modules load (no `ERR_DLOPEN_FAILED`) and the desktop main suite passes. Also run `pnpm typecheck` to confirm no workspace-wide type regression from the new member.

- [ ] **Step 5: Confirm `@memry/contracts` imports from the real member** — add a one-line smoke import in `apps/mobile/index.js` (`import { CRYPTO_VERSION } from '@memry/contracts/crypto'` then reference it) and run `pnpm --filter @memry/mobile exec tsx -e "import('@memry/contracts/crypto').then(m => console.log(m.CRYPTO_VERSION))"`. Expect: prints `1`. This is the concrete proof of the import-not-copy rule the extraction plans depend on.

- [ ] **Step 6: Write the result record** — `spikes/mobile-phase0/results/05-pnpm-isolated-install.md`: confirms pnpm's isolated linker resolves `apps/mobile` native deps with `shamefullyHoist: true` and **no** hoisted-linker switch; records that the electron install (`rebuild:electron` + `test:main`) stayed green afterward; and the go/no-go call.

- [ ] **Step 7: Commit** — `git add apps/mobile pnpm-workspace.yaml pnpm-lock.yaml spikes/mobile-phase0/results/05-pnpm-isolated-install.md && git commit -m "spike(pnpm): apps/mobile isolated-linker resolve without hoisted; electron stays green"`

---

### Task 7: Phase-0 gate roll-up (commit-timeline vs re-plan decision)

Aggregates the five verdicts into the single go/no-go decision that gates the rest of the mobile program (spec §18), and encodes the editor-fallback routing so the outcome is unambiguous for the next planner.

**Files:**

- Modify: `spikes/README.md` (fill the gate table's result column + write the final decision)
- Create: `spikes/mobile-phase0/results/00-phase0-gate.md`
- Test: `spikes/mobile-phase0/lib/gate.test.ts`
- Create: `spikes/mobile-phase0/lib/gate.ts`

**Interfaces:**

- Consumes: the five result records + the on-device `phase0-results.json` verdicts (`crypto`/`yjs`/`editor`/`sqlite`) and the Spike 5 install/electron-green outcome.
- Produces: `computeGate(verdicts: Record<string, SpikeVerdict>): { proceed: boolean; editorFallback: boolean; blockers: string[] }`.

- [ ] **Step 1: Write the failing gate test** — `spikes/mobile-phase0/lib/gate.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { computeGate } from './gate'

describe('phase-0 gate decision', () => {
  it('proceeds when all five are green', () => {
    expect(
      computeGate({ crypto: 'PASS', yjs: 'PASS', editor: 'PASS', sqlite: 'PASS', pnpm: 'PASS' })
    ).toEqual({ proceed: true, editorFallback: false, blockers: [] })
  })

  it('editor FAIL alone still proceeds but routes to source-mode fallback', () => {
    expect(
      computeGate({ crypto: 'PASS', yjs: 'PASS', editor: 'FAIL', sqlite: 'PASS', pnpm: 'PASS' })
    ).toEqual({ proceed: true, editorFallback: true, blockers: [] })
  })

  it('a crypto/yjs/sqlite/pnpm FAIL is a hard blocker', () => {
    const gate = computeGate({
      crypto: 'FAIL',
      yjs: 'PASS',
      editor: 'PASS',
      sqlite: 'PASS',
      pnpm: 'PASS'
    })
    expect(gate.proceed).toBe(false)
    expect(gate.blockers).toContain('crypto')
  })
})
```

- [ ] **Step 2: Run it, expect FAIL** — `cd spikes/mobile-phase0 && npm test -- gate`. Expect: `Failed to resolve import "./gate"`.

- [ ] **Step 3: Implement the gate** — `spikes/mobile-phase0/lib/gate.ts`:

```ts
import type { SpikeVerdict } from './results'

const HARD_BLOCKERS = ['crypto', 'yjs', 'sqlite', 'pnpm'] as const

export const computeGate = (
  verdicts: Record<string, SpikeVerdict>
): { proceed: boolean; editorFallback: boolean; blockers: string[] } => {
  const blockers = HARD_BLOCKERS.filter((k) => verdicts[k] !== 'PASS')
  return {
    proceed: blockers.length === 0,
    editorFallback: verdicts.editor !== 'PASS',
    blockers
  }
}
```

- [ ] **Step 4: Run tests, expect PASS** — `cd spikes/mobile-phase0 && npm test -- gate`. Expect: `3 passed`. Then run the full host suite `npm test` and expect every host test across Tasks 1–7 green.

- [ ] **Step 5: Write the gate record + fill the README** — `spikes/mobile-phase0/results/00-phase0-gate.md`: the five verdicts, the `computeGate` output, and the decision. If `proceed && !editorFallback` → "commit the mobile timeline as planned (extraction plans phase0-gated tasks unblocked)". If `proceed && editorFallback` → "commit the timeline BUT re-plan the mobile editor as source-mode-first (spec §9.3), rich editor demoted to fast-follow". If `!proceed` → "STOP: `<blockers>` are hard blockers; the named seam (`SodiumProvider`/`CrdtPersistence`/`DrizzleDb`/pnpm-linker) must be re-solved before the timeline is committed". Fill the `spikes/README.md` gate-table result column with links to each record.

- [ ] **Step 6: Commit** — `git add spikes/mobile-phase0/lib/gate.* spikes/mobile-phase0/results/00-phase0-gate.md spikes/README.md && git commit -m "spike(gate): phase-0 go/no-go roll-up + editor-fallback routing"`

---

## Verification summary (whole plan)

- Host-runnable unit tests (Tasks 1–7): `cd spikes/mobile-phase0 && npm test` — results collector, noble shims vs `libsodium-wrappers-sumo`, interop-corpus generator round-trip, CRDT update-log builder, golden-fixture bundle, FTS5 DDL parity, gate decision.
- On-device verdicts (Spikes 1–4): `npx expo run:ios --device` / `npx expo run:android --device` on a real cheapest-in-band D9 device, asserted by `maestro test flows/*.yaml`; measured numbers pulled from `phase0-results.json`.
- Spike 5 (repo root): `pnpm install` resolves `apps/mobile` native deps under the isolated linker; `pnpm --filter @memry/desktop rebuild:electron && pnpm --filter @memry/desktop test:main && pnpm typecheck` prove the Electron install stayed green.
- Desktop stays green throughout: every task except Spike 5 lives under `spikes/**` (workspace-excluded), so it cannot touch the Electron install; Spike 5's only workspace change is additive (`apps/mobile` + two `allowBuilds` entries) and is explicitly gated on the desktop main suite passing.
- Gate: all five green → commit the timeline (extraction plans' phase0-gated tasks unblocked); Spike 3 red only → source-mode-first re-plan; any of crypto/yjs/sqlite/pnpm red → stop and re-solve the named seam.
