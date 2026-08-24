# Contract: Sync Protocol Additions (Production Safety + Billing)

**Feature**: 001-mobile-app | **Date**: 2026-08-22

Additive changes to the live sync service. Ship order is structural: everything
in §1–§4 is a **Train Phase 2 deliverable** (shell phase), before any external
tester writes to a real vault (Constitution, Mobile Platform Constraints). §5
ships in Phase 5. Requests from existing desktop clients — which send none of
the new headers — must behave exactly as today.

## 1. Client identification header

Every request from the mobile app carries:

```
x-memry-client: ios/<semver>+<build>        e.g. x-memry-client: ios/1.0.0+42
```

- Grammar: `<platform>/<semver>[+<build>]`, platform ∈ `ios|android|desktop`.
- Desktop adopts the header opportunistically later; **absence of the header is
  valid** and means legacy desktop — full access, unchanged behaviour.
- Malformed header ⇒ treated as absent (log, don't reject) — a parser bug must
  not lock users out.

## 2. Minimum-version write gate

Server consults `client_policies` (data-model.md §3b) on every **write**:

| Condition | Server behaviour |
|---|---|
| No header | Allow (legacy desktop) |
| `platform` row absent or `min_write_version` NULL | Allow |
| client version ≥ floor and `writes_enabled=1` | Allow |
| client version < floor | Reject write: HTTP `426`, code `CLIENT_UPGRADE_REQUIRED` + `minVersion` |
| `writes_enabled=0` (kill switch) | Reject write: HTTP `403`, code `PLATFORM_WRITES_DISABLED` |

**As implemented** (T028): the rejection body keeps the server's existing
envelope rather than the flat shape sketched above, because every shipped client
already reads `error.code`:

```json
{ "error": { "code": "CLIENT_UPGRADE_REQUIRED", "message": "...", "minVersion": "1.2.0" } }
{ "error": { "code": "PLATFORM_WRITES_DISABLED", "message": "..." } }
```

Kill switch is evaluated **before** the version floor: when writes are off for a
platform, `CLIENT_UPGRADE_REQUIRED` would send users chasing an update that
cannot help them. A policy row that cannot be interpreted (absent row, NULL or
unparseable floor) resolves to ALLOW — an unreadable policy table degrades to
today's behaviour, never to a lockout. A pre-release version string
(`1.0.0-beta.1`) is *malformed*, hence treated as absent, hence allowed: it must
never sort as its release and satisfy a floor the release does not.

- **Reads are never gated** by either mechanism — read-only mode keeps working
  (FR-010).
- Client contract on `CLIENT_UPGRADE_REQUIRED` / `PLATFORM_WRITES_DISABLED`:
  enter explicit read-only mode (plain explanation + update path), **park** the
  outbox (preserve queued writes, stop attempts), poll policy on
  foreground/interval, resume automatically when clear.
- Policy is also embedded in an existing lightweight response the client already
  fetches at startup/foreground (e.g. account/status), so the device learns of a
  flipped switch without attempting a write.

## 3. Per-platform write kill switch

`client_policies.writes_enabled = 0` for `ios` drops every iOS device to
read-only with **one config change** — no deploy, no App Store review. Drill is
a G2 gate check: flip in staging, observe the device transition without restart,
verify queued writes preserved, flip back, verify drain.

## 4. Write attribution

Server stamps `client_platform` / `client_version` (from the header;
NULL = legacy) on every item write (data-model.md §3c). Purpose: incident
tracing and targeted rollback of mobile-originated writes (FR-011). No client
behaviour change; no read path depends on it.

**Tables stamped** (T027/T029, fixed against the current D1 schema):
`sync_items`, `crdt_updates`, `crdt_snapshots`. The CRDT pair is included
deliberately — a note's BODY lands there, and that is precisely the payload most
likely to need a targeted mobile rollback. Attribution records the **latest**
writer, not the creator: after a desktop rewrite of a row an iOS device first
created, the row is no longer a mobile-originated value. Only the semver triple
is stored; the `+build` suffix is parsed but never persisted, since build
numbers are not orderable across release branches.

## 5. Apple billing (Phase 5)

### 5a. App Store Server Notifications V2 endpoint

`POST /webhooks/apple` (name final at implementation): receives `signedPayload`
(JWS). Handler must, in order:

1. Verify the JWS x5c chain to Apple's root CAs and the payload signature —
   on the Workers runtime (library/approach per research.md R8; hard requirement,
   no `decode-without-verify` fallback).
2. Enforce `environment` (Sandbox vs Production) separation — sandbox
   notifications must never mutate production entitlements.
3. Map `originalTransactionId → user_id` via `apple_transactions`
   (data-model.md §3a). Unknown id: store-and-hold or reject-and-log per R8
   findings; never guess an account.
4. Upsert Apple subscription state; recompute the effective entitlement row
   (merge rule below).
5. Return 200 only after durable write (Apple retries on failure — handler is
   idempotent by `notificationUUID`).

### 5b. Purchase attach flow (app → server)

After a StoreKit 2 purchase, the app posts its transaction proof
(signed transaction / receipt per R8) to an authenticated endpoint; server
verifies with Apple, creates the `apple_transactions` row bound to the
**authenticated account** (this is what makes later notifications mappable),
recomputes entitlement, returns the fresh entitlement snapshot. Target: sync
entitlement active ≤ 1 min after purchase (SC-009).

### 5c. Entitlement merge + double subscription

- Effective entitlement: `active(paddle) ∪ active(apple)`; when both are
  active the **later expiry governs**; `sync_entitlements.source` records the
  governing platform (`'apple'` joins the existing union).
- Entitlement/status responses gain an additive optional field, e.g.
  `doubleSubscription: { paddleExpiresAt, appleExpiresAt }`, present only when
  both are active. The app must surface this plainly with resolution guidance
  (Memry cannot cancel the Apple side); absence of the field = no change for
  old clients.

## Compatibility invariants (apply to every section above)

- New request headers: optional. New response fields: additive + optional.
  New tables: empty for existing users. New columns: nullable with NULL-safe
  reads. No existing endpoint changes shape or status codes for header-less
  clients.
- Every migration is hand-written SQL against the real D1 ledger (next: 0006),
  verified against production-shaped rows before deploy (deploy via the existing
  GitHub Actions flow).
