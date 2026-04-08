# Architecture Reset Phase 07 - Sync Server Alignment Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the sync server with the new adapter-driven client sync model and add domain-level observability.

**Architecture:** Keep auth, device registration, blob storage, and durable-object fanout, but restructure sync transport around the client adapter model. Record-sync and CRDT traffic should be validated, measured, and reasoned about separately.

**Tech Stack:** Cloudflare Workers, Hono, D1, R2, existing sync routes and services

---

## File Map

- Modify: `apps/sync-server/src/routes/sync.ts`
- Modify: `apps/sync-server/src/services/sync.ts`
- Modify: CRDT service modules under `apps/sync-server/src/services/`
- Modify: durable-object sync fanout modules if the payload shape changes
- Create: shared metrics or logging helpers if needed

## Chunk 1: Transport Separation

### Task 1: Separate record-sync and CRDT transport concerns

**Files:**
- Modify: `apps/sync-server/src/routes/sync.ts`
- Modify: `apps/sync-server/src/services/sync.ts`

- [ ] Step 1: Make record-sync request validation and CRDT request validation clearly separate in route structure and logging.
- [ ] Step 2: Keep current endpoints working during migration if clients roll gradually.
- [ ] Step 3: Align payload semantics with the adapter contract created in Phase 05.

## Chunk 2: Service Simplification

### Task 2: Simplify sync item intake and retrieval paths

**Files:**
- Modify: `apps/sync-server/src/services/sync.ts`
- Modify: related helpers under `apps/sync-server/src/services/`

- [ ] Step 1: Keep item validation, replay detection, quota checks, and storage writes, but organize them around record-sync semantics instead of mixed concerns.
- [ ] Step 2: Factor common item processing helpers out of the route module.
- [ ] Step 3: Ensure CRDT snapshot/update handling remains isolated from generic record items.

## Chunk 3: Metrics And Observability

### Task 3: Add domain-aware sync telemetry

**Files:**
- Modify: sync routes and services as needed
- Create: logging helpers if useful

- [ ] Step 1: Add per-domain metrics or structured logs for:
  - accepted/rejected record mutations
  - replay/conflict rejects
  - quota rejects
  - CRDT snapshot/update volume
  - per-domain latency buckets if practical
- [ ] Step 2: Ensure logs distinguish tasks/inbox/settings/projects/notes traffic.

## Chunk 4: Verification

### Task 4: Validate client/server compatibility

- [ ] Step 1: Run sync-server tests.
- [ ] Step 2: Add cases for record-sync validation, replay detection, and CRDT endpoint separation.
- [ ] Step 3: Run end-to-end or harness-level sync checks if available.

## Exit Criteria

- Record sync and CRDT sync are conceptually and operationally separate on the server.
- Server transport matches the client adapter model.
- Sync observability is available at the per-domain level.

