# Contract: RN↔WebView Editor Bridge

**Feature**: 001-mobile-app | **Date**: 2026-08-22

The note body is the only WebView surface: it hosts BlockNote so
`@memry/editor-schema` stays the single source of truth. The **Y.Doc lives on the
React Native side** (mirroring Electron main-process ownership); the WebView gets
a bridge provider analogous to desktop's IPC provider. WebView-owned document
state backed by web storage is rejected — iOS may evict it and silently lose
unsynced writes (decision record §4).

## Transport constraints (launch requirements, not optimizations)

- **String-only.** `postMessage` both directions carries a single JSON string.
  Binary (Yjs updates) is **base64-framed** inside it.
- **Batched on both ends.** Per-keystroke or per-update crossings are a defect
  regardless of measured comfort (Constitution V). Each side accumulates frames
  and flushes on: (a) a flush interval `T_flush` (tuned in R4: **24 ms**
  adopted from the G0-d device run), (b) a byte ceiling `B_max` per envelope
  (**256 KiB** pre-base64, confirmed), or (c) an explicit `flush` (blur, save,
  background transition) — whichever first.
  _G0-d measurements (iPhone 12 Pro, release, 2026-08-23): delivery p95
  2.0 ms, apply p95 0.08 ms, seq gaps 0, 5 MB doc-load 116 ms. Note: at
  10 keystrokes/s the 24 ms window never coalesces (msgs/envelope 1.0 is
  expected arithmetic, not a defect); the coalescing requirement is judged at
  G3 against real Yjs update clusters, which do arrive faster than `T_flush`._
- **Typed + versioned + generated.** Envelope and message types live in
  `packages/contracts` (or a bridge sub-package) and are generated into both
  sides, same discipline as `ipc:check`. Hand-written `any` at this boundary is
  a defect (Constitution II).

## Envelope

```ts
interface BridgeEnvelope {
  v: 1 // protocol version; bump = both sides regenerate
  sid: string // bridge session id (origin tag; prevents echo loops)
  seq: number // per-sender monotonic; receiver detects gaps
  msgs: BridgeMsg[] // the batch
}
```

Gap detection (`seq`) triggers a full resync (`doc-load`), never silent loss.
Messages after `ready` and before `doc-load` are dropped by design.

## Messages

### RN → WebView

| type              | payload                                             | notes                                                          |
| ----------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| `doc-load`        | `{ docId, stateB64 }`                               | full Yjs state (encoded update) at open/resync                 |
| `y-update`        | `{ docId, updatesB64: string[] }`                   | batched engine-side updates (remote sync, other-surface edits) |
| `cfg`             | `{ theme, locale, rtl, reducedMotion, readOnly }`   | readOnly also driven by kill-switch/entitlement state          |
| `wiki-candidates` | `{ reqId, items }`                                  | autocomplete answers                                           |
| `asset`           | `{ reqId, url \| b64, mime }`                       | attachment/image resolution result                             |
| `exec`            | `{ cmd: 'undo'\|'redo'\|'focus'\|'blur'\|'flush' }` |                                                                |

### WebView → RN

| type         | payload                           | notes                                                                     |
| ------------ | --------------------------------- | ------------------------------------------------------------------------- |
| `ready`      | `{ protocolV, schemaV }`          | handshake; RN verifies versions, then `doc-load`                          |
| `y-update`   | `{ docId, updatesB64: string[] }` | batched local edits; RN applies to owned Y.Doc → CrdtPersistence + outbox |
| `wiki-query` | `{ reqId, query }`                | autocomplete request                                                      |
| `asset-req`  | `{ reqId, ref }`                  | resolve image/attachment ref                                              |
| `nav`        | `{ target }`                      | wiki-link tap → RN navigates                                              |
| `metrics`    | `{ h, selAnchor }`                | content height / selection for native chrome                              |
| `err`        | `{ code, detail }`                | surfaced via shared error extractor                                       |

## Ownership & durability rules

1. Only the RN-side Y.Doc is authoritative. The WebView holds a replica for
   editing; it persists **nothing** (no IndexedDB/localStorage document state).
2. Every WebView-originated update is written to `CrdtPersistence`
   (SQLite) **before** it is acked into the outbox pipeline; app kill after
   receipt loses nothing.
3. `sid` origin-tagging prevents update echo loops (same pattern as desktop's
   `sourceWindowId`).
4. On WebView process termination (iOS reclaims it), RN re-creates the view and
   replays `doc-load` from the owned doc — unsynced edits survive because they
   were already on the RN side.
5. Background transition ⇒ `exec:flush` + drain; the WebView is never trusted to
   outlive the transition.

## Performance budget hooks (R4 / G3)

- Frame counters on both sides (`envelopesSent`, `msgsPerEnvelope` histogram)
  exposed in dev builds; G3 evidence includes them — proof of batching, not just
  latency.
- Budget: < 50 ms keystroke-to-visible-character p95 on a 50 KB note on the
  reference mid-tier device. The WebView renders its own keystroke locally, so
  the bridge is off the critical render path by design; the budget therefore
  gates _end-to-end echo_ (keystroke → RN doc → ack) and render stalls caused by
  bridge back-pressure.
- `editor-web` bundle is a self-contained local asset (no network at editor
  open; startup never network-gated).
