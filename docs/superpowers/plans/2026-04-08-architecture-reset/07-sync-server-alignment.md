# Architecture Reset Phase 07 - Sync Server Alignment Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align sync-server transport, contracts, and realtime fanout with the adapter-driven client sync model introduced in Phase 05 while keeping CRDT note sync isolated.

**Architecture:** The current server already has two distinct transports hiding inside one module: record sync in `apps/sync-server/src/services/sync.ts` and note-only CRDT sync in `apps/sync-server/src/services/crdt.ts`, both wired through one oversized `apps/sync-server/src/routes/sync.ts`. This phase preserves the public `/sync/*` URLs, but splits contracts, route ownership, and observability into three explicit lanes: record sync, CRDT sync, and realtime fanout.

**Tech Stack:** TypeScript, Cloudflare Workers, Hono, D1, R2, Durable Objects, Zod contracts, existing desktop sync client

**Roadmap:** `docs/superpowers/plans/2026-04-08-architecture-reset/README.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/contracts/package.json` | Modify | Export the new sync transport contract entrypoints |
| `packages/contracts/src/sync-api.ts` | Modify | Keep shared sync primitives and temporary compatibility re-exports |
| `packages/contracts/src/sync-record.ts` | Create | Own record-sync request/response schemas used by desktop + sync-server |
| `packages/contracts/src/sync-crdt.ts` | Create | Own note-CRDT request/response schemas now defined inline in the route layer |
| `packages/contracts/src/sync-realtime.ts` | Create | Own the shared WebSocket / durable-object message envelope |
| `apps/desktop/src/main/sync/http-client.ts` | Modify | Import record/CRDT response types from the new contract modules without changing URLs |
| `apps/desktop/src/main/sync/websocket.ts` | Modify | Replace the local realtime message schema with the shared contract |
| `apps/desktop/src/main/sync/http-client.test.ts` | Modify | Keep coverage around the typed record + CRDT HTTP responses |
| `apps/desktop/src/main/sync/websocket.test.ts` | Modify | Keep desktop parsing coverage aligned with the shared realtime envelope |
| `apps/sync-server/src/routes/sync.ts` | Modify | Become a thin composition module for auth, `/ws`, `/storage`, record routes, and CRDT routes |
| `apps/sync-server/src/routes/sync-record.ts` | Create | Own `/status`, `/manifest`, `/changes`, `/push`, `/pull`, and `/items/:id` |
| `apps/sync-server/src/routes/sync-crdt.ts` | Create | Own `/crdt/updates`, `/crdt/updates/batch`, `/crdt/snapshot`, and `/crdt/snapshot/:noteId` |
| `apps/sync-server/src/services/sync.ts` | Modify | Stay the record-sync service layer and absorb batch-level push semantics now implemented in the route |
| `apps/sync-server/src/services/crdt.ts` | Modify | Stay note-only CRDT storage/service logic with transport-specific telemetry hooks |
| `apps/sync-server/src/services/sync-telemetry.ts` | Create | Emit structured record/CRDT/realtime logs with domain-aware fields |
| `apps/sync-server/src/durable-objects/user-sync-state.ts` | Modify | Use the shared realtime contract for `changes_available` and `crdt_updated` fanout |
| `apps/sync-server/src/routes/sync.test.ts` | Modify | Cover record routes, CRDT routes, and fanout payload compatibility |
| `apps/sync-server/src/services/sync.test.ts` | Modify | Cover record batch intake, replay/quota rejection, and record retrieval semantics |
| `apps/sync-server/src/services/crdt.test.ts` | Create | Add missing unit coverage for CRDT update/snapshot storage behavior |

## Chunk 1: Shared Transport Contracts

### Task 1: Split sync contracts by transport without breaking current imports

**Files:**
- Modify: `packages/contracts/package.json`
- Modify: `packages/contracts/src/sync-api.ts`
- Create: `packages/contracts/src/sync-record.ts`
- Create: `packages/contracts/src/sync-crdt.ts`
- Create: `packages/contracts/src/sync-realtime.ts`
- Modify: `apps/desktop/src/main/sync/http-client.ts`
- Modify: `apps/desktop/src/main/sync/websocket.ts`
- Modify: `apps/desktop/src/main/sync/http-client.test.ts`
- Modify: `apps/desktop/src/main/sync/websocket.test.ts`

- [ ] **Step 1: Move record-sync request and response schemas into `sync-record.ts`**

Create a record-transport module that owns the schemas and types the client and server already share for the `sync_items` table / cursor flow:
- `PushRequestSchema`
- `PushResponseSchema`
- `PullRequestSchema`
- `PullResponseSchema`
- `SyncItemRefSchema`
- `SyncManifestSchema`
- `ChangesResponseSchema`
- `SyncStatusSchema`

This module should describe the record-sync lane only. Do not mix note-update batch payloads or realtime WebSocket messages into it.

- [ ] **Step 2: Move note-CRDT request and response schemas into `sync-crdt.ts`**

The CRDT transport is currently defined inline inside `apps/sync-server/src/routes/sync.ts`. Replace those route-local schemas with a shared contract module covering:
- note id validation
- update push payloads
- update pull query/response payloads
- batch update pull payloads
- snapshot push payloads
- snapshot pull responses

Keep the current note id restrictions and byte-limit semantics grounded in the existing route logic. This is not a redesign of note ids.

- [ ] **Step 3: Create a shared realtime envelope in `sync-realtime.ts`**

`apps/desktop/src/main/sync/websocket.ts` currently owns a local Zod schema for messages such as:
- `changes_available`
- `crdt_updated`
- `heartbeat`
- `error`
- `linking_request`
- `linking_approved`

Move that message envelope into `packages/contracts` so the desktop WebSocket client and `apps/sync-server/src/durable-objects/user-sync-state.ts` validate and emit the same shape.

- [ ] **Step 4: Turn `sync-api.ts` into the shared primitive layer plus compatibility barrel**

Keep `packages/contracts/src/sync-api.ts` focused on primitives that are genuinely shared across the repo:
- `SYNC_ITEM_TYPES`
- `SYNC_OPERATIONS`
- `VectorClock`
- `FieldClocks`
- `EncryptedItemPayload`
- other low-level sync primitives already imported by DB schema and desktop modules

Then re-export the new record/CRDT/realtime types from here temporarily so existing non-server imports do not all have to migrate in one PR.

- [ ] **Step 5: Switch desktop transport code to the new contract entrypoints**

Update:
- `apps/desktop/src/main/sync/http-client.ts`
- `apps/desktop/src/main/sync/websocket.ts`

Import the new record/CRDT/realtime schemas and response types directly from `@memry/contracts/sync-record`, `@memry/contracts/sync-crdt`, and `@memry/contracts/sync-realtime`.

Do not change any URLs in this step. The point is contract ownership, not client behavior.

- [ ] **Step 6: Verify the contract split before touching the server routes**

Run:

```bash
pnpm --filter @memry/contracts typecheck
pnpm --filter @memry/desktop test -- src/main/sync/http-client.test.ts src/main/sync/websocket.test.ts
pnpm typecheck
```

Expected:
- contracts package typechecks with the new exports
- desktop transport tests still pass against the shared schemas
- repo typecheck sees no broken sync imports

## Chunk 2: Route Ownership By Transport

### Task 2: Split the `/sync` route module into record and CRDT subrouters

**Files:**
- Modify: `apps/sync-server/src/routes/sync.ts`
- Create: `apps/sync-server/src/routes/sync-record.ts`
- Create: `apps/sync-server/src/routes/sync-crdt.ts`
- Modify: `apps/sync-server/src/routes/sync.test.ts`

- [ ] **Step 1: Create `sync-record.ts` for record endpoints**

Move these handlers out of `apps/sync-server/src/routes/sync.ts` into `apps/sync-server/src/routes/sync-record.ts`:
- `GET /status`
- `GET /manifest`
- `GET /changes`
- `POST /push`
- `POST /pull`
- `GET /items/:id`

Keep the current request semantics intact:
- cursor parsing and validation
- page-size validation
- push quota pre-check
- device cursor updates
- `last_sync_at` updates

- [ ] **Step 2: Create `sync-crdt.ts` for note-only CRDT endpoints**

Move these handlers out of `apps/sync-server/src/routes/sync.ts` into `apps/sync-server/src/routes/sync-crdt.ts`:
- `POST /crdt/updates`
- `GET /crdt/updates`
- `POST /crdt/updates/batch`
- `POST /crdt/snapshot`
- `GET /crdt/snapshot/:noteId`

Move the route-local base64 helpers and inline CRDT schemas with them unless Chunk 1 already centralized the schema definitions in `packages/contracts`.

- [ ] **Step 3: Leave `sync.ts` as the shared composition layer**

After the split, `apps/sync-server/src/routes/sync.ts` should only own the pieces that are genuinely shared across transports:
- `authMiddleware`
- `/ws`
- `/storage`
- route composition / mounting
- shared rate-limit wiring where it makes sense

The top-level `app.route('/sync', sync)` call in `apps/sync-server/src/index.ts` should remain stable.

- [ ] **Step 4: Replace route-local schemas with the shared contracts from Chunk 1**

Do not keep two sources of truth.

Use:
- `@memry/contracts/sync-record` in the record route module
- `@memry/contracts/sync-crdt` in the CRDT route module

The route layer should become transport validation + orchestration, not the place where payload semantics are invented.

- [ ] **Step 5: Preserve public URL and status-code compatibility**

This phase is an internal alignment pass. Keep the existing public surface stable for the current desktop client:
- `/sync/changes`
- `/sync/push`
- `/sync/pull`
- `/sync/items/:id`
- `/sync/crdt/updates`
- `/sync/crdt/updates/batch`
- `/sync/crdt/snapshot`
- `/sync/crdt/snapshot/:noteId`
- `/sync/ws`

Also preserve the current error/status behavior that the client already handles:
- `400` validation failures
- `413` body/update limits
- `426` upgrade/version semantics

- [ ] **Step 6: Expand route tests so the split is actually enforced**

Update `apps/sync-server/src/routes/sync.test.ts` to cover:
- record route delegation
- CRDT route delegation
- invalid `noteId` / invalid batch payload handling
- push broadcast using `changes_available`
- CRDT update broadcast using `crdt_updated`

Today the file covers only the record-style routes. Phase 07 should make CRDT route coverage first-class instead of incidental.

### Task 3: Make `apps/sync-server/src/services/sync.ts` explicitly record-sync-only

**Files:**
- Modify: `apps/sync-server/src/services/sync.ts`
- Modify: `apps/sync-server/src/services/sync.test.ts`
- Modify: `apps/sync-server/src/routes/sync-record.ts`

- [ ] **Step 1: Pull record batch orchestration out of the route and into the service layer**

`POST /sync/push` currently performs its own batch loop in the route while `processPushItem()` handles only one item at a time.

Add a batch-level record helper in `apps/sync-server/src/services/sync.ts` that owns:
- iterating the pushed items
- collecting `accepted` ids
- collecting `{ id, reason }` rejects
- computing `maxCursor`
- returning a route-ready summary object

This keeps the route thin and makes record-sync semantics live in one service module.

- [ ] **Step 2: Keep the existing record intake guarantees intact**

Do not lose the protections already present in `apps/sync-server/src/services/sync.ts`:
- encrypted field validation
- signer verification
- replay detection
- content hashing
- quota enforcement
- cursor generation
- tombstone handling
- atomic storage usage updates

Phase 07 is about clarifying ownership, not rewriting the record sync algorithm.

- [ ] **Step 3: Treat `item.type` as the record domain label**

The Phase 05 client model makes record sync adapter-driven across multiple domains:
- `task`
- `project`
- `settings`
- `inbox`
- `filter`
- `journal`
- `tag_definition`
- note metadata records that still travel through `sync_items`

Reflect that in the server service layer. The record service should stay generic over `SyncItemType` instead of growing feature-specific branches.

- [ ] **Step 4: Keep CRDT logic out of the record service**

The only CRDT-related field that should remain visible in record-sync responses is note record metadata such as `stateVector` when it already belongs on a `sync_items` row.

Do not move any of these note-document concerns into `apps/sync-server/src/services/sync.ts`:
- update storage
- snapshot storage
- CRDT sequence numbers
- update pruning

Those stay in `apps/sync-server/src/services/crdt.ts`.

- [ ] **Step 5: Update the service tests around the new record ownership**

Extend `apps/sync-server/src/services/sync.test.ts` so it proves:
- batch push aggregation returns stable `accepted` / `rejected` arrays
- replay rejection still maps to `SYNC_REPLAY_DETECTED`
- quota rejection still maps to `STORAGE_QUOTA_EXCEEDED`
- `getChanges`, `pullItems`, and `getItem` remain record-only retrieval paths

## Chunk 3: Realtime Fanout And Observability

### Task 4: Add domain-aware sync telemetry and type the fanout channel

**Files:**
- Create: `apps/sync-server/src/services/sync-telemetry.ts`
- Modify: `apps/sync-server/src/services/sync.ts`
- Modify: `apps/sync-server/src/services/crdt.ts`
- Modify: `apps/sync-server/src/durable-objects/user-sync-state.ts`
- Modify: `apps/sync-server/src/routes/sync-record.ts`
- Modify: `apps/sync-server/src/routes/sync-crdt.ts`
- Modify: `apps/sync-server/src/routes/sync.test.ts`
- Modify: `apps/desktop/src/main/sync/websocket.test.ts`

- [ ] **Step 1: Create a tiny structured telemetry helper instead of ad-hoc route logging**

Add `apps/sync-server/src/services/sync-telemetry.ts` using `createLogger(...)` from `apps/sync-server/src/lib/logger.ts`.

Normalize fields across record sync, CRDT sync, and realtime fanout:
- `transport`
- `domain`
- `operation`
- `outcome`
- `reason`
- `itemCount`
- `bytes`
- `cursor`
- `noteId`
- `deviceId`

Never log encrypted payloads or blob contents.

- [ ] **Step 2: Emit record-sync acceptance and rejection logs at the service layer**

Log record mutations where the decision is made, not only where the HTTP response is assembled.

Capture at minimum:
- accepted record mutations by `item.type`
- replay rejects
- signature rejects
- quota rejects
- batch totals for `POST /sync/push`

This is the per-domain observability Phase 07 is supposed to add.

- [ ] **Step 3: Emit CRDT update and snapshot volume logs in `services/crdt.ts`**

Add structured logs for:
- pushed update batch size
- pulled update counts
- snapshot writes
- snapshot reads
- prune counts after snapshot compaction

Use `domain: 'note'` for this lane. CRDT sync is note-document sync only.

- [ ] **Step 4: Type durable-object fanout with the shared realtime contract**

Update `apps/sync-server/src/durable-objects/user-sync-state.ts` so `/broadcast` constructs outbound messages through the shared `sync-realtime` schema or a small typed builder built on top of it.

The goal is to stop stringly-typed drift between:
- server fanout
- desktop WebSocket parsing
- route tests

- [ ] **Step 5: Keep record fanout and CRDT fanout distinct**

Record push fanout should remain:
- `type: 'changes_available'`
- payload carrying `cursor` when relevant

CRDT update fanout should remain:
- `type: 'crdt_updated'`
- payload carrying `noteId`

Do not collapse these into one generic “something changed” message. The desktop engine already reacts differently in `apps/desktop/src/main/sync/engine.ts`.

- [ ] **Step 6: Add tests that prove the shared fanout contract is real**

Update tests so they verify:
- the server emits the shared message envelope
- the desktop WebSocket manager still parses it
- record and CRDT notifications cannot silently swap payload shapes

## Chunk 4: Verification

### Task 5: Run the sync-server and client compatibility bar

**Files:**
- Modify: `apps/sync-server/src/routes/sync.test.ts`
- Modify: `apps/sync-server/src/services/sync.test.ts`
- Create: `apps/sync-server/src/services/crdt.test.ts`
- Modify: `apps/desktop/src/main/sync/http-client.test.ts`
- Modify: `apps/desktop/src/main/sync/websocket.test.ts`

- [ ] **Step 1: Run targeted sync-server unit tests**

Run:

```bash
pnpm --filter @memry/sync-server test -- src/routes/sync.test.ts src/services/sync.test.ts src/services/crdt.test.ts
```

Expected:
- record route tests pass
- CRDT route tests pass
- new CRDT service tests pass

- [ ] **Step 2: Run targeted desktop transport tests**

Run:

```bash
pnpm --filter @memry/desktop test -- src/main/sync/http-client.test.ts src/main/sync/websocket.test.ts
```

Expected:
- desktop HTTP client still accepts the record + CRDT response types
- desktop WebSocket parsing still matches server fanout payloads

- [ ] **Step 3: Run cross-workspace type verification**

Run:

```bash
pnpm --filter @memry/contracts typecheck
pnpm typecheck
```

Expected:
- contracts compile cleanly
- desktop + sync-server imports stay aligned after the contract split

- [ ] **Step 4: Run the normal workspace verification bar**

Run:

```bash
pnpm lint
pnpm test
pnpm ipc:check
```

Expected:
- no lint regressions
- sync-server + desktop test suites remain green
- IPC contract generation still matches checked-in output even though this phase should not require IPC shape changes

- [ ] **Step 5: Run one manual two-lane sync smoke check if a harness is available**

Verify one record mutation and one note CRDT update from one device/session to another:
- record mutation should trigger `changes_available` and a normal pull flow
- CRDT note update should trigger `crdt_updated` and note-targeted CRDT fetch/apply flow
- the two notifications should not be interchangeable

If no harness is available in the implementation session, note that explicitly in the PR / execution log instead of skipping silently.

## Exit Criteria

- Shared contracts exist for record sync, CRDT sync, and realtime fanout instead of all transport types living in one mixed file or inline route schemas.
- `apps/sync-server/src/routes/sync.ts` is a thin composition module, with record and CRDT endpoints owned by separate route files.
- `apps/sync-server/src/services/sync.ts` is unambiguously the record-sync service layer, while `apps/sync-server/src/services/crdt.ts` remains note-only.
- Durable-object fanout and desktop WebSocket parsing use the same shared realtime message contract.
- Structured logs distinguish accepted/rejected record mutations, replay/quota rejects, and CRDT update/snapshot traffic by domain.
