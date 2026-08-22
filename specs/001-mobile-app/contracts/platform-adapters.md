# Contract: @memry/sync-client Platform Adapters

**Feature**: 001-mobile-app | **Date**: 2026-08-22

The 10 seams from the decision record §7. These are the **only** places platform
code may live; everything else in `@memry/sync-client` is platform-free
TypeScript. Interfaces are defined in `packages/sync-client/src/adapters/` and
implemented twice: `apps/desktop/src/main/sync/` (electron/node allowed) and
`apps/mobile/src/adapters/` (Expo/RN allowed). Signatures may not reference
node, electron, or RN types — plain TS types, `Uint8Array` for bytes,
`AsyncIterable`/`Promise` for effects.

Extraction rule (Constitution I): these land in Train Phase 1 with desktop
behaviour unchanged; mobile implementations arrive in Phase 2. The method lists
below are the contract's shape — exact signatures are finalized in T1.2 by
lifting them from the current desktop call sites, not by redesign.

## 1. `HttpClient`

Replaces desktop's `http-client.ts` (+ the electron parts of `network.ts`).

```ts
interface SyncHttpClient {
  request(req: {
    method: 'GET'|'POST'|'PUT'|'DELETE'
    path: string                      // relative to sync base URL
    headers?: Record<string, string>  // engine adds x-memry-client here (Phase 2)
    body?: Uint8Array | string
    signal?: AbortSignal
  }): Promise<{ status: number; headers: Record<string,string>; body: Uint8Array }>
  /** connectivity signal for outbox pacing; push-based */
  onOnlineChanged(cb: (online: boolean) => void): () => void
  isMetered(): Promise<boolean>       // attachments Wi-Fi-only policy
}
```

Desktop: net/undici as today. Mobile: `fetch` + NetInfo. Retry/backoff/429
pacing stays in the shared engine, **not** in adapters.

## 2. `CertificatePinning`

```ts
interface CertificatePinningAdapter {
  /** wire pinning into the transport if the platform supports it */
  configure(pins: ReadonlyArray<string>): void
  isEnforced(): boolean
}
```

Mobile implementation is an explicit **no-op** (`isEnforced() → false`) — a
decision, not a gap: a bad pin cannot be fixed faster than App Store review
(record §7). Desktop keeps current behaviour (pins are placeholders today;
separate pre-existing issue — do not touch here).

## 3. `CrdtPersistence`

Replaces `y-leveldb` usage (`crdt-persistence.ts`, `crdt-pending-notes.ts`).

```ts
interface CrdtPersistenceAdapter {
  appendUpdate(docId: string, update: Uint8Array): Promise<void>
  loadDoc(docId: string): Promise<{ updates: Uint8Array[]; snapshot?: Uint8Array }>
  saveSnapshot(docId: string, snapshot: Uint8Array, upToSeq: number): Promise<void>
  compact(docId: string): Promise<void>
  listDocs(): Promise<string[]>
  deleteDoc(docId: string): Promise<void>   // tombstone flow
}
```

Desktop: leveldb-backed as today. Mobile: `yjs_updates`/`yjs_snapshots` tables
(data-model.md §1). Durability rule: `appendUpdate` resolves only after the
bytes are on disk (Constitution: memory-only CRDT state is assumed lost).

## 4. `CrdtStorePath`

```ts
interface CrdtStorePathAdapter {
  storeRootFor(vaultId: string): Promise<string>
  ensureExists(path: string): Promise<void>
}
```

Desktop: userData-derived path (see `app.name` landmine). Mobile: vault
directory under the app sandbox.

## 5. `AttachmentStore`

```ts
interface AttachmentStoreAdapter {
  writeBytes(vaultId: string, attachmentId: string, bytes: Uint8Array): Promise<{ path: string }>
  readBytes(vaultId: string, attachmentId: string): Promise<Uint8Array | null>
  exists(vaultId: string, attachmentId: string): Promise<boolean>
  delete(vaultId: string, attachmentId: string): Promise<void>
  /** platform file protection applied at write time (NSFileProtection on iOS) */
}
```

Bytes are always files (both shells). Lazy/Wi-Fi-only download **policy** lives
in the shared engine using `HttpClient.isMetered()`; the adapter only stores.

## 6. `VaultDirectory`

```ts
interface VaultDirectoryAdapter {
  resolveVaultRoot(vaultId: string): Promise<string>
  listLocalVaults(): Promise<Array<{ vaultId: string; root: string }>>
  provision(vaultId: string): Promise<string>   // new-device path; must not dead-end
}
```

## 7. `DeviceRegistration`

```ts
interface DeviceRegistrationAdapter {
  deviceId(): Promise<string>
  deviceInfo(): Promise<{ platform: 'desktop'|'ios'|'android'; model: string; appVersion: string }>
  signingKeypair(vaultId: string): Promise<{ publicKey: Uint8Array; sign(msg: Uint8Array): Promise<Uint8Array> }>
}
```

Key material never crosses this interface raw beyond what desktop already
exposes; mobile backs it with expo-secure-store.

## 8. `CrdtProvider`

The seam by which UI surfaces attach to engine-owned Y.Docs (desktop: IPC
provider renderer↔main; mobile: WebView bridge provider — see
[webview-bridge.md](./webview-bridge.md)).

```ts
interface CrdtProviderHost {
  attach(docId: string, transport: CrdtTransport): () => void
}
interface CrdtTransport {
  sendToUi(frames: Uint8Array[]): void          // batched
  onFromUi(cb: (frames: Uint8Array[]) => void): () => void
  /** origin tagging so echoes don't loop (desktop: sourceWindowId; mobile: bridge session id) */
  originTag: string
}
```

## 9. `CrdtPreflight`

```ts
interface CrdtPreflightAdapter {
  verifyStoreHealth(vaultId: string): Promise<{ ok: true } | { ok: false; reason: string }>
}
```

Desktop: current preflight (note the Windows 0xC0000005 incident — behaviour
unchanged by extraction). Mobile: SQLite integrity check (`PRAGMA quick_check`)
+ schema-version assert.

## 10. `Runtime`

Replaces `runtime.ts` electron surface (`app.getVersion()`, paths, lifecycle).

```ts
interface RuntimeAdapter {
  appVersion(): string
  platform(): 'desktop'|'ios'|'android'
  onForeground(cb: () => void): () => void      // triggers foreground sync
  onBackground(cb: () => void): () => void      // flush outbox, persist state
  scheduleBackgroundSync?(minIntervalSec: number): void   // BGAppRefreshTask on iOS; absent on desktop
  log: SyncLogger                                // project logger seam (no console.*)
}
```

## Conformance

- One shared **adapter conformance suite** in `packages/sync-client` runs against
  every implementation (desktop impls under Vitest/node; mobile impls on-device
  or under RN test runner). Real adapters, not mocks (Constitution III).
- `pnpm check:architecture` proves: no electron/node import outside
  `apps/desktop`'s adapter dir; nothing reachable from `apps/mobile` imports
  node builtins or electron.
- Adding an 11th seam requires a written justification in the PR (the 10-seam
  list is the decision record's; drift goes through review, not accretion).
